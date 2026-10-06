# Testing Agent Link

Run these from a clone after `npm ci`. Protocol smoke tests are necessary but not sufficient: a change to a user-facing flow also needs a live run where a fresh agent discovers and uses the tools.

## Quick checks

| Command | What it covers |
| --- | --- |
| `npm run check:dist` | The committed bundle `dist/server.mjs` matches a fresh `npm run build`. |
| `npm run smoke` | The bundled MCP server (`dist/server.mjs`) starts, reports the package version, and exposes the expected tools per host. |
| `npm run test:claude` | Every Claude-side unit test in one run. |
| `npm run test:codex-lifecycle` | Codex binary discovery and app-server process lifecycle. |
| `npm run test:feedback` | Shared helpers: archive scope, fuzzy IDs, sidebar classification, reply extraction, receipts, caller context, origin inference. |

## Codex

| Command | What it covers |
| --- | --- |
| `npm run smoke:sidebar-state` | Mocked contract test for `get_codex_sidebar_state` and `list_loaded_codex_threads.sidebarMembership`. |
| `npm run test:project-orchestrator` | Binding resolution, worker launch defaults, and the worker-result return path. |
| `npm run test:dependency-handoff` | Dependency-language detection, callback registration, receipt satisfaction, and the no-dependency case. |
| `npm run wf:agent-link` | WF suite, required tools, and fixture verdict logic, without launching live threads. |
| `npm run smoke:app-server` | Read access through a managed Codex app-server. |
| `npm run smoke:launch-thread` | `launch_codex_thread` creates an ephemeral thread without touching the GUI and returns the deep link as data. |
| `npm run smoke:launch-thread-persistence` | A blank non-ephemeral thread is named, persisted, and readable from a fresh app-server. |
| `npm run smoke:launch-thread-gui` | The GUI path builds the `codex://threads/<threadId>` link in dry-run mode. |
| `npm run check:approval-config` | Codex approval settings let the model call every tool. Scripted calls can pass while model-selected calls are still blocked. Set `CODEX_AGENT_LINK_PLUGIN_ID` if you installed from a different marketplace. |

These need extra setup or touch live apps:

| Command | Notes |
| --- | --- |
| `CODEX_AGENT_LINK_SMOKE_OPEN_GUI=1 npm run smoke:launch-thread` | Real macOS deep-link route. May focus Codex Desktop. |
| `CODEX_AGENT_LINK_WF_LIVE=1 npm run wf:agent-link:live` | Launches disposable Codex threads against this checkout, checks tool choice from transcripts and receipts, writes reports under `wf-runs/`, then archives the threads. |
| `CODEX_AGENT_LINK_WF_LIVE=1 AGENT_LINK_INSTALLED_PLUGIN_ROOT=<path> npm run wf:agent-link:installed-live` | Same live suite against an installed plugin cache directory. |

## Claude

| Command | What it covers |
| --- | --- |
| `npm run test:host-detect` | Host detection (`codex` or `claude`) used to route receipts. |
| `npm run test:desktop-registry` | Session sidecar parsing. |
| `npm run test:session-resolver` | Alias, partial-ID, and title resolution. |
| `npm run test:claude-mailbox` | Mailbox envelopes, delivery, ack, and legacy path mapping. |
| `npm run test:claude-session-index` | Desktop and Code session normalization. |
| `npm run test:claude-channel` | Claude Code Channel rendering and delivery marking. |
| `npm run test:claude-reply` | Reply by message ID. |
| `npm run test:send` | `message_claude_session` end to end, including cross-host receipts. |
| `npm run test:notify-hook` | `UserPromptSubmit` and `SessionStart` hook output. |
| `npm run test:read-inbox` | `read_agent_link_inbox` rendering. |
| `npm run test:wait` | `wait_for_claude_session` polling and timeouts. |
| `npm run test:cross-host-receipt` | Receipts carry `host` and `target.kind`. |
| `npm run test:runtime-context` | Caller context flows into receipts. |

## Live agent check

A real low-context test should confirm that a separate messenger thread can discover Agent Link, call `get_codex_thread` or `get_claude_session`, call `message_codex_thread` or `message_claude_session`, and that the target receives the message. The Claude-receive checklist lives in [`scripts/claude-receive-wf-test.md`](../scripts/claude-receive-wf-test.md).
