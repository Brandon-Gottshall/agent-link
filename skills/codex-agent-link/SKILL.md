---
name: codex-agent-link
description: Use when the user asks to inspect Codex agents or threads, check whether another Codex thread is loaded/active/idle, read recent thread state, launch a new Codex thread, send a direct follow-up message to another Codex thread, or coordinate a dependency/callback when work is blocked on another thread, agent, workstream, or future readiness.
---

# Codex Agent Link

Use the `codex-agent-link` MCP tools for cross-thread coordination.

## Results and errors

Every tool returns one JSON envelope (also in `structuredContent`):

- Success: `{"ok": true, ...payload}`, plus `warnings: [{code, message, ...}]` when there is something to note.
- Failure: `{"ok": false, "error": {"code", "message", "details", "hint"}}`, and the MCP result has `isError: true`. Branch on `error.code`: `invalid_arguments` (see `details.errors`), `not_found` (`details.candidates`), `ambiguous` (`details.candidates`), `wrong_recipient`, `no_current_session`, `body_too_large` (`details.limitBytes`, `details.actualBytes`), `permission_denied`, `active_turn_conflict`, `codex_unavailable` (follow `hint`), `unsupported`, `upstream_error`, `state_io_error`, `internal_error`.
- Verdicts are not failures. Resolve tools put theirs in `status` (`resolved`, `ambiguous`, `not_found`); `archive_codex_thread` in `status` (`archived`, `already_archived`); `check_coordination_obligations` in `status` (`not_applicable`, `satisfied`, `needs_handoff`, `blocked`).
- Waits put how they ended in `outcome` (`reply`, `turn_completed`, `idle`, `timeout`). A timeout is `ok: true`. Message tools with `waitForReply: true` return the same shape as `wait`.
- Arguments are validated: unknown properties and out-of-range numbers fail with `invalid_arguments` instead of being ignored or clamped.
- A `deprecated_argument` warning means you used an old argument name; switch to the `replacement` it names.

## Workflow

1. Use `agent_link_health` when you need to confirm the plugin can reach a Codex app-server.
2. Use `list_loaded_codex_threads` for runtime-loaded thread IDs when an app-server endpoint is reachable. Its `sidebarMembership` field is only authoritative when `sidebarState.authority === "rendererSidebarModel"`.
3. Use `get_codex_sidebar_state` when you specifically need the Desktop sidebar contract. It fails with `unsupported` when the app-server has no renderer authority; that is meaningful, so do not infer sidebar membership from delivery, route, or loaded-thread evidence.
4. Use `list_codex_threads` to find recent persisted threads; pass `query` to filter by preview, cwd, title, or ID. Use `archiveScope: "all"` when the user-facing name might belong to an archived automation or older thread.
5. Use `get_codex_thread` before messaging so you verify the target thread is the intended one.
6. Use `resolve_codex_thread` for fuzzy lookup by title, automation name, preview text, cwd fragment, or partial ID. It answers with `status` (`resolved`, `ambiguous`, `not_found`) and ranked candidates. Prefer them over guessing.
7. Use `list_agent_link_receipts` when you need provenance for a thread created, messaged, or archived by Agent Link. Search by `targetThreadId`, `originThreadId`, `action`, or `query`; use `get_codex_thread` with `includeReceipts: true` when you are already reading the target thread.
8. Use `resolve_project_orchestrator` for source-owned project coordination. It reads `<projectRoot>/.codex/project-orchestrator.json` first, verifies the bound orchestrator thread when readable, then falls back to ranked thread search. If it reports a corrupt binding or ambiguous top fallback candidates, stop and ask for an explicit `orchestratorThreadId` or a corrected binding.
9. Use `message_project_orchestrator` to contact the resolved project orchestrator without GUI routing. Use `launch_project_worker` to create a non-ephemeral worker by default; it injects return-path instructions naming `return_project_work_result` and keeps `openInGui:false`. Use `return_project_work_result` with `resultStatus` (`done`, `done_with_concerns`, or `blocked`) and `summary` when a worker reports back to the orchestrator.
10. Use `register_dependency_handoff` when the current task depends on another thread, agent, project orchestrator, or workstream becoming ready later. For dependency handoffs, start with `agent_link_health` when available, resolve/read the target, then register the handoff. This is mandatory when you would otherwise write passive language such as "when ready", "if it ships", "blocked on", or "another thread is building this." The tool sends the callback request and records a dependency-handoff receipt.
11. Use `check_coordination_obligations` before closing with cross-thread readiness language. If it returns `needs_handoff`, call `register_dependency_handoff` or explicitly report the blocker as `callback not wired: <reason>`.
12. Use `launch_codex_thread` to create a fresh thread. Supply `message` only when the user asked for the new thread to start work immediately; otherwise omit it to create an empty thread. Supply `name` when a human-recognizable blank thread title matters; otherwise the tool names empty non-ephemeral threads `New thread` so they persist without opening the GUI. Leave `openInGui` false unless the user explicitly wants Codex Desktop routed to the new thread; the result still includes the `codex://threads/<threadId>` link for human handoff. Pass a `receipt` object with `purpose`, `cleanupRecommendation`, and tags; include explicit origin fields when known.
13. Use `message_codex_thread` for direct messages. Include concise context, source thread ID when known, and the action requested. Agent Link records origin from caller-supplied receipt fields first, MCP runtime caller context second, and environment fallback third.
14. Use `archive_codex_thread` for cleanup after successful automation/reporting work. It answers `status: "archived"` or `"already_archived"`. The tool records an `archive_thread` receipt by default, defaults to caller thread context when supplied, prefers app-server `thread/archive`, and only uses guarded local fallback when needed.
15. Use `wait_for_codex_thread` only when the user needs a completion/status check and the target is running in the reachable app-server. Prefer `message_codex_thread` with `waitForReply: true` when sending and confirming in one step; the result is in `wait` (`outcome: "turn_completed"` with `wait.turn.finalResponse`, or `"timeout"`).

