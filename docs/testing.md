# Testing Agent Link

Run these from a clone after `npm ci`. Protocol smoke tests are necessary but not sufficient: a change to a user-facing flow also needs a live run where a fresh agent discovers and uses the tools.

## Offline suite

`npm test` runs every offline test with `node --test`, in parallel. Nothing in it launches Codex.app, a real Codex app-server, or a GUI; the app-server tests use the stub in `tests/fixtures/stub-codex-app-server.js`. CI runs the same suite on macOS with Node 20 and 22 (`.github/workflows/test.yml`).

| Command | What it covers |
| --- | --- |
| `npm test` | Everything below, in one `node --test` run. |
| `npm run test:claude` | Claude side: mailbox, session index and resolver, Desktop sidecars, send, reply, read-inbox, wait, notify hook, Code channel bridge, plus shared host detection, runtime context, and cross-host receipts (`tests/claude`, `tests/shared`). |
| `npm run test:codex` | Codex side: binary discovery, app-server lifecycle, idle churn and shutdown, chat-style close (`tests/codex`), plus the feedback, sidebar-state, project-orchestrator, dependency-handoff, and archive-EXDEV regressions in `scripts/`. |
| `npm run smoke` | The bundled MCP server (`dist/server.mjs`) starts, reports the package version, and exposes the expected tools per host. Also part of `npm test`. |
| `npm run check:dist` | The committed bundle `dist/server.mjs` matches a fresh `npm run build`. |
| `npm run check:approval-config` | Codex approval settings let the model call every tool. Scripted calls can pass while model-selected calls are still blocked. Set `CODEX_AGENT_LINK_PLUGIN_ID` if you installed from a different marketplace. Reads your real Codex config, so it is not part of `npm test`. |
| `npm run wf:agent-link` | WF suite, required tools, and fixture verdict logic, without launching live threads. Writes a report under `wf-runs/`. |
| `npm run measure:idle-churn` | Idle CPU and app-server churn of one server over 120 s, as JSON, against the stub app-server. `scripts/idle-churn-measure.js` also takes `--idle-seconds`, `--plugin-root`, `--real-home`, and `--shutdown`. |

To run one file, call `node --test <file>` (or plain `node <file>`). Pass `node --test` flags through the runner after `--`, for example `npm test -- --test-concurrency=1`.

The file list lives in `scripts/run-offline-tests.js`, because Node 20's `--test` takes no globs. Add new offline test files to a group there; the runner warns about any file that matches `node --test`'s default name patterns but is not listed.

### Writing tests

- Spawn the server with `hermeticEnv()` from `tests/helpers/env.js`. It strips inherited `CODEX_*`, `CLAUDE_*`, and `AGENT_LINK_*` variables, points `HOME` at a temp directory, and puts the running Node first on `PATH`. Pass `home`, `codexHome`, or `overrides` as needed.
- `tests/helpers/codex-stub.js` has the stub path, spawn-log reader, `taggedStub()`/`taggedProcesses()` for finding every app-server a run started, and `waitFor()`/`waitForExit()`. Wait on events (a response id, a spawn-log line, process exit), not fixed sleeps.
- Do not name helpers `test-*.js`, `*-test.js`, `*.test.js`, or put them in a `test/` directory: `node --test` would run them as tests.

## Live checks

These launch real Codex threads or app-servers, focus the GUI, or touch the real `~/.claude` and `~/.codex`. Each one refuses to run unless `AGENT_LINK_LIVE=1` is set, and their file names (`scripts/*.live.js`) keep them out of `node --test` discovery.

| Command | What it covers |
| --- | --- |
| `AGENT_LINK_LIVE=1 npm run test:live:app-server` | Read access through a managed Codex app-server. |
| `AGENT_LINK_LIVE=1 npm run test:live:launch-thread` | `launch_codex_thread` creates an ephemeral thread without touching the GUI and returns the deep link as data. |
| `AGENT_LINK_LIVE=1 npm run test:live:launch-thread-persistence` | A blank non-ephemeral thread is named, persisted, and readable from a fresh app-server. |
| `AGENT_LINK_LIVE=1 npm run test:live:launch-thread-gui` | The GUI path builds the `codex://threads/<threadId>` link in dry-run mode. |
| `AGENT_LINK_LIVE=1 CODEX_AGENT_LINK_SMOKE_OPEN_GUI=1 npm run test:live:launch-thread` | Real macOS deep-link route. May focus Codex Desktop. |
| `AGENT_LINK_LIVE=1 npm run test:live:claude-receive -- <local_uuid>` | Inserts one test message into the real mailbox for the Claude-receive WF checklist. With no argument it lists candidate sessions. |
| `AGENT_LINK_LIVE=1 npm run wf:agent-link:live` | Launches disposable Codex threads against this checkout, checks tool choice from transcripts and receipts, writes reports under `wf-runs/`, then archives the threads. |
| `AGENT_LINK_LIVE=1 AGENT_LINK_INSTALLED_PLUGIN_ROOT=<path> npm run wf:agent-link:installed-live` | Same live suite against an installed plugin cache directory. |

## Live agent check

A real low-context test should confirm that a separate messenger thread can discover Agent Link, call `get_codex_thread` or `get_claude_session`, call `message_codex_thread` or `message_claude_session`, and that the target receives the message. The Claude-receive checklist lives in [`scripts/claude-receive-wf.md`](../scripts/claude-receive-wf.md).
