# Agent Link

Agent Link is an MCP plugin that lets one AI agent find, read, message, and wait on another — across **Codex** threads, **Claude Code** sessions, and **Claude Desktop** sessions. A Codex thread can message a Claude session and the reverse, through the same set of tools. Every send is logged as a local receipt you can audit later.

- [Requirements](#requirements)
- [Install](#install) · [Claude Code](#claude-code) · [Codex](#codex) · [From a clone](#from-a-clone)
- [Tools](#tools)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Behavior reference](#behavior-reference)
- [Receipts](#receipts)
- [Development](#development)

## Requirements

- **macOS.** Session discovery reads Claude and Codex state from macOS application folders.
- **Node.js 20 or later.** The plugin ships a prebuilt server bundle (`dist/server.mjs`), so running it needs no `npm` and no network access.
- **At least one host:** Claude Code (the `claude` CLI or the Code tab in Claude Desktop), or Codex (the `codex` CLI, or the Codex app bundled in ChatGPT).
- Codex features need a Codex install that can run `codex app-server`. Agent Link starts and stops that server itself.

## Install

Agent Link's GitHub repo is its own plugin marketplace, so installing takes two commands per host. Install it on every host you want to send or receive from.

### Claude Code

```bash
claude plugin marketplace add Brandon-Gottshall/agent-link
```

```bash
claude plugin install agent-link@agent-link
```

Restart Claude Code. Inside a running session you can use `/plugin marketplace add Brandon-Gottshall/agent-link` and `/plugin install agent-link@agent-link` instead.

The plugin installs its own `SessionStart` and `UserPromptSubmit` hooks, so you don't need to edit `settings.json`.

**Optional: live message delivery.** To have incoming messages appear in a running Claude Code session as `<agent-link-message>` events, start Claude Code with Agent Link as a channel:

```bash
claude --channels plugin:agent-link@agent-link
```

Without channels, messages still queue in the mailbox. The hooks flag pending mail, and `read_agent_link_inbox` shows it.

### Codex

```bash
codex plugin marketplace add Brandon-Gottshall/agent-link
```

```bash
codex plugin add codex-agent-link@agent-link
```

Restart Codex. In Codex the plugin is named `codex-agent-link`, a name kept so older approval settings still apply.

**Optional: skip approval prompts.** By default Codex asks before each tool call. To let agents call Agent Link tools without stopping, add this to `~/.codex/config.toml`:

<details>
<summary>Approval settings for <code>~/.codex/config.toml</code></summary>

```toml
[plugins."codex-agent-link@agent-link"]
enabled = true

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.agent_link_health]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.agent_link_mailbox_inspect]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.archive_codex_thread]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.check_coordination_obligations]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.get_codex_sidebar_state]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.get_codex_thread]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.launch_codex_thread]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.launch_project_worker]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.list_agent_link_receipts]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.list_codex_threads]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.list_loaded_codex_threads]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.message_claude_session]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.message_codex_thread]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.message_project_orchestrator]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.read_agent_link_inbox]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.register_dependency_handoff]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.reply_agent_link_message]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.resolve_codex_thread]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.resolve_project_orchestrator]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.return_project_work_result]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.wait_for_claude_session]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.wait_for_codex_thread]
approval_mode = "approve"
```

</details>

### Check that it works

Ask the agent to call `agent_link_health`. It reports the Codex app-server endpoint, whether autostart is on, and the caller context the host passed in. Then try `list_codex_threads` or `list_claude_sessions`.

### Update or remove

| Host | Update | Remove |
| --- | --- | --- |
| Claude Code | `claude plugin marketplace update agent-link`, then `claude plugin update agent-link@agent-link`, then restart | `claude plugin uninstall agent-link@agent-link` |
| Codex | `codex plugin marketplace upgrade agent-link`, then `codex plugin add codex-agent-link@agent-link`, then restart | `codex plugin remove codex-agent-link@agent-link` |

### From a clone

For development, or to pin a local copy:

```bash
git clone https://github.com/Brandon-Gottshall/agent-link.git
```

The clone already contains the built server, so no install step is needed to run it. Run `npm ci` only if you plan to change the code or run the tests.

Then point either host at the folder instead of GitHub: `claude plugin marketplace add ./agent-link` or `codex plugin marketplace add ./agent-link`, followed by the same install command as above. For a single Claude Code session without installing, use `claude --plugin-dir ./agent-link`.

## Tools

### Any host

| Tool | Purpose |
| --- | --- |
| `agent_link_health` | Report the app-server endpoint, autostart state, and caller context. |
| `message_claude_session` | Send a message to a Claude Desktop or Claude Code session by session ID or alias. |
| `reply_agent_link_message` | Reply to an incoming Agent Link message by its message ID. |
| `read_agent_link_inbox` | Show pending messages for this Claude session as a visible tool result. |
| `wait_for_claude_session` | Wait for the next message delivered to a session. |
| `list_agent_link_receipts` | Search receipts by host, target, origin, action, or text. |
| `agent_link_mailbox_inspect` | Read-only view of the mailbox: envelopes, deliveries, and hook state. |

### Codex threads

| Tool | Purpose |
| --- | --- |
| `list_codex_threads` | List threads. Pass `includeSubagents: true` to include spawned subagents. |
| `list_loaded_codex_threads` | List threads loaded in the running app-server, with sidebar membership. Pages with `cursor`; `threadId` checks one thread. |
| `get_codex_thread` | Read one thread's status, turns, and optionally its receipts. |
| `resolve_codex_thread` | Find a thread by title, preview text, automation name, or partial ID. |
| `get_codex_sidebar_state` | Read the Codex Desktop sidebar as the app reports it. |
| `launch_codex_thread` | Create a thread and optionally start a turn in it. |
| `message_codex_thread` | Send a message that starts or steers a turn in a thread. |
| `wait_for_codex_thread` | Wait until a thread's turn finishes. |
| `archive_codex_thread` | Archive a thread. |
| `register_dependency_handoff` | Ask another thread to call back when something you depend on is ready or blocked. |
| `check_coordination_obligations` | Before finishing, check for "when ready"-style dependencies that have no registered callback. |
| `resolve_project_orchestrator` | Find a project's orchestrator thread. |
| `message_project_orchestrator` | Message a project's orchestrator thread. |
| `launch_project_worker` | Start a worker thread for a project. |
| `return_project_work_result` | Send a worker's result back to its orchestrator. |

### Claude sessions

These tools are listed only when Agent Link runs inside Claude Code or Claude Desktop. Codex can still message a Claude session with `message_claude_session`, using a session ID or alias.

| Tool | Purpose |
| --- | --- |
| `list_claude_sessions` | List Claude Desktop and Claude Code sessions. |
| `list_loaded_claude_sessions` | List sessions that are currently open. |
| `get_claude_session` | Read one session's metadata. |
| `resolve_claude_session` | Find a session by alias, title, or partial ID. |

### Results and errors

Every tool returns one JSON object, in the text content and in `structuredContent`, and declares its `outputSchema`:

- Success: `{"ok": true, ...}`, with `warnings` when there is something to note (for example `deprecated_argument` for an old argument name).
- Failure: `{"ok": false, "error": {"code", "message", "details", "hint"}}`, with `isError: true`. Codes: `invalid_arguments`, `unknown_tool`, `not_found`, `ambiguous`, `archived`, `wrong_recipient`, `no_current_session`, `body_too_large`, `permission_denied`, `active_turn_conflict`, `codex_unavailable`, `claude_unavailable`, `upstream_error`, `unsupported`, `state_io_error`, `internal_error`.
- A search that finds nothing is a verdict, not an error: resolve tools report `status`. Waits report `outcome` (`reply`, `turn_completed`, `idle`, `timeout`), and a timeout is `ok: true`.
- Arguments are checked against the schema. Unknown properties and out-of-range numbers fail with `invalid_arguments`; `details.errors` names each field. `null` for an optional argument counts as not set, and a number or boolean sent as an exact string (`"20"`, `"true"`) is read as that value with a `coerced_argument` warning.
- Renamed arguments keep working until 0.6.0 with a warning: `searchTerm` is now `query`, `body` is `message`, `latestMessageId` is `replyToMessageId`, `message_claude_session`'s `to` is `sessionId` (exact) or `query` (fuzzy), and `return_project_work_result`'s `status` is `resultStatus`.

## How it works

### Codex side

- Agent Link talks to Codex through the local **Codex app-server** protocol. If no endpoint is configured, it starts its own app-server on a free localhost port (`codex app-server --listen ws://127.0.0.1:<port>`) and shuts it down on exit.
- If the app-server is unavailable, read-only tools fall back to scanning Codex's JSONL transcripts under `$CODEX_HOME/sessions`. Messaging needs the app-server.
- `launch_codex_thread` names new blank threads so they persist, and returns a `codex://threads/<threadId>` deep link.
- Project tools read a binding file at `<projectRoot>/.codex/project-orchestrator.json` before falling back to a ranked thread search.

### Claude side

Agent Link only reads Claude's own session state. All writes go to a mailbox that Agent Link owns.

- **Session registry (read-only).** Desktop sidecars under `~/Library/Application Support/Claude/local-agent-mode-sessions/`, Code sidecars under `~/Library/Application Support/Claude/claude-code-sessions/`, and transcript metadata under `~/.claude/projects/`.
- **Mailbox.** An append-only JSONL file at `~/.agent-link/mailbox.jsonl` (see [State directory](#state-directory)). Nothing leaves the machine.
- **Receiving in Claude Desktop.** The `SessionStart` and `UserPromptSubmit` hooks add a short "you have mail" note to the session's context. Message bodies appear only when the agent calls `read_agent_link_inbox`, so the user sees the same thing the agent does.
- **Receiving in Claude Code.** When loaded as a channel, Agent Link polls the mailbox and emits `<agent-link-message>` events. The agent answers with `reply_agent_link_message`.
- **Peer-message envelope.** Every message from another agent reaches the receiving model wrapped in one `<agent-link-message>` envelope: the channel event, each message in the `read_agent_link_inbox` result, and the text of every Codex turn Agent Link starts or steers for another agent (`message_codex_thread`, `launch_codex_thread` with a message, and the project-orchestrator and dependency-handoff tools). Tool results that return another agent's reply (`message_claude_session` and `message_codex_thread` with `waitForReply`, `wait_for_claude_session`, and `agent_link_mailbox_inspect` with `includeBodies`) carry it only in the same envelope. The envelope names the validated sender, says whether that identity came from the runtime (`fromVerified`), and carries a fixed notice that the content is not from the user. Bodies are limited to 64 KiB, and markup, control, bidi, and other invisible characters in them are escaped.
- **What `fromVerified` means.** `fromVerified="true"` says the sender id was attested by whoever wrote the local mailbox line: an Agent Link server that took it from the sending session's runtime identity. For a Codex turn or reply, it is the identity the runtime or app-server reported. It is not cryptographic authentication. Any process that can write the user's mailbox file can claim it, so treat it as a provenance hint, not proof.

## Configuration

Everything works with no configuration. These environment variables override defaults.

Every setting has one `AGENT_LINK_*` name. Older names still work as aliases: when both are set, the `AGENT_LINK_*` name wins. Flags accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`. Path settings must be absolute (or start with `~/`); a relative path is rejected with an error naming the variable, because the Claude hook and the MCP server run from different working directories.

### State directory

Agent Link keeps its own files in `~/.agent-link` (directory `0700`, files `0600`):

```
~/.agent-link/
  mailbox.jsonl          Claude mailbox
  receipts.jsonl         receipt log shared by both hosts
  managed-app-servers/   records of app-servers Agent Link started
  logs/agent-link.log    only when debug logging is on
  migration.json         written once, lists the legacy files found
```

`~/.agent-link` is used instead of an XDG path on purpose: apps launched from the Dock don't inherit shell exports, so an `XDG_STATE_HOME` set in a shell profile would give terminal-launched and Dock-launched hosts two different mailboxes.

**Upgrading from 0.4.x and earlier.** Older releases kept the mailbox at `~/.claude/agent-link/mailbox.jsonl` and receipts at `$CODEX_HOME/agent-link-receipts.jsonl`. Unless you set an explicit mailbox or receipt path, reads merge those legacy files with the new ones (deduplicated by id), so pending mail and old receipts stay visible. New messages, delivery marks, and receipts are written only to `~/.agent-link`. The legacy files are never modified, moved, or deleted; remove them yourself once every host runs this version. Orphaned app-servers recorded under `~/.claude/agent-link/managed-app-servers` are still cleaned up.

After upgrading, **restart every Claude and Codex session** so no old plugin copy keeps running. Until then:

- Mail can be delayed. A session still on 0.4.x reads only the legacy mailbox, so it does not see mail the new version writes to `~/.agent-link`.
- Waits in an old session (`wait_for_claude_session`, `waitForReply`) don't see replies written by the new version until that session is upgraded.
- Rolling back to 0.4.x can deliver some messages twice: delivery marks written by the new version live in `~/.agent-link`, which 0.4.x doesn't read.

| Variable | Legacy aliases | Effect |
| --- | --- | --- |
| `AGENT_LINK_STATE_DIR` | | State directory. Default `~/.agent-link`. |
| `AGENT_LINK_MAILBOX_PATH` | | Mailbox file. Default `<state>/mailbox.jsonl`. Setting it turns off the legacy merge. |
| `AGENT_LINK_RECEIPT_LOG` | `CODEX_AGENT_LINK_RECEIPT_LOG`, `CLAUDE_AGENT_LINK_RECEIPT_LOG` | Receipt log. Default `<state>/receipts.jsonl`. Setting it turns off the legacy merge. |
| `AGENT_LINK_MANAGED_DIR` | `CODEX_AGENT_LINK_STATE_DIR` | Managed app-server records. Default `<state>/managed-app-servers`. (The legacy name only ever meant this directory.) |

### Codex

| Variable | Legacy aliases | Effect |
| --- | --- | --- |
| `AGENT_LINK_CODEX_URL` | `CODEX_AGENT_LINK_URL`, `CODEX_APP_SERVER_URL` | Use an existing app-server WebSocket, e.g. `ws://127.0.0.1:41987`. |
| `AGENT_LINK_CODEX_SOCK` | `CODEX_AGENT_LINK_SOCK`, `CODEX_APP_SERVER_SOCK` | Use an existing app-server Unix socket. |
| `AGENT_LINK_CODEX_AUTOSTART=0` | `CODEX_AGENT_LINK_AUTOSTART` | Never start a managed app-server. |
| `AGENT_LINK_CODEX_BIN` | `CODEX_AGENT_LINK_CODEX_BIN`, `CODEX_BIN` | Codex binary to use for the managed app-server. |
| `AGENT_LINK_CODEX_APP_SERVER_BIN` | `CODEX_AGENT_LINK_APP_SERVER_BIN`, `CODEX_APP_SERVER_BIN` | A separate app-server binary, run as `<bin> --listen ...`. |
| `AGENT_LINK_CODEX_TRANSPORT` | `CODEX_AGENT_LINK_APP_SERVER_TRANSPORT` | Managed app-server transport: `unix` (default; `ws-token` on Windows) or `ws-token`. |
| `AGENT_LINK_CODEX_IDLE_MS` | `CODEX_AGENT_LINK_APP_SERVER_IDLE_MS` | Stop an idle managed app-server after this many milliseconds. Default 300000; `0` never stops it. |
| `AGENT_LINK_CODEX_STARTUP_TIMEOUT_MS` | `CODEX_AGENT_LINK_APP_SERVER_STARTUP_MS` | Managed app-server startup timeout. Default 15000. A failed start is remembered for 60 s. |
| `AGENT_LINK_INFER_RECEIPT_ORIGIN=0` | `CODEX_AGENT_LINK_INFER_RECEIPT_ORIGIN` | Don't infer receipt origin from `CODEX_THREAD_ID` and `CODEX_TURN_ID`. |
| `AGENT_LINK_GUI_OPEN_DRY_RUN=1` | `CODEX_AGENT_LINK_GUI_OPEN_DRY_RUN` | Testing: `openInGui` reports the `open` command without running it. |

### Claude and general

| Variable | Effect |
| --- | --- |
| `AGENT_LINK_HOST` | `claude` or `codex`. Each plugin manifest sets it for its own host; without it the host is inferred from `CLAUDE_*` / `CODEX_*` variables. |
| `AGENT_LINK_DISABLE_CHANNEL=1` | Don't push `<agent-link-message>` channel events in Claude Code. |
| `AGENT_LINK_DEBUG=1` | Debug logging to stderr and to `<state>/logs/agent-link.log`. |
| `AGENT_LINK_LOG_LEVEL` | `error`, `warn` (default), `info`, or `debug`. Overrides `AGENT_LINK_DEBUG`. |
| `AGENT_LINK_INSPECT_ALL=1` | Lets `agent_link_mailbox_inspect` use `scope: "all"` (every session's mail). Off by default. |
| `AGENT_LINK_LOG_FILE` | Log file path. Setting it also turns the file on at the current level. |

Agent Link also reads, but never renames, variables its hosts set: `HOME`, `CODEX_HOME`, `CODEX_THREAD_ID`, `CODEX_TURN_ID`, `CLAUDE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, and `CLAUDE_CONFIG_DIR`.

## Behavior reference

What each tool does to real state, and what its results do and don't prove.

### Launching threads

- `launch_codex_thread` creates a real thread. If you pass `message`, it also starts a real turn.
- It doesn't touch the Codex GUI by default. The result still includes the `codex://threads/<threadId>` deep link, so you can hand it to a person.
- `openInGui: true` opens that deep link on macOS with `open -g`. No clicks, keystrokes, or window automation. Codex Desktop currently focuses its window when it handles a deep link, so leave this off when you need a fully quiet launch.
- To route through another tool, such as a GUI broker, pass it the returned deep link. Agent Link doesn't call other routing tools itself.

### Messaging and waiting

- `message_codex_thread` starts or steers a real turn. Read the target first and check its preview, working directory, and status.
- A `resumed+started_turn` result means the app-server accepted the message. It doesn't prove the thread is visible, loaded, selected, or unarchived in the GUI.
- Results separate these facts into `delivery`, `runtimeState`, `archiveState`, `desktopVisibility`, `warnings`, and `wait`.
- `waitForReply: true` adds `wait` (`outcome`, `waitedMs`, `target`, and `turn` with the final response) once the target answers. The 0.4 `replyConfirmation` key is kept beside it until 0.6.0.
- If a turn has finished but the thread still reports `active`, the wait completes with a `stale-top-level-active-status` warning.
- Ephemeral threads may reject reply confirmation. The message still counts as delivered, and `wait.outcome` is `unavailable` with the error. For tests that need the final response, use a non-ephemeral thread with `openInGui: false`.

### Finding threads

- `resolve_codex_thread` searches archived threads by default. It returns ranked candidates with match reasons and a `selection` block explaining the pick.
- App-server search results are merged with local transcript matches, so older threads aren't hidden by pagination. Use `archiveScope: "all"` on list calls for the same effect.

### Loaded threads and the sidebar

- `list_loaded_codex_threads` shows threads loaded at runtime. A thread can be readable, resumable, or messageable without being loaded.
- `sidebarMembership` is `in_sidebar_model`, `background_only`, or `unknown`. It's trustworthy only when `sidebarState.authority` is `rendererSidebarModel`. Otherwise it's `unknown`.
- Loaded subagent threads missing from the sidebar are listed under `subagentRegistry.loadedSubagents`, grouped by parent in `subagentRegistry.byParentThreadId`.
- `get_codex_sidebar_state` reports what Codex Desktop returns, with no guessing. Unsupported hosts show up in `sidebarState.unsupported`.
- Sidebar state needs an app-server that supports `desktop/sidebar/state/read`. A plain `codex app-server` doesn't, so these fields report unsupported unless you point Agent Link at such a server with `AGENT_LINK_CODEX_URL`. Agent Link never discovers Desktop endpoints on its own.

### Archiving

- `archive_codex_thread` archives through the app-server when it can. Otherwise it moves the session file locally, with guards.
- `threadId` is optional when the host supplies the caller's thread, so a thread can archive itself after finishing.
- The local fallback refuses a loaded thread unless you pass `forceLoaded: true`. If loaded state can't be checked, it proceeds unless `useLocalFallback: false`, and the result says the check was skipped.

### Project orchestrators

- Binding files must include `projectRoot`, `projectId`, `orchestratorThreadId`, `role: "project_orchestrator"`, `policyVersion`, `createdAt`, and `lastVerifiedAt`.
- A corrupt binding or an ambiguous fallback match is an error, not a guess.

## Receipts

Launch, message, and archive calls write a receipt by default. Both hosts append to one shared log: `~/.agent-link/receipts.jsonl`. Set `AGENT_LINK_RECEIPT_LOG` to use a different file. Receipts written by 0.4.x and earlier to `$CODEX_HOME/agent-link-receipts.jsonl` are still listed (read-only) until you set an explicit log path.

Each receipt records the action, target, message preview, delivery state, any final response or reply-confirmation error, and evidence. Every receipt also has a top-level `host` and a `target.kind` (`codex_thread` or `claude_session`), so you can filter by host pair.

Pass a `receipt` object to add your own provenance:

```json
{
  "purpose": "WF verification",
  "originThreadId": "019...",
  "originTurnId": "019...",
  "originToolCallId": "call_...",
  "cleanupRecommendation": "archiveable",
  "tags": ["wf", "receipt"]
}
```

Set `receipt.record: false` to skip writing one. Query receipts with `list_agent_link_receipts`, or pass `includeReceipts: true` to `get_codex_thread`.

**Where the origin comes from**, in priority order:

1. Fields you pass in `receipt`.
2. Caller context the host sends with the tool call (`_meta`).
3. `CODEX_THREAD_ID` and `CODEX_TURN_ID` from the environment.
4. `not_supplied`.

`origin.source` says which one was used, and `origin.sources` records it per field. Call `agent_link_health` with `includeCallerContext: true` to see what your host sends.

For archive receipts, trust `evidence.loadedThreadGuard` for whether the thread was active. `target.status` may be read after the move and can say `unknown`.

## Development

```bash
npm ci
```

```bash
npm run smoke
```

The hosts launch the committed bundle `dist/server.mjs`, not `src/server.js`. After changing anything under `src/` or the dependencies, run `npm run build` and commit `dist/server.mjs`. `npm run check:dist` fails when the bundle is out of date.

The full test catalogue, including live and GUI-touching checks, is in [docs/testing.md](docs/testing.md). Version history is in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
