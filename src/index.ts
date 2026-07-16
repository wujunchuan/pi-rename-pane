import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AutocompleteItem } from "@earendil-works/pi-tui"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { buildSessionContext } from "@earendil-works/pi-coding-agent"
import { pickRenameModel } from "./model-picker.js"
import {
  deleteRenameConfig,
  formatAuthModelKey,
  formatModelPreference,
  formatRenameModelKey,
  getAuthenticatedTextModelPreferences,
  getRenameModelAuth,
  resolveInitialModelConfig,
  saveModelPreference,
  type RenameModelConfig,
} from "./models.js"
import { generateRename, getUserMessageContext } from "./naming.js"

const execFileAsync = promisify(execFile)
interface SessionContextReader {
  buildSessionContext(): { messages: AgentMessage[] }
}

interface RenameState {
  modelConfig: RenameModelConfig
  autoRenameCompleted: boolean
  autoRenameInFlight: boolean
  manualNameLocked: boolean
  pendingExtensionSessionName?: string
  lastExtensionSessionName?: string
}

const RENAME_SUBCOMMANDS: AutocompleteItem[] = [
  {
    value: "status",
    label: "status",
    description: "Show model and rename status",
  },
  {
    value: "config",
    label: "config",
    description: "Choose the rename model",
  },
  {
    value: "help",
    label: "help",
    description: "List rename commands",
  },
]

function createRenameState(): RenameState {
  return {
    modelConfig: { kind: "missing" },
    autoRenameCompleted: false,
    autoRenameInFlight: false,
    manualNameLocked: false,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

interface HerdrPaneInfo {
  readonly id: string
  readonly label?: string
}

function getCurrentHerdrPaneId(): string | undefined {
  const paneId = process.env["HERDR_PANE_ID"]?.trim()
  return paneId || undefined
}

function extractPaneInfo(stdout: string): HerdrPaneInfo | undefined {
  const parsed = asRecord(JSON.parse(stdout) as unknown)
  const result = asRecord(parsed?.["result"])
  const pane = asRecord(result?.["pane"])
  const paneId = pane?.["pane_id"]

  if (typeof paneId !== "string" || !paneId.trim()) return undefined

  const label = pane?.["label"] ?? pane?.["pane_label"] ?? pane?.["manual_label"]

  return {
    id: paneId,
    ...(typeof label === "string" ? { label } : {}),
  }
}

async function getCurrentHerdrPaneInfo(): Promise<HerdrPaneInfo | undefined> {
  const paneId = getCurrentHerdrPaneId()
  if (!paneId) return undefined

  const { stdout } = await execFileAsync("herdr", ["pane", "get", paneId])
  return extractPaneInfo(stdout)
}

async function renameCurrentHerdrPane(name: string): Promise<boolean> {
  const paneId = getCurrentHerdrPaneId()
  if (!paneId) return false

  await execFileAsync("herdr", ["pane", "rename", paneId, name])
  return true
}

async function renameCurrentHerdrPaneIfDefault(name: string): Promise<boolean> {
  const pane = await getCurrentHerdrPaneInfo()
  if (!pane || pane.label?.trim() === name || pane.label?.trim()) {
    return false
  }

  await execFileAsync("herdr", ["pane", "rename", pane.id, name])
  return true
}

function hasSessionContextReader(
  value: unknown,
): value is SessionContextReader {
  return (
    typeof value === "object" &&
    value !== null &&
    "buildSessionContext" in value &&
    typeof value.buildSessionContext === "function"
  )
}

function getCurrentSessionMessages(ctx: ExtensionContext): AgentMessage[] {
  if (hasSessionContextReader(ctx.sessionManager)) {
    return ctx.sessionManager.buildSessionContext().messages
  }

  return buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  ).messages
}

type HerdrRenameMode = "always" | "if-default"

function resetSessionRenameState(
  state: RenameState,
  existingSessionName: string | undefined,
): void {
  state.autoRenameCompleted = Boolean(existingSessionName?.trim())
  state.autoRenameInFlight = false
  state.manualNameLocked = false
  state.pendingExtensionSessionName = undefined
  state.lastExtensionSessionName = undefined
}

function markExtensionSessionNameChange(
  state: RenameState,
  name: string,
): void {
  state.autoRenameCompleted = true
  state.pendingExtensionSessionName = name
  state.lastExtensionSessionName = name
}

function recordSessionNameChange(
  state: RenameState,
  name: string | undefined,
): void {
  const normalizedName = name?.trim() || undefined

  if (state.pendingExtensionSessionName !== undefined) {
    const pendingName = state.pendingExtensionSessionName
    state.pendingExtensionSessionName = undefined
    if (normalizedName === pendingName) return
  }

  if (normalizedName === state.lastExtensionSessionName) return

  state.manualNameLocked = true
  state.autoRenameCompleted = true
}

async function applyRename(
  pi: ExtensionAPI,
  state: RenameState,
  name: string,
  herdrMode: HerdrRenameMode = "always",
): Promise<boolean> {
  markExtensionSessionNameChange(state, name)
  pi.setSessionName(name)
  return herdrMode === "if-default"
    ? renameCurrentHerdrPaneIfDefault(name)
    : renameCurrentHerdrPane(name)
}

async function runRenameCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RenameState,
): Promise<void> {
  const context = getUserMessageContext(getCurrentSessionMessages(ctx))
  if (!context) {
    ctx.ui.notify("No conversation to rename yet.", "warning")
    return
  }

  const result = await generateRename(ctx, state.modelConfig, context)
  if (!result) {
    ctx.ui.notify("Could not generate a session name.", "error")
    return
  }

  let renamedHerdr = false
  let herdrError: string | undefined

  try {
    renamedHerdr = await applyRename(pi, state, result.name)
  } catch (error) {
    herdrError = error instanceof Error ? error.message : String(error)
  }

  if (result.source === "fallback") {
    ctx.ui.notify(
      [
        `Session renamed with fallback: ${result.name}`,
        `Could not use rename model: ${result.reason}`,
        ...(herdrError ? [`Herdr pane rename failed: ${herdrError}`] : []),
      ].join("\n"),
      "warning",
    )
    return
  }

  if (herdrError) {
    ctx.ui.notify(
      `Session renamed, but Herdr pane rename failed: ${herdrError}`,
      "warning",
    )
    return
  }

  ctx.ui.notify(
    renamedHerdr
      ? `Session and Herdr pane renamed: ${result.name}`
      : `Session renamed: ${result.name}`,
    "info",
  )
}

