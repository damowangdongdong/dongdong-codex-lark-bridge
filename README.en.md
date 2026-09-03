# lark-channel-bridge

Bridge Feishu / Lark messages to a locally installed Claude Code or Codex CLI. Send work from DMs, groups, topic groups, or supported cloud-document comments; the local agent reads files, handles attachments, edits code, and streams progress and results back to Feishu.

**The repository homepage is Chinese.** [中文 README](./README.md)

## Quick start

Requirements: Node.js `>= 20.12.0`, a logged-in `claude` or `codex` executable, and a Feishu/Lark PersonalAgent app.

```bash
npm install --global lark-channel-bridge
lark-channel-bridge run
```

The first run shows a QR wizard. Scan it in Feishu, choose or create an app, choose Claude or Codex, and let the bridge write the profile under `~/.lark-channel/`. You may use an existing app with `lark-channel-bridge run --app-id cli_xxx`; add `--tenant lark` for the international tenant.

In Feishu:

```text
/cd /Users/me/project
Review the failing tests and propose a fix.
```

DMs do not need an @ mention. Groups and topic groups require `@bot` by default. Each chat, topic, and cloud-doc comment thread has an isolated session and working directory. Images and files can be attached to a task.

Cloud-doc comments are document-scoped: mention the bot in a supported document comment and the reply stays in that comment thread; no separate workspace binding is needed.

## Feishu commands

Every command has a concrete example and a visible result. Use `/help` in Feishu for the same tutorial in a card.

| Command | Example | Result |
|---|---|---|
| `/help` | `/help` | Opens the tutorial card. |
| `/status` | `/status` | Shows profile, agent, cwd, session, permissions, lark-cli identity, runs, and queue. |
| `/cd` | `/cd ~/work/demo` | Changes cwd, interrupts the current run, and resets the session; Codex shows its launch picker. |
| `/ws list` | `/ws list` | Lists the current cwd and named workspaces. |
| `/ws save` | `/ws save backend` | Saves the current cwd under a name. |
| `/ws use` | `/ws use backend` | Switches to a named workspace; Codex asks for profile and new/resume. |
| `/ws remove` | `/ws remove backend` | Removes the alias without touching files. |
| `/new`, `/clear`, `/reset` | `/new` | Starts a fresh session in the current scope. |
| `/resume` | `/resume 2` | Shows page 2 of compatible history and lets you restore a thread. |
| `/new chat` | `/new chat Release check` | Creates or reuses a Codex project group for the current path and starts a new thread. |
| `/profile` | `/profile` | Selects the Codex CLI profile for a DM or project group. |
| `/attach` | `/attach` | Prints the exact `codex --remote ... resume ...` command for the same thread. |
| `/permissions` | `/permissions workspace-write` | Sets the Codex permission for the current chat/topic; `/permission` is an alias. |
| `/goal` | `/goal Fix login timeout` | Creates or updates a persistent Codex goal; `pause`, `resume`, and `clear` manage it. |
| `/stop` | `/stop` | Interrupts a turn, or stops Codex background terminals when no turn is active. |
| `/stop terminals`, `/clean` | `/stop terminals` | Stops all background terminals for the current Codex thread. |
| `/timeout` | `/timeout 15` | Sets a 15-minute idle watchdog for the current scope; `off` disables and `default` clears the override. |
| `/ps` | `/ps` | Lists Bridge processes for Claude, or Codex background terminals for Codex. |
| `/ps bridge` | `/ps bridge` | Lists local Bridge processes from a Codex chat. |
| `/exit` | `/exit 2` | Stops a Bridge process by ID or list index. |
| `/reconnect` | `/reconnect` | Reconnects the Feishu WebSocket. |
| `/doctor` | `/doctor no group replies` | Runs low-sensitive diagnostics and asks the agent to interpret the symptom. |
| `/account` | `/account` | Shows the current Feishu app. |
| `/account change` | `/account change` | Opens credential replacement, validates them, saves, and reconnects. |
| `/config` | `/config` | Opens preferences, access control, and lark-cli identity settings. |
| `/invite` / `/remove` | `/invite user @Alex` | Adds or removes allowed users, admins, or the current group. `/invite all group` opens every group the bot joined. |
| `/meeting` | `/meeting join 123456789` | With the meeting agent enabled, joins, asks about, summarizes, inspects, stops, or leaves a meeting. |

## Codex coverage

The bridge keeps a Codex 0.152.x-compatible inventory. `/codex commands` prints it in Feishu. App-server examples include `/apps`, `/plugins`, `/hooks`, `/rename name`, `/archive`, `/delete` then `/delete confirm`, `/compact`, `/experimental`, `/memories`, `/skill name instruction`, `/skills`, `/mcp verbose`, `/model`, `/fast`, `/plan`, `/goal objective`, `/personality`, `/clean`, `/fork`, `/review`, `/usage`, `/debug-config`, and `/logout`; each returns the corresponding Codex result. Commands that depend on terminal-local TUI state, such as `/ide`, `/vim`, `/diff`, `/approve`, `/theme`, and `/quit`, return the exact `/attach` instruction instead of claiming to run remotely.

While a turn runs, **↵ Insert now** steers it immediately and **⇥ Queue** waits until it finishes. `/attach` mirrors terminal input, progress, and final answers to Feishu. Codex history is paginated and keeps reasoning, tool input/output, terminal input, and token usage in separate expandable sections.

## Configuration and operations

`/config` controls personal/team mode, model, message reply mode, tool-call visibility, COT messages, concurrency, idle watchdog, group mentions, and lark-cli identity. The default policy is `bot-only`; `user-default` additionally permits an authorized personal identity. Each profile has a **profile-local lark-cli directory** at `~/.lark-channel/profiles/<profile>/lark-cli`; personal authorization is not shared across profiles.

Profile permissions use `permissions.defaultAccess` and `permissions.maxAccess` (`full`, `workspace`, or `read-only`). `workspaces.default` sets a profile's default cwd. The legacy `sandbox` field is read for migration and becomes canonical `permissions` after the profile is saved.

Run a local console with `lark-channel-bridge run --web-ui`, then print its URL with `lark-channel-bridge ui --print`. For background operation use `start`, `status`, `restart`, `stop`, and `unregister`. This is a **per-profile service**: launchd on macOS, systemd on Linux, and Task Scheduler on Windows with a `.cmd` launcher.

Profile operations include `profile create`, `list`, `use`, `remove`, and `export`. `profile remove --purge --yes` permanently deletes state; `profile export --include-secrets --yes` explicitly confirms exporting secrets. The Chinese README contains the full host CLI and path reference.

## Local checks

```bash
pnpm test
pnpm typecheck
pnpm build
```

The bridge sends no telemetry by default. See the [Chinese README](./README.md) for complete configuration paths, access-control examples, meeting details, and troubleshooting.

## License

[MIT](./LICENSE)
