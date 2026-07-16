# pi-rename-pane

Generate session names for pi and rename the current Herdr pane.

## Install

```bash
pi install /Users/john/Project/Github/pi-rename-pane
```

For local development:

```bash
pi install /Users/john/Project/Github/pi-rename-pane
```

## How it works

Run `/rename` to generate a fresh hyphen-separated session name. The extension applies the name to the pi session and, when pi is running inside Herdr, to the current Herdr pane.

When a named session starts or resumes in Herdr, the extension also applies the saved pi session name to the current pane if that pane does not already have a manual Herdr label.

`/rename` builds naming context from the first user message plus up to three latest user messages. It ignores assistant replies, tool output, and attachments. Before sending context to the rename model, it redacts common secrets.

If the rename model is unavailable, `/rename` falls back to a local name from the latest user message.

## Commands

- `/rename`: Generate and apply a session name.
- `/rename status`: Show model and rename status.
- `/rename config`: Choose a rename model.
- `/rename help`: List rename commands.

Manual names are not supported. Use pi's built-in `/name` command when you want an exact name.

## Configuration

Out of the box, `pi-rename` uses this default model: `openai-codex/gpt-5.6-luna`.

Run `/rename config` to choose a different model.

After you choose a model, `pi-rename` uses only that model. Choose `Use default` in `/rename config` to return to the default.

You can also edit `~/.config/pi/extensions/pi-rename.json` manually:

```json
{
  "model": "openai-codex/gpt-5.6-luna"
}
```

## Herdr behavior

The extension uses `HERDR_PANE_ID` to find and rename the current Herdr pane with `herdr pane rename`.

On session startup or resume, it only auto-renames panes that do not already have a manual Herdr pane label. It does not overwrite custom Herdr pane labels during startup.

On quit, the Herdr pane keeps the last session name.

If pi is not running inside Herdr, only the pi session name is updated.

## License

[MIT](LICENSE)
