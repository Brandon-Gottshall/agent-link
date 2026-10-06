---
name: agent-link
description: Use when the user asks to inspect, resolve, message, audit, or coordinate Codex threads or Claude Desktop/Claude Code sessions — across hosts (a Codex thread can message a Claude session and vice versa), including dependency callbacks when work is blocked on another thread, session, agent, workstream, or future readiness.
---

# Agent Link

Use the `agent-link` MCP tools for cross-thread and cross-session coordination. The plugin runs in two hosts: Codex (talking to a local app-server over its JSON-RPC channel) and Claude (reading Desktop/Code sidecars plus Code transcript metadata, sending through a pure-JS JSONL mailbox, surfacing Desktop mail through `UserPromptSubmit` + `read_agent_link_inbox`, and surfacing Code mail through Claude Code Channels when enabled).

## Choose your host

- **In Codex:** use the `*_codex_thread` tools.
- **In Claude Desktop or Claude Code:** use the `*_claude_session` tools. The read-only listing tools (`list_claude_sessions`, `list_loaded_claude_sessions`, `get_claude_session`, `resolve_claude_session`) are exposed only on the Claude host. Use `reply_agent_link_message` when replying to an inbound Agent Link message by message id.
- **Cross-host:** either side can call the other's send tool. A Codex thread can call `message_claude_session`; a Claude session can call `message_codex_thread` when a Codex app-server is reachable via env vars.
- **Host-neutral (work in either):** `agent_link_health`, `list_agent_link_receipts`, `agent_link_mailbox_inspect`, `read_agent_link_inbox`, `wait_for_claude_session`.

## Workflow

1. Use `agent_link_health` to confirm reachability. It reports the detected host, whether the Codex app-server is reachable, whether the Claude registry is readable, whether the mailbox is writable, and counts of loaded sessions and pending messages. Pass `includeCallerContext: true` when debugging whether the current runtime supplies caller context in MCP metadata.
2. List targets. In Codex use `list_codex_threads` for persisted threads (pass `archiveScope: "all"` when the name might belong to an archived automation) and `list_loaded_codex_threads` for runtime-loaded thread IDs when an app-server endpoint is reachable. Use `get_codex_sidebar_state` only for the explicit Desktop sidebar contract; `sidebarMembership` is authoritative only when `sidebarState.authority === "rendererSidebarModel"`. In Claude use `list_claude_sessions` for Desktop and Code sessions; pass `surface: "desktop"` or `surface: "code"` when the product surface matters.
3. Resolve fuzzy queries. Use `resolve_codex_thread` for Codex (title, automation name, preview text, cwd fragment, partial ID) and `resolve_claude_session` for Claude (title, processName, cwd, userSelectedFolders, partial sessionId or cliSessionId). Prefer ranked candidates over guessing.
4. Read before messaging. Use `get_codex_thread` or `get_claude_session` to verify the target is the intended one. Pass `includeReceipts: true` on `get_codex_thread` when you also need provenance for that target.
5. Audit with receipts. Use `list_agent_link_receipts` to find threads or sessions Agent Link created, messaged, or archived. Filter by `targetThreadId`, `originThreadId`, action, search term, and (for cross-host audits) `host` and `targetKind`.
6. Wire dependency callbacks. In Codex, use `register_dependency_handoff` when the current task depends on another thread, agent, project orchestrator, or workstream becoming ready later. For dependency handoffs, start with `agent_link_health` when available, resolve/read the target, then register the handoff. This is mandatory before passive language such as "when ready", "if it ships", "blocked on", or "another thread is building this." Use `check_coordination_obligations` before closing with cross-thread readiness language. In Claude-hosted work, send the same bounded callback request with the available message tool and preserve receipt evidence; if no suitable callback path exists, report `callback not wired: <reason>`.
7. Send. Use `message_codex_thread` or `message_claude_session`. Both accept `waitForReply: true`. Include concise context, the source ID when known, and the action requested. Agent Link records origin from caller-supplied receipt fields first, MCP runtime caller context second, environment fallback third.
8. Wait separately when you sent without `waitForReply`. Use `wait_for_codex_thread` only when the target is running in the reachable Codex app-server. Use `wait_for_claude_session` to block on a Claude reply or a session going idle.
9. Receive (Claude only). Claude Desktop receives queued mail through the `UserPromptSubmit` / `SessionStart` notify hook; the model must call `read_agent_link_inbox` to render message bodies visibly and mark them delivered. Claude Code receives live mail through `claude/channel` events when the plugin is enabled as a Channel; reply with `reply_agent_link_message`. Mail addressed to a session without Channel delivery remains pending in the JSONL mailbox; confirm with `agent_link_mailbox_inspect`.

