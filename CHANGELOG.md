# Changelog

## 0.4.0 - 2026-10-06 Routing, Codex correctness, and hardening

Breaking for some callers: `agent_link_mailbox_inspect` returns only the caller's mail unless `scope:"all"`; `wait_for_claude_session` matches only mail addressed to the caller; `replyToMessageId` must reference mail addressed to the caller; peers can no longer silently change another thread's cwd/model/effort without `allowTargetOverride:true`.

- Security: the managed Codex app-server no longer listens on an unauthenticated `ws://127.0.0.1` port. It listens on a Unix socket, `<pid>.sock`, one name per Agent Link process, in a state directory that must be a real directory (not a symlink) owned by the user and is tightened to 0700. When the state path is too long for a socket, the socket goes in a private `agent-link-<uid>` directory under the per-user temp dir on macOS or `/tmp` elsewhere, with the same checks. Where Unix sockets are unavailable (Windows, or `CODEX_AGENT_LINK_APP_SERVER_TRANSPORT=ws-token`) it uses a loopback websocket with `--ws-auth capability-token` and a 0600 token file. The free-port probe is gone from the default path.
- Fixed: `CODEX_AGENT_LINK_SOCK` / `CODEX_APP_SERVER_SOCK` never worked. The `ws` client ignored the socket path and dialed `localhost:80`. It now connects over the socket directly, so a relative path (resolved against the working directory) and paths containing spaces or colons work.
- Security: `message_codex_thread` keeps an existing thread's own `cwd`, `model`, and `effort` unless `allowTargetOverride: true` is passed. A value that differs from one the thread reports is refused (`cwd` is compared by real path, so `/tmp` and `/private/tmp` match). A value the thread does not report (for example a `null` `reasoningEffort`) is not applied, and the result carries a `target-override-unverified` warning. When steering an active turn, which ignores these fields, a mismatch is a `target-override-ignored-steer` warning rather than an error. The wrapper tools (`message_project_orchestrator`, `return_project_work_result`, `register_dependency_handoff`) accept and forward the same flag.
- Security: `register_dependency_handoff` uses the caller's runtime thread as the callback thread. A different `callbackThreadId` is ignored, reported as `dependency.callbackMismatch`, and called out in the handoff message.
- Security: `projectId` and the binding's `policyVersion` are rendered into the project-worker prompt as one inert line: newlines, control characters, and backticks are replaced, and the value is capped at 128 characters. Any `projectId` is still accepted, including `owner/repo`.
- Fixed: turns on the app-server Agent Link manages no longer hang on requests that need a client answer. Approval requests are declined at once (`decline`/`denied`; permission requests get an empty grant) and other server requests get a JSON-RPC error. On an explicitly configured endpoint (`CODEX_AGENT_LINK_URL` / `CODEX_AGENT_LINK_SOCK`), which may be a Desktop app-server with a human at it, these requests are left unanswered. `appServer.serverRequests` in tool results counts them (`declined`, `rejected`, `unanswered`).
- Fixed: local transcript status was never `idle`. Status now comes from the last lifecycle event (`task_started`, `task_complete`, `turn_aborted`, plus the older spellings) via one mapping table, not from whatever event was written last.
- Fixed: transcripts over about 512 MB no longer vanish from listings. Transcripts are read in bounded windows from the head and tail; a record straddling the head window's edge is read whole by the tail. Recent items are read backwards from the end.
- Faster: finding a local thread matches the transcript filename (`*-<threadId>.jsonl`), newest date directories first, and confirms with the first `session_meta` line; a full scan is only the fallback. Transcript summaries are cached by path, size, and mtime. "Did you mean" suggestions rank ids from filenames and read only the winners. Local search fallbacks read at most the newest 300 transcripts instead of 2,000.
- Changed: `recentItems` now counts items, not turns, everywhere. `get_codex_thread` and `wait_for_codex_thread` return `thread.recentItems` (oldest first) on both the app-server and local-fallback paths. App-server items carry their `turnId`, and app-server results also keep `thread.turns`, trimmed to the turns those items belong to. Local-transcript items carry a timestamp instead. `message_codex_thread` with `waitForReply` returns `replyConfirmation.recentItems` (it previously ignored `recentItems`).
- `agent_link_health` on a machine without Codex returns `ok: true` with `codex: { available: false, reason, searched }` instead of an error, and always reports `host`, `codex.path`, and `codex.source`. `codex.version` comes from a `codex --version` probe, which `startAppServer: false` skips (`codex.versionProbed: false`). Failures to reach Codex carry specific hints (binary not found, exited during startup, readiness timeout, autostart disabled) instead of one generic hint; plain app-server errors get none.
- Codex binary discovery order is now: `CODEX_AGENT_LINK_CODEX_BIN`/`CODEX_BIN`, app bundles (ChatGPT.app before Codex.app, in `/Applications` and `~/Applications`), `PATH`, then `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`. A missing explicit override is reported rather than skipped. The layout lives in one module, `src/codex/install-layout.js`.
- A failed managed app-server startup is cached for 60 s, so a broken Codex costs one startup timeout, not one per tool call. `CODEX_AGENT_LINK_APP_SERVER_STARTUP_MS` sets the startup timeout.
- App-server client: a closed client never reconnects or respawns, every request goes through one send path bound to the socket it was issued on, the unbounded notification buffer is replaced by counters and a 20-entry ring (no params kept), and `clientInfo.version` is the package version instead of `0.1.0`.
- Fixed: `list_codex_threads` reported `source: "local-jsonl"` instead of `"local-jsonl-fallback"` when it fell back to local transcripts.
- Fixed: equal-score thread search results were never ordered by recency (`Date.parse` of Unix seconds is `NaN`).
- Fixed: `message_project_orchestrator` and `return_project_work_result` no longer pass their `cwd` search filter as the orchestrator turn's working directory, and `launch_project_worker`'s `name` no longer becomes the orchestrator search query. The binding is verified once, the binding's `policyVersion` reaches the worker prompt, and an absent `cwd` is `null` rather than `""`.
- Fixed: archiving never overwrites an existing archive file (the destination name is reserved with an exclusive create); local thread `createdAt` is `null` rather than `NaN` when unknown, and `updatedAt` is whole seconds. Archive reads the transcript path from the app-server and only looks on disk when the app-server cannot supply it.
- Claude session index: sidecars no longer require `processName`, which no current Claude sidecar has, so every sidecar was being rejected and titles and archive state were lost. Only `sessionId` is required now. Failed sidecar parses are cached by mtime and size. A sidecar and its transcript (current or prior CLI id) are listed once, and the sidecar keeps the transcript path.
- Claude session index: only top-level transcripts (`<projects>/<project>/<cliSessionId>.jsonl`) are indexed. Subagent transcripts no longer replace their parent session, which had given sessions the title "subagents" and the wrong transcript path. `lastActivityAt` is now the transcript's mtime, so listings sort by recent activity instead of creation time.
- Claude identity: one canonical session id (`canonicalClaudeSessionId()`) is used by send, reply, wait, receipts and every receive path. A Claude sender now records its session id instead of the raw CLI UUID, so replies reach its inbox, hook and channel. Receive paths also match mail queued under the other id forms (raw CLI id, `local_<cli>`, sidecar id), so mail already in existing mailboxes is still delivered.
- `read_agent_link_inbox` with `limit` marks only the returned messages delivered; the rest stay pending (they were silently lost).
- `wait_for_claude_session` only resolves on messages from the target that are addressed to the caller and, without `latestMessageId`, sent after the wait started. It accepts a `cliSessionId`, and while waiting it checks only the target's process, at most every 2 s, instead of re-listing every session and running `ps` every 250 ms. The tool description now states these rules and recommends passing `latestMessageId`.
- A reply returned by `message_claude_session`'s `waitForReply` or by `wait_for_claude_session` is marked delivered and acknowledged, so the sender's channel, hook and inbox do not deliver it a second time.
- Claude channel: a sender blocked on a reply no longer also receives it as an `<agent-link-message>`. The bridge in the same process woke ~50 ms after the mailbox changed while the wait polled every 250 ms, so it claimed the reply first. Active waits now register what they will consume in an in-process registry (`src/claude/active-waits.js`) and the bridge leaves those messages pending for the wait. When a wait ends without consuming one (timeout, idle), the bridge is woken and delivers it normally.
- A Claude session whose current CLI id is one of its sidecar's `priorCliSessionIds` now resolves to that sidecar, so the inbox and channel return mail addressed to the sidecar id (the hook already counted it). A prior CLI id claimed by more than one sidecar resolves to neither.
- The current Claude session is resolved by a fast id lookup (sidecar by CLI id, then transcript), memoized, with no `ps` and no full listing. `agent_link_health` resolves it once instead of four times, and reads mailbox status without opening or creating the mailbox.
- `CLAUDE_CONFIG_DIR` is honored for Claude transcripts and current-session resolution (one `claudeConfigDir()` helper). The Agent Link mailbox stays at `~/.claude/agent-link`.
- Exact-id addressing reaches archived Claude sessions in `message_claude_session` and `wait_for_claude_session` (they returned `not_found`). Fuzzy matching still skips archived sessions.
- Caller context from MCP `_meta` is read from an explicit allowlist of exact keys and paths with a defined priority, instead of fuzzy key matching that could, for example, turn `{thread:{turnId}}` into the caller's thread id. Claude Code's `toolUseId` is accepted as the tool call id.
- The channel bridge claims messages before notifying, so the inbox tool in the same process cannot deliver them a second time. A failed notification releases the messages it did not deliver.
- The notify hook tries the payload's `transcript_path` first, and production code no longer reads the test-only `AGENT_LINK_TEST_REGISTRY` (tests inject a resolver). Explicit `mailboxPath`/`dbPath` options now win over the `AGENT_LINK_MAILBOX_*` environment variables.
- Removed the test-only `listSidecars`, `enrichLoaded` and their duplicate walk and `ps` matcher from `src/claude/desktop-registry.js`. Their negative `ps`-matcher tests now run against the session index. `read_agent_link_inbox` and the channel bridge share one XML escaper, and both escape attributes.
- Security: a reply only satisfies `message_claude_session`'s `waitForReply` when it comes from the target and is addressed to the sender, and `replyToMessageId` must reference a message addressed to the caller. Anyone could previously forge the awaited reply.
- Security: only sender ids of a known shape (`local_<uuid>`, a bare uuid such as a Claude CLI id or Codex thread id, or `external`) are rendered; anything else is shown as "unknown sender". Sender kinds other than `claude`, `codex` and `external` render as `unknown`, and message ids that are not ULIDs (including the channel's `meta.message_id`) render as `unknown message`. Stored sender ids must also match `/^[A-Za-z0-9_.:-]{1,80}$/`. The hook's hidden context no longer says "Do this BEFORE answering the user's prompt"; it marks the mail as untrusted content from another agent.
- Security: message bodies are capped at 64 KiB on send and reply, with a clear `invalid_arguments` error. Every mailbox event line is also capped at 512 KiB, and `message_claude_session` stores only sanitized receipt fields (`purpose`, `tags`, `cleanupRecommendation`) and a bounded resolution summary in mailbox metadata; the raw `receipt` argument, which could carry megabytes, is no longer stored there. The mailbox directory is created 0700 and the mailbox file 0600, and an existing mailbox file is tightened to 0600. The receipt log's newly created directories are 0700 and the log file 0600, and an existing log file is tightened to 0600.
- Security: `agent_link_mailbox_inspect` returns only mail sent by or addressed to the caller. Pass `scope: "all"` to see every session's mail. When the caller cannot be identified, the default scope returns no mail and a note.
- `ps` runs through `spawnSync` with a 16 MiB buffer. Output over Node's default 1 MiB used to fail silently and report every Claude session as not loaded; failures are now reported on stderr.
- `message_claude_session` returns the receipt write result as `receipt` (failures were silently dropped despite a comment saying they were logged). `reply_agent_link_message` now writes a `reply_message` receipt and returns its result.
- Small fixes: the session resolver no longer throws on `title: null`, and a mailbox record without `sent_at` gets its event time (or 0) instead of the time of each read.
- Removed dead root modules `src/session-index.js`, `src/receipt-index.js`, `src/caller-context.js`, and `src/thread-utils.js`. Nothing imported them; the canonical copies live in `src/codex/` and `src/shared/`.
- Removed the `src/app-server-client.js` re-export shim. Import `src/codex/app-server-client.js` directly; no in-repo importers of the shim remained.
- Removed the unused `desktopVisibilityContract` import from `src/server.js`.
- Removed the stray `src/claude/.gitkeep` and added `*.bak-*`, `*.OFF`, and `*.orig` to `.gitignore`.
- The plugin now ships a prebuilt server bundle, `dist/server.mjs`, built with esbuild from `src/server.js` and its runtime dependencies. Both hosts launch it directly, so the server starts with no `node_modules`, no `npm`, and no network access. This removes the first-launch `npm ci` that could race between concurrent launches and leave a broken install, and that blocked offline startup for about 70 seconds. `scripts/start-server.js` is removed.
- `npm run build` regenerates the bundle and `npm run check:dist` fails when the committed bundle is stale.
- The server reports the real package version (it reported `0.2.3`). The build injects it from `package.json`.
- The `SessionStart` and `UserPromptSubmit` hooks no longer fail with exit code 127 when `node` is not on the host's `PATH` (or is a version-manager shim that cannot run). The hook exits 0 instead; other hook exit codes pass through.
- `npm run check:approval-config` now reads the tool list from the bundled server's `tools/list` in Codex-host mode, so it checks all 22 Codex tools instead of a hardcoded 17. The README approval snippet now lists all 22; the five it was missing were `agent_link_mailbox_inspect`, `message_claude_session`, `read_agent_link_inbox`, `reply_agent_link_message`, and `wait_for_claude_session`.
- Docs: receipts from both hosts go to one shared log at `$CODEX_HOME/agent-link-receipts.jsonl` (override with `CODEX_AGENT_LINK_RECEIPT_LOG`). The README, the `agent-link` skill, and the plugin manifests no longer describe a per-host log, `$CLAUDE_HOME`, or `CLAUDE_AGENT_LINK_RECEIPT_LOG`, none of which existed.
- `npm test` runs every offline test in one parallel `node --test` run (`scripts/run-offline-tests.js` holds the file list, since Node 20's `--test` takes no globs). `npm run test:claude` and `npm run test:codex` run the two halves. The one-file aliases (`test:send`, `test:feedback`, `smoke:sidebar-state`, `test:codex-lifecycle`, and the rest) are gone; run `node --test <file>` instead.
- Live checks are renamed to `scripts/*.live.js` so `node --test` discovery cannot pick them up, and each refuses to run without `AGENT_LINK_LIVE=1`: `test:live:app-server`, `test:live:launch-thread`, `test:live:launch-thread-persistence`, `test:live:launch-thread-gui` (formerly `smoke:*`), and `test:live:claude-receive` (formerly `scripts/claude-receive-wf-test.js`). `wf:agent-link:live` and `wf:agent-link:installed-live` also require `AGENT_LINK_LIVE=1`.
- The chat-style close and idle-churn lifecycle tests wait on events (responses, spawn-log lines, process exit) instead of fixed sleeps, run their cases concurrently, and now assert that a completed tool call started exactly one app-server. Together they take about 5 s instead of about 40 s.
- New shared test helpers in `tests/helpers/`: `env.js` (`hermeticEnv()`: temp `HOME`, inherited `CODEX_*`/`CLAUDE_*`/`AGENT_LINK_*` stripped), `codex-stub.js` (formerly `tests/codex/test-helpers.js`), and `idle-churn.js` (`measure()`, moved out of `scripts/idle-churn-measure.js`, which is now a thin CLI).
- CI: GitHub Actions runs `check:dist`, `npm test`, and the offline WF suite on macOS with Node 20 and 22 for every push and pull request.
- Docs: Node.js 20 or later is the only runtime requirement. The README marks the Claude session listing tools as Claude-host only, matching current behavior.

## 0.3.0 - 2026-10-06 Remove Antechamber handoff and Desktop bridge discovery

Breaking for callers that used these options.

- Removed `launch_codex_thread`'s `antechamberHandoff` option. Agent Link no longer runs the Antechamber broker CLI. The result still includes the `codex://threads/<threadId>` deep link; pass it to Antechamber's own MCP tools, or any other router, when a GUI route is needed.
- Removed automatic discovery of a Codex Desktop app-server bridge from `desktop-app-server.json`. Any local process could write that file and redirect Agent Link's Codex traffic. To use a Desktop app-server, set `CODEX_AGENT_LINK_URL` explicitly. `CODEX_AGENT_LINK_USE_DESKTOP_BRIDGE` and `CODEX_AGENT_LINK_DESKTOP_ENDPOINT_FILE` are no longer read.
- Removed the native quiet-route helper (`scripts/codex-native-route.js`, previously the `codex-agent-link-route` bin), the installed Desktop route-host inspector, and their tests and docs. The quiet-route helper belongs with the tool that owns GUI routing.

## 0.2.7 - 2026-10-06 Clean public history

- The repository was recreated with a single fresh commit. Earlier history contained developer-machine paths, real session and thread identifiers, and an author email; none of it was a credential.
- Antechamber broker discovery no longer probes developer build paths. Set `CODEX_AGENT_LINK_ANTECHAMBER_CLI`, or put `agent-browser-broker` on `PATH` or in `/opt/homebrew/bin` or `/usr/local/bin`.
- `wf:agent-link:installed-live` reads the installed plugin path from `AGENT_LINK_INSTALLED_PLUGIN_ROOT`. `archive-exdev-regression-test.js` skips unless `AGENT_LINK_EXDEV_TEST_ROOT` names a directory on another volume.
- Removed historical planning docs, one-off probes, a dated WF run report, and stale backup manifests. Test fixtures use synthetic identifiers and `/Users/example` paths.

## 0.2.6 - 2026-10-05 Public install

- The GitHub repo is now a plugin marketplace for both hosts: `.claude-plugin/marketplace.json` for Claude Code and `.agents/plugins/marketplace.json` for Codex. Install with `claude plugin marketplace add Brandon-Gottshall/agent-link` or `codex plugin marketplace add Brandon-Gottshall/agent-link`.
- New MCP entrypoint `scripts/start-server.js` runs `npm ci --omit=dev` on first launch when runtime dependencies are missing, then starts `src/server.js`. Marketplace installs are git checkouts without `node_modules`, so the old entrypoint crashed on a fresh machine.
- `npm run check:approval-config` now checks `codex-agent-link@agent-link` by default. Set `CODEX_AGENT_LINK_PLUGIN_ID` to check a different marketplace id.
- README rewritten: install steps first, tool and configuration tables, behavior reference split by topic. The test catalogue moved to `docs/testing.md`.
- Added the MIT `LICENSE` file the manifests already declared.

## 0.2.5 - 2026-10-02 Find ChatGPT's bundled codex-cli

- Managed app-server startup now finds the live Codex at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` (codex-cli 0.159.0). 0.2.4 looked for `Resources/codex`, which does not exist, and fell back to the stale `/Applications/Codex.app` (0.144.0-alpha.4), whose `thread/resume` fails on newer threads with `paginated_threads is not supported yet`.
- New regression test drives the server the way a chat-style MCP host does (detached spawn, stdin end, group SIGTERM, SIGKILL after 1 s) and asserts no app-server outlives it.

## 0.2.4 - 2026-09-29 Live Codex binary for managed startup

- Managed app-server startup prefers `/Applications/ChatGPT.app/Contents/Resources/codex` (the live Codex Desktop) over `/Applications/Codex.app`. The stale Codex.app copy (codex-cli 0.144) ended every launched thread in `systemError` within 2 s. `CODEX_AGENT_LINK_CODEX_BIN` and `CODEX_BIN` still take precedence.

## 0.2.3 - 2026-09-28 Idle cost and app-server lifecycle

Measured live on 2026-09-28: each idle agent-link server used 12-56% of a core,
and `codex app-server --listen ws://127.0.0.1:<port>` processes were left with
parent = launchd. With ~15 sessions open the load average reached 170.

**Idle CPU (the channel bridge).** The Claude channel bridge ran every second
and re-resolved the current session each time. That walked the whole session
corpus and regex-scanned every `ps` line for every session, about 280 ms of CPU
per tick. Changes:

- The session is resolved once and cached, because it never changes for a
  server's lifetime.
- An unchanged mailbox is skipped with one `stat()` on (ino, size, mtime).
- The poll interval backs off exponentially from 1 s to 30 s while there is
  nothing to deliver. `fs.watch` on the mailbox directory wakes it at once
  when a message lands.
- `listClaudeSessions` filters `ps` to `claude ... --resume` lines once per
  call instead of once per session. Output is byte-identical: checked on all
  595 local sessions, including synthetic loaded and near-miss lines.

Result (`scripts/idle-churn-measure.js`, 120 s idle, real session corpus):
23.4% CPU before, 0.3% after.

**Managed app-server lifecycle** (`src/codex/app-server-client.js`,
`src/server.js`):

- Idle servers never start an app-server. The first real tool call starts one
  (lazy, unchanged) and later calls reuse it.
- Connect and spawn are single-flight. Before this, concurrent first calls
  could each spawn an app-server, and the first handle was overwritten and
  never killed.
- An idle timeout (5 min by default; `CODEX_AGENT_LINK_APP_SERVER_IDLE_MS`,
  0 disables) stops the app-server. The next call starts a fresh one.
- The app-server is spawned `detached`, so it leads its own process group.
  Every stop signals the whole group: SIGTERM, a bounded wait, then SIGKILL for
  the leader and any members still running.
- Shutdown on SIGTERM, SIGINT, SIGHUP (new) and stdin end/close now waits for
  that cleanup (hard limit 4 s) before exiting. Before, SIGTERM exited without
  waiting, stdin end never exited, and SIGHUP left the app-server orphaned.
- A startup that never becomes ready is killed as a group, not leaked.
- Orphan reaper: each spawn writes
  `~/.claude/agent-link/managed-app-servers/<pid>.json`
  (`CODEX_AGENT_LINK_STATE_DIR` overrides the location). At server startup and
  before a spawn, any record whose owner is dead is acted on. Its process group
  is killed only if the recorded pid still runs an `app-server` command with
  the recorded URL, so a reused pid is never signalled.
- `src/app-server-client.js` now re-exports `src/codex/app-server-client.js`.
  It was a byte-identical copy.

Tests: `npm run test:codex-lifecycle` (stub app-server; never launches
Codex.app) and new channel-bridge cases in `npm run test:claude`.

## Unreleased - 2026-08-06 Cross-device archive (EXDEV) fallback

`archiveLocalThread` moved threads into `archived_sessions` with a bare
`fs.rename`, which throws `EXDEV` when `archived_sessions` is a symlink onto a
different volume (for example when the archive is offloaded to an external drive). The rename is
retained as the fast path; on `EXDEV` the move falls back to copy → same-volume
atomic promote → unlink:

- The copy stages under a `.exdev-tmp-<pid>` name so `.jsonl` discovery never
  observes a partial transcript, then promotes with an atomic same-volume rename.
- Source `mtime` is preserved onto the destination — thread list ordering sorts
  by it.
- On any fallback failure the staging file is removed and the source is left
  untouched; the operation is retryable.
- New regression: `scripts/archive-exdev-regression-test.js` exercises a real
  cross-device `archived_sessions` symlink (skips cleanly when no second volume
  is mounted). Note: Codex Desktop's *native* archive/unarchive
  (`codex-rs/thread-store`) still does a bare rename and will surface EXDEV as a
  recoverable error dialog; archiving through agent-link tools is the supported
  path while the archive lives off-volume.

## Unreleased - 2026-07-31 Session-index poll cost

The Claude Channel bridge polls `listClaudeSessions()` once per second, and that
call re-read the entire session corpus on every tick. On this machine that was
841 MB of transcripts plus ~4 MB of sidecars per tick, measured at **2071 ms per
call** — twice the poll interval, so the bridge ran permanently backlogged and
pinned a core (~90% CPU per Claude Code session, and it spawns one per session).

- **Transcript reads are now bounded.** `parseTranscriptSummary` only ever needed
  the opening record — the existing loop breaks on the first parseable line — but
  `fs.readFileSync` + `raw.split("\n")` had already materialized the whole file,
  up to 39 MB each. It now reads a bounded 64 KB prefix via `fs.readSync`, growing
  (capped at 4 MB) only when the prefix contains no parseable line at all. The
  trailing partial line is discarded, which also drops any UTF-8 sequence the byte
  boundary split.
- **Repeat parses are cached.** Transcript summaries and sidecars are memoized on
  `(mtimeMs, size)`, so unchanged files cost one `statSync` per tick instead of a
  full read and `JSON.parse`. Malformed sidecars are deliberately not cached, so
  they still throw and are skipped exactly as before.

Steady state drops from 2071 ms to 111 ms per call (18.6x), and sustained 1 Hz
polling from >64% of a core to ~10.6% — the bridge now keeps pace with its own
interval. Verified behaviour-identical against the previous implementation across
all 595 local transcripts and 197 resulting sessions: zero field differences, and
the cached pass matches the cold pass exactly. Full `test:claude` suite green.

Known issue, not changed here: `lastActivityAt` is set from the *first* record's
timestamp, but `listClaudeSessions` sorts by it as a recency key. Sessions are
therefore ordered by start time, not last activity. Fixing it means switching the
field to `stat.mtimeMs`, which changes list ordering, so it is left for a
deliberate change.

## 0.2.2 - 2026-06-18 Claude receive fixes

A live WF run inside the Claude Desktop app found the Claude **receive** direction was non-functional in the real host even though the full regression suite was green.

- **Bug A (P0/P1):** the current Claude session was resolved only from `process.env.CLAUDE_SESSION_ID`, but the Claude Desktop host and Claude Code 2.1.x (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`) expose it as `CLAUDE_CODE_SESSION_ID` and leave `CLAUDE_SESSION_ID` empty. Result: `read_agent_link_inbox` returned `no_current_session` and sends recorded `from="external"`. Fixed by centralizing `currentClaudeSessionId()` (reads `CLAUDE_SESSION_ID || CLAUDE_CODE_SESSION_ID`) in `src/shared/host-detect.js` and wiring it through `server.js`, `session-index.js`, `claude-send.js`, host detection, and the `read_agent_link_inbox` hint. `detectHost` now also recognizes `CLAUDE_CODE_SESSION_ID`. Regression test in `tests/shared/host-detect.test.js`.
- **Bug B (P2):** the `UserPromptSubmit`/`SessionStart` notify hook resolved sessions only via `findSidecar`, so transcript-only sessions (Claude Code inside Claude Desktop, no sidecar) never received the pending-mail nudge. Fixed by adding `findTranscriptSessionByCliId` in `src/claude/session-index.js`, resolved from the hook payload's `transcript_path` (O(1); a one-`existsSync`-per-project-dir fallback, never parsing transcript contents, keeps it within the per-prompt hook budget). Regression test in `tests/claude/notify-hook.test.js` (Test 6).

## 0.2.1 - 2026-06-18 Claude Code usability

- Replaced the native `better-sqlite3` mailbox with a pure-JS append-only JSONL mailbox at `~/.claude/agent-link/mailbox.jsonl`. `AGENT_LINK_MAILBOX_PATH` is the new write path override; `AGENT_LINK_MAILBOX_DB` remains as a deprecated legacy SQLite import hint and `.sqlite` path mapper.
- Added normalized Claude session indexing across Desktop sidecars, Claude Code sidecars, live `claude --resume` processes, and `~/.claude/projects/**/*.jsonl` transcript metadata. `list_claude_sessions` and `resolve_claude_session` can filter by `surface: "desktop" | "code" | "all"`.
- Added `reply_agent_link_message` so Claude can reply to an inbound Agent Link message by `messageId` without manually copying sender IDs.
- Added a Claude Code Channel bridge: in Claude host mode the MCP server declares `claude/channel`, polls the JSONL mailbox for the current Code session, emits `<agent-link-message>` events, and marks pushed messages delivered.
- Kept the Claude Desktop hook + `read_agent_link_inbox` receive path intact for Desktop compatibility.

## 0.2.0 - 2026-05-11 Agent Link restructure

- Renamed the plugin from `codex-agent-link` to `agent-link`. The Codex envelope keeps `codex-agent-link` as an alias so existing approval-config keys and Codex installs continue to work without edits.
- Added a Claude Desktop adapter: read-only access to Desktop's session registry under `~/Library/Application Support/Claude/local-agent-mode-sessions/`, a local SQLite mailbox at `~/.claude/agent-link/mailbox.sqlite` (WAL mode, override with `AGENT_LINK_MAILBOX_DB`), a plugin-scoped `UserPromptSubmit` and `SessionStart` notify hook installed via `hooks/hooks.json`, and a `read_agent_link_inbox` MCP tool that renders the inbox as a visible MCP tool result in the Desktop transcript. Discovery surface mirrors the Codex adapter: `list_claude_sessions`, `list_loaded_claude_sessions`, `get_claude_session`, `resolve_claude_session`, plus `message_claude_session` and `wait_for_claude_session`.
- Made cross-host messaging first-class. Codex-to-Claude and Claude-to-Codex use the same send tools. Receipts log on the sender's host with `host` and `target.kind` set so audits filter by host pair.
- Extended the receipt schema additively: new optional `host` top-level field plus `target.kind`, `target.sessionId`, and `target.loaded` fields. Old receipts still parse.
- Established `.plugin/plugin.json` as the canonical metadata source. The Claude and Codex envelope manifests were emitted by an external manifest sync script (not included in this repo), which honors `aliases.<host>` so the Codex envelope keeps the legacy name.
- Recorded Phase 0 hook-probe findings: the `Stop` hook does not accept `additionalContext`; `UserPromptSubmit` and `SessionStart` do; all `additionalContext` is hidden from the user. This drove the receive design pivot from a hook-injected message body to a tool-result visibility surface (`read_agent_link_inbox`).
- Deferred to a future v2 release: `launch_claude_session` (no clean primitive — the `claude://` URL scheme accepts no useful parameters and the accessibility tree is opaque), `archive_claude_session` (Desktop owns archive state), sidebar visual indicators (no Desktop hook for them), an HTTP push endpoint (the original Channels framing — discarded), and a Claude Code CLI adapter outside Desktop.

## 0.1.0 - 2026-05-03 Feedback follow-up

- Added local Agent Link receipt indexing for launch/message actions, with `list_agent_link_receipts`, `get_codex_thread.includeReceipts`, caller-supplied origin metadata, cleanup guidance, tags, and final-response capture when available.
- Added `archive_codex_thread` for first-class disposable thread cleanup, with loaded-thread checks, local session archival, and `archive_thread` receipts.
- Added archive receipt evidence so agents can read `evidence.loadedThreadGuard` as the primary active-safety signal instead of over-weighting local JSONL `target.status`.
- Added receipt origin inference from MCP runtime caller metadata and best-effort `CODEX_THREAD_ID` / `CODEX_TURN_ID` environment fallback when callers do not supply explicit origin fields.
- Added `resolve_codex_thread`, `archiveScope`, and local JSONL search supplementation so agents can resolve threads across active and archived sessions by title, preview, cwd/path, recent text, or partial ID even when app-server pagination omits older matches.
- Added explicit state contracts for `stateSemantics`, `archiveState`, `runtimeState`, and `desktopVisibility`, including the distinction between app-server delivery and Codex Desktop visual unarchive/selection.
- Added `message_codex_thread.waitForReply` reply confirmation with final-response extraction when available, and explicit non-proof errors when delivery/completion lacks agent text.
- Added wait-state reconciliation so `wait_for_codex_thread` and reply confirmation treat a completed latest/target turn with final text as completion even when the app-server top-level thread status remains stale `active`, while returning an explicit warning about the inconsistency.
- Added active/waiting target warnings and `allowParallelTurn` opt-in so agents do not accidentally start parallel turns when steering is intended.
- Added fuzzy `didYouMean` suggestions for mistyped thread IDs, including local transcript recovery for valid-format one-character typos.
- Added blank launch naming/persistence behavior so non-ephemeral empty launches receive a supplied name or `New thread` and survive fresh app-server reads.
- Expanded regression and smoke coverage for archive-scope resolution, runtime caller-context extraction, fuzzy ID suggestions, active-turn warnings, reply extraction, launch persistence, and GUI deep-link dry runs.
