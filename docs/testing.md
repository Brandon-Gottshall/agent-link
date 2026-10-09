# Testing Agent Link

Run these from a clone after `npm ci`. Protocol smoke tests are necessary but not sufficient: a change to a user-facing flow also needs a live run where a fresh agent discovers and uses the tools.

## Offline suite

`npm test` runs every offline test with `node --test`, in parallel. Nothing in it launches Codex.app, a real Codex app-server, or a GUI; the app-server tests use the stub in `tests/fixtures/stub-codex-app-server.js`. CI runs the same suite on macOS with Node 20 and 22 (`.github/workflows/test.yml`), after `check:dist`, `typecheck`, and `lint`.

| Command | What it covers |
| --- | --- |
| `npm test` | Every group below (`manifest`, `claude`, `codex`, `server`, `mcp`), in one `node --test` run. |
| `npm run test:claude` | Claude side: mailbox, session index and resolver, Desktop sidecars, send, reply, read-inbox, wait, notify hook, Code channel bridge, the inbound peer envelope, and message labels, resolution, reminders, the `Stop` hook, and `get_agent_link_message_status` with an injected clock (`tests/claude/reply-model.test.js`), role handover of open messages (`tests/claude/role-handover.test.js`) (`tests/claude`), plus the shared modules: addresses and identity, host detection, runtime context, argument validation, errors, envelope rendering, state directory, legacy state, and cross-host receipts (`tests/shared`). |
| `npm run test:codex` | Codex side: binary discovery, app-server client, lifecycle, and logging, idle churn and shutdown, chat-style close, the Codex session index, dependency-handoff matching, the peer envelope on Codex turns and replies, Codex reminder turns against the stub app-server (`tests/codex/reminder-turns.test.js`), the `orchestrator` role in project-orchestrator resolution (`tests/codex/orchestrator-role.test.js`), in-process unit tests of the thread handler modules, and the golden replay (`tests/codex`), plus the feedback, sidebar-state, project-orchestrator, dependency-handoff, and archive-EXDEV regressions in `scripts/`. |
| `node scripts/run-offline-tests.js server` | Server: tool registry and argument contract, the `tools/list` snapshot and output schemas, side-effect-free module imports, and the host-neutral session registry behind `list_agents` and `resolve_agent` (`tests/server`). No npm alias. |
| `node scripts/run-offline-tests.js manifest` | The Claude and Codex plugin manifests, marketplace files, and `package.json` agree, and hook commands point at files that exist (`tests/manifest.test.js`). |
| `npm run smoke` | The bundled MCP server (`dist/server.mjs`) starts, reports the package version, and exposes the same tools on both hosts. Also part of `npm test`. |
| `npm run check:dist` | The committed bundle `dist/server.mjs` matches a fresh `npm run build`. |
| `npm run typecheck` | `tsc` checks the JSDoc types in `src/` (`checkJs`, non-strict). Must report 0 errors; CI blocks on it. |
| `npm run lint` | ESLint guardrails (`eslint.config.js`): in `src/`, no `console` calls and no `process.stdout` (stdout is the MCP protocol; log through `src/shared/log.js`; `src/claude/notify-hook.js` is exempt because its stdout is the hook protocol); everywhere, no empty blocks (an empty `catch` needs a comment saying why the error is safe to ignore), `===`, and `const` for bindings never reassigned. CI blocks on it. |
| `npm run check:approval-config` | Codex approval settings let the model call every read-only tool without asking, and list which side-effecting tools are auto-approved (`--all` requires every tool). Scripted calls can pass while model-selected calls are still blocked. Set `CODEX_AGENT_LINK_PLUGIN_ID` if you installed from a different marketplace. It reads only the config you name: `npm run check:approval-config -- --config <path>` (or `CODEX_CONFIG=<path>`); with no path it refuses (exit 2). Your real Codex config is read only by `npm run check:approval-config:real` (`--real-config` or `AGENT_LINK_CHECK_REAL_CONFIG=1`), so it is not part of `npm test`. |
| `npm run wf:agent-link` | WF suite, required tools, and fixture verdict logic, without launching live threads. Writes a report under `wf-runs/`. |
| `npm run measure:idle-churn` | Idle CPU and app-server churn of one server over 120 s, as JSON, against the stub app-server. `scripts/idle-churn-measure.js` also takes `--idle-seconds`, `--plugin-root`, `--real-home`, and `--shutdown`. |

To run one file, call `node --test <file>` (or plain `node <file>`). Pass `node --test` flags through the runner after `--`, for example `npm test -- --test-concurrency=1`.

The file list lives in `scripts/run-offline-tests.js`, because Node 20's `--test` takes no globs. Add new offline test files to a group there; the runner warns about any file that matches `node --test`'s default name patterns but is not listed.