function getRenameArgumentCompletions(
  prefix: string,
): AutocompleteItem[] | null {
  const query = prefix.trimStart().toLowerCase()
  const items = RENAME_SUBCOMMANDS.filter((item) =>
    item.value.startsWith(query),
  )
  return items.length > 0 ? items : null
}

async function configureRenameModel(
  ctx: ExtensionContext,
  state: RenameState,
): Promise<void> {
  const models = await getAuthenticatedTextModelPreferences(ctx)
  if (models.length === 0) {
    ctx.ui.notify(
      "No authenticated models available. Run /login or configure a model first.",
      "error",
    )
    return
  }

  const result = await pickRenameModel(ctx, models)
  if (result.action === "cancel") return

  try {
    if (result.action === "default") {
      deleteRenameConfig()
      state.modelConfig = { kind: "missing" }
      ctx.ui.notify("Rename model reset to default.", "info")
      return
    }

    saveModelPreference(result.model)
    state.modelConfig = { kind: "configured", model: result.model }
    ctx.ui.notify(
      `Rename model set to ${formatRenameModelKey(result.model)}.`,
      "info",
    )
  } catch (error) {
    const reason =
      error instanceof SyntaxError ? "invalid JSON" : "write failed"
    ctx.ui.notify(`Could not update rename config: ${reason}.`, "error")
  }
}