For Codex thread creation and cleanup, use `launch_codex_thread` and `archive_codex_thread`. Supply `message` to `launch_codex_thread` only when the new thread should start work immediately; otherwise omit it for an empty thread. Supply `name` when a human-recognizable blank thread title matters; otherwise the tool names empty non-ephemeral threads `New thread` so they persist without opening the GUI. Leave `openInGui` false unless the user explicitly wants Codex Desktop routed to the new thread; the result still includes the `codex://threads/<threadId>` link for human handoff. Pass a `receipt` object with `purpose`, `cleanupRecommendation`, and tags; include explicit origin fields when known. `archive_codex_thread` records an `archive_thread` receipt by default and refuses loaded threads unless `forceLoaded: true` is intentionally supplied. There is no `launch_claude_session` or `archive_claude_session`: Claude Desktop owns session creation and `isArchived` state, and Agent Link is read-only against its registry.

## Rules

- Do not guess a thread or session ID. List or read first unless the user gave an exact target ID.
- When `resolve_codex_thread` or `resolve_claude_session` reports `selection.ambiguous: true`, inspect the tied candidates before messaging.
- Discovered dependency equals active coordination obligation. If another thread, session, agent, or workstream owns readiness that affects the current task, wire the callback immediately instead of leaving a caveat.
- Final answers that mention cross-thread or cross-session readiness must say either `callback wired: <receipt/tool result>` or `callback not wired: <blocker>`.
- For Codex messaging, prefer `mode: "auto"`. Use `mode: "steer_active"` only when the target is active and the active turn ID is known or inferable. Do not use `allowParallelTurn: true` unless the user explicitly wants a separate concurrent turn.
- For Claude messaging, no `mode` exists. The notify hook fires between turns; there is no active turn to steer.
- If the Codex tool reports `local-jsonl-fallback`, it can inspect transcript history but cannot directly message threads.
- `launch_codex_thread` does not touch the Codex desktop GUI by default. With `openInGui: false`, treat the returned deep link as data only. To route a person to the thread through another tool, pass it that deep link. With `openInGui: true` on macOS, it routes Codex Desktop with `codex://threads/<threadId>` and no keyboard, mouse, menu, or window automation. Codex Desktop may still focus itself while handling valid deep links, so keep `openInGui` false for strictly quiet launches.
- `thread/start` alone creates an in-memory blank thread. Agent Link names empty non-ephemeral launches immediately to force durable session history; ephemeral blank launches remain disposable and may not be reopenable later.
- Use non-ephemeral disposable threads for WF tests that need `waitForReply` evidence. Ephemeral threads may reject includeTurns-based confirmation.
- Launch, message, and archive operations write local Agent Link receipts by default. Set `receipt.record: false` only for intentionally unlogged checks; otherwise use receipts as the searchable audit trail for why a target exists, was contacted, or was archived.
- For `archive_thread` receipts, use `evidence.loadedThreadGuard` as the primary active-safety evidence. `target.status` may be local JSONL-derived and `unknown` after archive moves; it does not override a checked `loadedThreadGuard.loaded: false`.
- Receipt `origin.source` reports whether origin metadata was `caller_supplied`, inferred from MCP `runtime_context`, inferred from `environment`, `mixed`, or `not_supplied`; `origin.sources` records field-level provenance. The same precedence applies in both hosts.
- Do not archive a loaded Codex thread unless the user explicitly accepts that risk. If `archive_codex_thread` reports that loaded-state could not be checked, say so in the cleanup summary.
- A managed Codex app-server can create, resume, route, and message persisted threads, but it does not prove those threads are visually unarchived, loaded, selected, or present in the Codex Desktop sidebar. Trust `sidebarMembership` only when `sidebarState.authority === "rendererSidebarModel"`; otherwise treat it as `unknown`.
- The Claude Desktop adapter is read-only against the registry. Never edit `~/Library/Application Support/Claude/local-agent-mode-sessions/**/*.json`.
- Claude Desktop receive relies on the model calling `read_agent_link_inbox` after the notify hook prompts it. Claude Code Channel receive marks messages delivered after the channel notification is written. If neither path runs, messages stay pending and visible only via `agent_link_mailbox_inspect`.
- Keep cross-thread and cross-session messages short and explicit. Avoid loops where two agents repeatedly message each other.

## Cross-host considerations

- **Codex → Claude:** call `message_claude_session` from a Codex thread. The JSONL mailbox accepts the insert directly; Claude Code receivers pick it up through Channels when enabled, while Desktop receivers pick it up on the next user prompt via the notify hook.
- **Claude → Codex:** call `message_codex_thread` from a Claude session. Requires a Codex app-server reachable from the Claude host's environment; otherwise the call returns `local-jsonl-fallback` semantics or a connection error.
- **Origin derivation:** `from_session_id` resolves through MCP `_meta` first (`_meta.sessionId`, `_meta.callerSessionId`), then env fallback (`CLAUDE_SESSION_ID` in Claude, the existing Codex env vars in Codex). Caller-supplied receipt fields still win over both.
- **Receipt logging:** both hosts append to one shared log, `$CODEX_HOME/agent-link-receipts.jsonl` (`~/.codex` when `CODEX_HOME` is unset; override with `CODEX_AGENT_LINK_RECEIPT_LOG`). Each receipt records the sender's `host` and the target's `target.kind`, so audit either direction with `list_agent_link_receipts` filtered by `host` and `targetKind`.