### Writing tests

- Spawn the server with `hermeticEnv()` from `tests/helpers/env.js`. It strips inherited `CODEX_*`, `CLAUDE_*`, and `AGENT_LINK_*` variables, points `HOME` at a temp directory, and puts the running Node first on `PATH`. Pass `home`, `codexHome`, or `overrides` as needed.
- `tests/helpers/codex-stub.js` has the stub path, spawn-log reader, `taggedStub()`/`taggedProcesses()` for finding every app-server a run started, and `waitFor()`/`waitForExit()`. Wait on events (a response id, a spawn-log line, process exit), not fixed sleeps.
- Prefer in-process tests for handler logic. `src/server/index.js` and the modules under `src/codex/` and `src/server/` have no import-time side effects (`tests/server/server-modules.test.js` checks this), and their factories (`makeThreadQueries`, `makeThreadMessaging`, `makeThreadActions`, `makeLoadedThreads`, `makeDesktopRouting`, `makeHealth`, `createLifecycle`, `createAgentLinkServer`) take the app-server client, host, clock, and command runner as arguments, so a test can pass fakes instead of spawning the server.
- `tests/codex/golden-replay.test.js` replays a fixed script of Codex tool calls against a stateful fake app-server and compares the normalized results and app-server requests with `tests/fixtures/golden/codex-tools.golden.json`. A change that is meant to alter Codex tool output re-records it with `node tests/codex/golden-replay.test.js --update`; list the diff in the PR. `--server <path>` replays against another tree's `src/server.js` or `dist/server.mjs`.
- `tests/server/removed-arguments.test.js` checks that each argument alias removed in 0.6.0 is rejected with `invalid_arguments` and a hint naming its replacement, and that the duplicated 0.4 output keys are gone.
- `tests/server/tools-contract.test.js` compares `tools/list` on each host with `tests/fixtures/tools-list.claude.json` and `tools-list.codex.json`. After an intended schema change, re-record them with `node tests/server/tools-contract.test.js --update` and list the diff in the PR.
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

## Cross-harness live E2E

`scripts/cross-harness-e2e.live.js` checks messaging between a Claude-side session and real Codex threads, using this checkout's `dist/server.mjs` on both sides. A full run takes about 18 real model turns, so it is manual only: it is not in `npm test`, `scripts/run-offline-tests.js`, or CI, and it refuses to run without both `AGENT_LINK_LIVE=1` and `--yes-real-codex`.

```sh
npm ci && npm run build
AGENT_LINK_LIVE=1 npm run test:live:cross-harness -- --yes-real-codex
```

Setup:

- All Agent Link state for both sides lives in one fresh directory under the system temp dir: `AGENT_LINK_STATE_DIR`, `AGENT_LINK_MAILBOX_PATH`, `AGENT_LINK_RECEIPT_LOG`, `AGENT_LINK_MANAGED_DIR`, `AGENT_LINK_LOG_FILE`, a fake `CLAUDE_CONFIG_DIR`, and `HOME` for both MCP servers. The script refuses to run if any of them resolves under your home directory, so `~/.agent-link`, `~/.claude`, and the legacy receipt log are never touched.
- It starts its own `codex app-server --listen unix://<tmp>/a.sock` (A). `-c` overrides, for that process only, add `dist/server.mjs` as the MCP server `agent_link_e2e` with the isolated environment and tool approval `approve`. They also set `approval_policy="never"`, `sandbox_mode="read-only"`, and the reasoning effort (`--effort`, default `low`). Your `config.toml` is neither edited nor read. Threads get no grant for peer requests by default, because the envelope notice already says that replying, declining, or marking a message done is always allowed. `--peer-authorization` adds a developer instruction that grants peer requests, as a user would in `AGENTS.md`.
- Installed Agent Link copies are disabled for that process. A short probe app-server lists them with `plugin/installed` and `mcpServerStatus/list`. Then `-c plugins.<id>.enabled=false` and `-c mcp_servers.<name>.enabled=false` turn them off. Codex splits `-c` keys on `.` and ignores TOML quoting, so the ids go in bare. Use `--disable-plugin <id>` and `--disable-mcp-server <name>` to name them yourself. The run stops if another Agent Link server still has tools.
- The Claude side is the script itself. It is an MCP client over stdio to `dist/server.mjs` with `AGENT_LINK_HOST=claude`, a random `CLAUDE_SESSION_ID` backed by a fake transcript, and `AGENT_LINK_CODEX_SOCK` pointing at A. The Claude Code channel is off by default, so inbound mail waits for the hook and the inbox. `--claude-channel` turns it on.
- A second app-server (B), which Agent Link is not pointed at, stands in for the Codex desktop app. Its threads get the build under test as their MCP server, with the same isolated state. For scenario 9 it also runs the repo's Codex prompt hook (`src/codex/prompt-hook.js`), which is registered and trusted for that process only. The hook is registered with `-c hooks.UserPromptSubmit=[…]`, whose command sets the isolated `AGENT_LINK_*` paths. It is trusted with `-c hooks.state={"<key>"={trusted_hash="<hash>"}}`, where the key and hash come from `hooks/list` on a first start of B (design R1.14a).
- Every thread gets its own temp cwd and a first message containing `agent-link E2E (throwaway)`. All of them are archived at the end, and both app-servers are stopped.

