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
- **Node.js 20 or later**, with `npm` on your `PATH`.
- **At least one host:** Claude Code (the `claude` CLI or the Code tab in Claude Desktop), or Codex (the `codex` CLI, or the Codex app bundled in ChatGPT).
- Codex features need a Codex install that can run `codex app-server`. Agent Link starts and stops that server itself.

## Install

Agent Link's GitHub repo is its own plugin marketplace, so installing takes two commands per host. Install it on every host you want to send or receive from.

The first time the MCP server starts, it runs `npm ci --omit=dev` inside the installed plugin folder to fetch its two runtime dependencies. This needs network access once and takes a few seconds.

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

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.message_codex_thread]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.message_project_orchestrator]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.register_dependency_handoff]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.resolve_codex_thread]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.resolve_project_orchestrator]
approval_mode = "approve"

[plugins."codex-agent-link@agent-link".mcp_servers.codex-agent-link.tools.return_project_work_result]
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

```bash
cd agent-link && npm ci
```

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
| `list_loaded_codex_threads` | List threads loaded in the running app-server, with sidebar membership. |
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

| Tool | Purpose |
| --- | --- |
| `list_claude_sessions` | List Claude Desktop and Claude Code sessions. |
| `list_loaded_claude_sessions` | List sessions that are currently open. |
| `get_claude_session` | Read one session's metadata. |
| `resolve_claude_session` | Find a session by alias, title, or partial ID. |

## How it works

### Codex side

- Agent Link talks to Codex through the local **Codex app-server** protocol. If no endpoint is configured, it starts its own app-server on a free localhost port (`codex app-server --listen ws://127.0.0.1:<port>`) and shuts it down on exit.
- If the app-server is unavailable, read-only tools fall back to scanning Codex's JSONL transcripts under `$CODEX_HOME/sessions`. Messaging needs the app-server.
- `launch_codex_thread` names new blank threads so they persist, and returns a `codex://threads/<threadId>` deep link.
- Project tools read a binding file at `<projectRoot>/.codex/project-orchestrator.json` before falling back to a ranked thread search.

### Claude side

Agent Link only reads Claude's own session state. All writes go to a mailbox that Agent Link owns.

- **Session registry (read-only).** Desktop sidecars under `~/Library/Application Support/Claude/local-agent-mode-sessions/`, Code sidecars under `~/Library/Application Support/Claude/claude-code-sessions/`, and transcript metadata under `~/.claude/projects/`.
- **Mailbox.** An append-only JSONL file at `~/.claude/agent-link/mailbox.jsonl`. Nothing leaves the machine.
- **Receiving in Claude Desktop.** The `SessionStart` and `UserPromptSubmit` hooks add a short "you have mail" note to the session's context. Message bodies appear only when the agent calls `read_agent_link_inbox`, so the user sees the same thing the agent does.
- **Receiving in Claude Code.** When loaded as a channel, Agent Link polls the mailbox and emits `<agent-link-message>` events. The agent answers with `reply_agent_link_message`.

## Configuration

Everything works with no configuration. These environment variables override defaults.

**Codex**

| Variable | Effect |
| --- | --- |
| `CODEX_AGENT_LINK_URL` or `CODEX_APP_SERVER_URL` | Use an existing app-server WebSocket, e.g. `ws://127.0.0.1:41987`. |
| `CODEX_AGENT_LINK_SOCK` or `CODEX_APP_SERVER_SOCK` | Use an existing app-server Unix socket. |
| `CODEX_AGENT_LINK_AUTOSTART=0` | Never start a managed app-server. |
| `CODEX_AGENT_LINK_CODEX_BIN` | Codex binary to use for the managed app-server. |
| `CODEX_AGENT_LINK_RECEIPT_LOG` | Receipt log path. Default: `$CODEX_HOME/agent-link-receipts.jsonl`. |
| `CODEX_AGENT_LINK_INFER_RECEIPT_ORIGIN=0` | Don't infer receipt origin from `CODEX_THREAD_ID` and `CODEX_TURN_ID`. |

**Claude**

| Variable | Effect |
| --- | --- |
| `AGENT_LINK_MAILBOX_PATH` | Mailbox path. Default: `~/.claude/agent-link/mailbox.jsonl`. |
| `CLAUDE_AGENT_LINK_RECEIPT_LOG` | Receipt log path. Default: `$CLAUDE_HOME/agent-link-receipts.jsonl`. |
| `AGENT_LINK_MAILBOX_DB` | Deprecated. Legacy SQLite paths are mapped to a `.jsonl` mailbox. |

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
- Results separate these facts into `delivery`, `runtimeState`, `archiveState`, `desktopVisibility`, `warnings`, and `replyConfirmation`.
- `waitForReply: true` adds a `replyConfirmation` once the target answers.
- If a turn has finished but the thread still reports `active`, the wait completes with a `stale-top-level-active-status` warning.
- Ephemeral threads may reject reply confirmation. The message still counts as delivered, and `replyConfirmation` carries the error. For tests that need the final response, use a non-ephemeral thread with `openInGui: false`.

### Finding threads

- `resolve_codex_thread` searches archived threads by default. It returns ranked candidates with match reasons and a `selection` block explaining the pick.
- App-server search results are merged with local transcript matches, so older threads aren't hidden by pagination. Use `archiveScope: "all"` on list calls for the same effect.

### Loaded threads and the sidebar

- `list_loaded_codex_threads` shows threads loaded at runtime. A thread can be readable, resumable, or messageable without being loaded.
- `sidebarMembership` is `in_sidebar_model`, `background_only`, or `unknown`. It's trustworthy only when `sidebarState.authority` is `rendererSidebarModel`. Otherwise it's `unknown`.
- Loaded subagent threads missing from the sidebar are listed under `subagentRegistry.loadedSubagents`, grouped by parent in `subagentRegistry.byParentThreadId`.
- `get_codex_sidebar_state` reports what Codex Desktop returns, with no guessing. Unsupported hosts show up in `sidebarState.unsupported`.
- Sidebar state needs an app-server that supports `desktop/sidebar/state/read`. A plain `codex app-server` doesn't, so these fields report unsupported unless you point Agent Link at such a server with `CODEX_AGENT_LINK_URL`. Agent Link never discovers Desktop endpoints on its own.

### Archiving

- `archive_codex_thread` archives through the app-server when it can. Otherwise it moves the session file locally, with guards.
- `threadId` is optional when the host supplies the caller's thread, so a thread can archive itself after finishing.
- The local fallback refuses a loaded thread unless you pass `forceLoaded: true`. If loaded state can't be checked, it proceeds unless `useLocalFallback: false`, and the result says the check was skipped.

### Project orchestrators

- Binding files must include `projectRoot`, `projectId`, `orchestratorThreadId`, `role: "project_orchestrator"`, `policyVersion`, `createdAt`, and `lastVerifiedAt`.
- A corrupt binding or an ambiguous fallback match is an error, not a guess.

## Receipts

Launch, message, and archive calls write a receipt by default:

- Codex side: `$CODEX_HOME/agent-link-receipts.jsonl`
- Claude side: `$CLAUDE_HOME/agent-link-receipts.jsonl`

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

The full test catalogue, including live and GUI-touching checks, is in [docs/testing.md](docs/testing.md). Version history is in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