## Rules

- Do not guess a thread ID. List or read threads first unless the user gave an exact target ID.
- When `resolve_codex_thread` reports `status: "ambiguous"`, inspect the tied candidates before messaging.
- Project orchestrator bindings are source-owned and must contain `projectRoot`, `projectId`, `orchestratorThreadId`, `role: "project_orchestrator"`, `policyVersion`, `createdAt`, and `lastVerifiedAt`. Do not ignore a corrupt binding; fix it or require an explicit orchestrator thread ID.
- `message_project_orchestrator`, `launch_project_worker`, and `return_project_work_result` reuse existing message/launch receipt actions. Do not invent new receipt action names for project coordination.
- Discovered dependency equals active coordination obligation. If another thread owns readiness that affects the current task, wire the callback immediately instead of leaving a caveat.
- Final answers that mention cross-thread readiness must say either `callback wired: <receipt/tool result>` or `callback not wired: <blocker>`.
- Prefer `mode: "auto"` for messaging. Use `mode: "steer_active"` only when the target is active and the active turn ID is known or inferable. Do not use `allowParallelTurn: true` unless the user explicitly wants a separate concurrent turn; without it, a busy target fails with `active_turn_conflict`. Passing a `cwd`, `model`, or `effort` that differs from the thread's own fails with `permission_denied` unless `allowTargetOverride: true` is intended.
- If the tool reports `local-jsonl-fallback`, it can inspect transcript history but cannot directly message threads.
- `launch_codex_thread` does not touch the Codex desktop GUI by default. With `openInGui: false`, treat the returned deep link as data only. To route a person to the thread through another tool, pass it that deep link. When `openInGui: true` is supplied on macOS, it routes Codex Desktop with `codex://threads/<threadId>` and no keyboard, mouse, menu, or window automation. Codex Desktop may still focus itself while handling valid deep links, so keep `openInGui` false for strictly quiet launches.
- `thread/start` alone creates an in-memory blank thread. Agent Link names empty non-ephemeral launches immediately to force durable session history; ephemeral blank launches remain disposable and may not be reopenable later.
- Use non-ephemeral disposable threads for WF tests that need `waitForReply` evidence. Ephemeral threads may reject includeTurns-based confirmation.
- Launch/message/archive operations write local Agent Link receipts by default. Set `receipt.record: false` only for intentionally unlogged checks; otherwise use receipts as the searchable audit trail for why a target thread exists, was contacted, or was archived.
- For `archive_thread` receipts, use `evidence.loadedThreadGuard` as the primary active-safety evidence. `target.status` may be local JSONL-derived and `unknown` after archive moves; it does not override a checked `loadedThreadGuard.loaded:false`.
- Receipt `origin.source` reports whether origin metadata was `caller_supplied`, inferred from MCP `runtime_context`, inferred from `environment`, `mixed`, or `not_supplied`; `origin.sources` records field-level provenance.
- Use `agent_link_health` with `includeCallerContext: true` when debugging whether the current Codex runtime is supplying caller context in MCP metadata.
- Do not use local fallback to archive a loaded thread unless the user explicitly accepts that risk. Native app-server archive is the preferred path for current-thread cleanup. If `archive_codex_thread` reports that loaded-state could not be checked, say so in the cleanup summary.
- A managed app-server can create, resume, route, and message persisted threads, but it does not prove those threads are visually unarchived, loaded, selected, or present in the Codex Desktop sidebar. Trust `sidebarMembership` only when `sidebarState.authority === "rendererSidebarModel"`; otherwise treat it as `unknown`.
- Keep cross-thread messages short and explicit. Avoid creating loops where two agents repeatedly message each other.
