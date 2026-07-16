import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import {
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"

const CONFIG_PATH = path.join(getAgentDir(), "extensions", "pi-rename.json")
const CONFIG_DIR = path.dirname(CONFIG_PATH)

export interface RenameModelPreference {
  readonly provider: string
  readonly id: string
}

export interface RenameModelAuth {
  readonly model: Model<Api>
  readonly apiKey: string
  readonly headers: Record<string, string> | undefined
}

export type RenameModelConfig =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "configured"; readonly model: RenameModelPreference }

export type ResolvedRenameModelAuth =
  | {
      readonly status: "ok"
      readonly auth: RenameModelAuth
      readonly source: "configured" | "default"
    }
  | { readonly status: "invalid-config" }
  | {
      readonly status: "unauthenticated"
      readonly model: RenameModelPreference | undefined
      readonly source: "configured" | "default"
    }

export const DEFAULT_RENAME_MODEL: RenameModelPreference = {
  provider: "openai-codex",
  id: "gpt-5.6-luna",
}

interface RenameConfig extends Record<string, unknown> {
  model?: unknown
}

export function formatModelPreference(config: RenameModelConfig): string {
  if (config.kind === "configured") return formatRenameModelKey(config.model)
  if (config.kind === "invalid") return "invalid"
  return "default"
}

export function formatRenameModelKey({
  provider,
  id,
}: RenameModelPreference): string {
  return `${provider}/${id}`
}

export function formatAuthModelKey(auth: RenameModelAuth): string {
  return `${auth.model.provider}/${auth.model.id}`
}

export function parseModelSpec(
  value: string,
): RenameModelPreference | undefined {
  const trimmed = value.trim()
  const separator = trimmed.indexOf("/")
  if (separator <= 0 || separator === trimmed.length - 1) return undefined

  return {
    provider: trimmed.slice(0, separator),
    id: trimmed.slice(separator + 1),
  }
}

function readConfig(): RenameConfig {
  const content = readFileSync(CONFIG_PATH, "utf-8")
  const config = JSON.parse(content) as unknown
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as RenameConfig)
    : {}
}

export function saveModelPreference(
  modelPreference: RenameModelPreference,
): void {
  const config: RenameConfig = {
    model: formatRenameModelKey(modelPreference),
  }
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8")
}

export function deleteRenameConfig(): void {
  rmSync(CONFIG_PATH, { force: true })
}

export function resolveInitialModelConfig(): RenameModelConfig {
  if (!existsSync(CONFIG_PATH)) return { kind: "missing" }

  try {
    const config = readConfig()
    if (typeof config.model !== "string") return { kind: "invalid" }

    const model = parseModelSpec(config.model)
    return model ? { kind: "configured", model } : { kind: "invalid" }
  } catch {
    return { kind: "invalid" }
  }
}

async function getModelAuth(
  ctx: ExtensionContext,
  modelPreference: RenameModelPreference,
): Promise<RenameModelAuth | undefined> {
  const model = ctx.modelRegistry.find(
    modelPreference.provider,
    modelPreference.id,
  )
  if (!model) return undefined

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  return auth.ok && auth.apiKey
    ? {
        model,
        apiKey: auth.apiKey,
        headers: auth.headers,
      }
    : undefined
}

export async function getRenameModelAuth(
  ctx: ExtensionContext,
  config: RenameModelConfig,
): Promise<ResolvedRenameModelAuth> {
  if (config.kind === "invalid") return { status: "invalid-config" }

  if (config.kind === "configured") {
    const auth = await getModelAuth(ctx, config.model)
    return auth
      ? { status: "ok", auth, source: "configured" }
      : {
          status: "unauthenticated",
          model: config.model,
          source: "configured",
        }
  }

  const defaultAuth = await getModelAuth(ctx, DEFAULT_RENAME_MODEL)
  if (defaultAuth) {
    return { status: "ok", auth: defaultAuth, source: "default" }
  }

  return {
    status: "unauthenticated",
    model: DEFAULT_RENAME_MODEL,
    source: "default",
  }
}

export async function getAuthenticatedTextModelPreferences(
  ctx: ExtensionContext,
): Promise<RenameModelPreference[]> {
  const models = ctx.modelRegistry
    .getAll()
    .filter((model) => model.input.includes("text"))
  const authenticatedModels = await Promise.all(
    models.map(async (model) => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
      return auth.ok && auth.apiKey ? toModelPreference(model) : undefined
    }),
  )

  return authenticatedModels
    .filter((model): model is RenameModelPreference => model !== undefined)
    .toSorted((left, right) =>
      formatRenameModelKey(left).localeCompare(formatRenameModelKey(right)),
    )
}

function toModelPreference(model: Model<Api>): RenameModelPreference {
  return { provider: model.provider, id: model.id }
}