async function notifyRenameStatus(
  ctx: ExtensionContext,
  state: RenameState,
): Promise<void> {
  let selectedModelLine = `selected model: ${formatModelPreference(state.modelConfig)}`
  let activeModelLine: string

  try {
    const modelAuth = await getRenameModelAuth(ctx, state.modelConfig)
    if (modelAuth.status === "ok") {
      const suffix = modelAuth.source === "default" ? " (default)" : ""
      selectedModelLine = `selected model: ${formatAuthModelKey(modelAuth.auth)}${suffix}`
      activeModelLine = `active model: ${formatAuthModelKey(modelAuth.auth)}`
    } else if (modelAuth.status === "invalid-config") {
      activeModelLine = "active model: none (invalid config)"
    } else {
      activeModelLine = "active model: none"
    }
  } catch {
    activeModelLine = "active model: unknown (auth check failed)"
  }

  const context = getUserMessageContext(getCurrentSessionMessages(ctx))
  const herdrLine = `herdr pane: ${getCurrentHerdrPaneId() ? "available" : "unavailable"}`
  const contextLine = `context: ${context?.count ?? 0} user messages`
  const autoRenameLine = state.manualNameLocked
    ? "auto rename: skipped (manual /name detected)"
    : state.autoRenameInFlight
      ? "auto rename: running"
      : state.autoRenameCompleted
        ? "auto rename: done"
        : "auto rename: pending first response"

  ctx.ui.notify(
    [
      "pi-rename status",
      selectedModelLine,
      activeModelLine,
      herdrLine,
      contextLine,
      autoRenameLine,
    ].join("\n"),
    "info",
  )
}

async function runAutoRenameOnce(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RenameState,
): Promise<void> {
  if (
    state.autoRenameCompleted ||
    state.autoRenameInFlight ||
    state.manualNameLocked
  ) {
    return
  }

  if (pi.getSessionName()?.trim()) {
    state.autoRenameCompleted = true
    return
  }

  const context = getUserMessageContext(getCurrentSessionMessages(ctx))
  if (!context) return

  state.autoRenameCompleted = true
  state.autoRenameInFlight = true

  try {
    const result = await generateRename(ctx, state.modelConfig, context)
    if (!result) return

    if (state.manualNameLocked || pi.getSessionName()?.trim()) return

    let renamedHerdr = false
    let herdrError: string | undefined

    try {
      renamedHerdr = await applyRename(pi, state, result.name, "if-default")
    } catch (error) {
      herdrError = error instanceof Error ? error.message : String(error)
    }

    if (result.source === "fallback") {
      ctx.ui.notify(
        [
          `Session auto-renamed with fallback: ${result.name}`,
          `Could not use rename model: ${result.reason}`,
          ...(herdrError ? [`Herdr pane rename failed: ${herdrError}`] : []),
        ].join("\n"),
        "warning",
      )
      return
    }

    if (herdrError) {
      ctx.ui.notify(
        `Session auto-renamed, but Herdr pane rename failed: ${herdrError}`,
        "warning",
      )
      return
    }

    ctx.ui.notify(
      renamedHerdr
        ? `Session and Herdr pane auto-renamed: ${result.name}`
        : `Session auto-renamed: ${result.name}`,
      "info",
    )
  } finally {
    state.autoRenameInFlight = false
  }
}

function registerRenameCommand(pi: ExtensionAPI, state: RenameState): void {
  pi.registerCommand("rename", {
    description: "generate a session name",
    getArgumentCompletions: getRenameArgumentCompletions,
    handler: async (args, ctx) => {
      const action = args.trim().split(/\s+/u)[0]?.toLowerCase() ?? ""

      if (!action) {
        await runRenameCommand(pi, ctx, state)
        return
      }

      if (action === "help") {
        ctx.ui.notify(
          [
            "pi-rename commands",
            "/rename - generate and apply a session name",
            "/rename status - show model and rename status",
            "/rename config - choose the rename model",
            "/rename help - show this help",
          ].join("\n"),
          "info",
        )
        return
      }

      if (action === "status") {
        await notifyRenameStatus(ctx, state)
        return
      }

      if (action === "config") {
        await configureRenameModel(ctx, state)
        return
      }

      ctx.ui.notify("Use /rename [config|help|status]", "error")
    },
  })
}

export default function (pi: ExtensionAPI): void {
  const state = createRenameState()

  registerRenameCommand(pi, state)

  pi.on("session_info_changed", (event) => {
    recordSessionNameChange(state, event.name)
  })

  pi.on("agent_settled", async (_event, ctx) => {
    await runAutoRenameOnce(pi, ctx, state)
  })

  pi.on("session_start", async () => {
    state.modelConfig = resolveInitialModelConfig()

    const sessionName = pi.getSessionName()?.trim()
    resetSessionRenameState(state, sessionName)
    if (!sessionName) return

    try {
      await renameCurrentHerdrPaneIfDefault(sessionName)
    } catch {
      // Keep session startup quiet if Herdr is unavailable or rejects the rename.
    }
  })
}