Scenarios (`--scenarios 1,3` runs a subset; 2, 3, 6, 7, and 8 need scenario 1's thread):

| # | Checks |
| --- | --- |
| 1 | `launch_codex_thread` with `anticipation: "reply"`. The thread gets the `<agent-link-message>` envelope and replies with `reply_agent_link_message`. Then `wait_for_agent` returns `reply`, and `get_agent_link_message_status` returns `replied`. |
| 2 | `message_codex_thread` to the loaded thread is `delivered` via `codex-turn`. The userMessage echoes the message id as `clientId`. |
| 3 | The thread's user asks it to call `message_claude_session`. The Claude `UserPromptSubmit` hook (run as `hooks/hooks.json` does) prints a notice, and `read_agent_link_inbox` shows the message. The Claude reply reaches the thread as a pushed turn or through its inbox. |
| 4 | A thread loaded only in B is `notLoaded` for Agent Link. A send is `queued` with `codex_desktop_push_disabled`, and no turn appears. |
| 5 | A `reply` message to an idle thread without the agent-link tools gets reminder turns only while it is idle. They stop at `AGENT_LINK_REMINDER_LIMIT=2` (interval 30 s), and the status ends `unresolved`. |
| 6 | `fork_codex_thread` with another model from `model/list` sends exactly one reconcile message with fork metadata. The fork is archived with `threadSource` `agent-link-fork`, the receipts carry `tokenUsage`, and the reconcile is pushed to the original with a `<fork>` element. |
| 7 | `set_agent_role` `e2e-lead` on the thread. `message_agent` to `role:e2e-lead` reaches it, and it replies. |
| 9 | The Codex prompt hook on a thread held in B. Turn 1, with an empty mailbox: the hook runs and adds nothing. A `reply` message sent from the Claude side is then `queued` with `codex_desktop_push_disabled`. Turn 2: the user-style prompt gets the context entry "Agent Link: 1 pending peer message from …" in `hook/completed`, with no message body, and the thread reads its inbox. Before the reminder interval, the hook, run by hand, adds nothing. Turn 3, after the interval: "reminder 1 of N". With `--reminder-limit 1`, the hook adds nothing after the cap, and the message reads `unresolved`. The reminder events carry `via: codex-prompt-hook`. The thread never gets a pushed turn. |
| 8 | `agent_link_health` on both sides. The Codex side is called through the app-server's `mcpServer/tool/call`, with no model turn. Checks: `desktopPush` is `mailbox-only` with the verified Codex version, `overrideCosts` is measured, `forkJobs` and `rolloutChecks` counts are present, and there are no warnings. |

Other options:

- `--s1-runs <n>` repeats scenario 1 on fresh threads, to gauge how reliably threads reply.
- `--reminder-limit <n>` (default 2) caps reminders for every scenario.
- `--setup-only` starts everything, registers and trusts the hook, then stops without a model turn.

Scenarios 1 and 7 record the model's text from every turn that ended without a reply.

The script prints a verdict per scenario and writes a JSON report (`--report <file>`; default in the temp dir) with the evidence, the thread ids, and the archive results. `--keep-state` keeps the temp state directory for inspection.

Expected limits:

- The lsof rollout check needs the endpoint's process group, which Agent Link knows only for an app-server it manages. With an explicit `AGENT_LINK_CODEX_SOCK` it is skipped (`endpoint_pid_unknown`), and scenario 4 records that as a note.
- Before the current envelope notice, low-effort threads without a grant sometimes declined peer requests. They said a reply needed user authorization. With the notice, threads have replied on the first turn without a grant. If a decline shows up again, scenarios 1 and 7 record the model's text.

## Live agent check

A real low-context test should confirm that a separate messenger thread can discover Agent Link, call `get_codex_thread` or `get_claude_session`, call `message_codex_thread` or `message_claude_session`, and that the target receives the message. The Claude-receive checklist lives in [`scripts/claude-receive-wf.md`](../scripts/claude-receive-wf.md).
