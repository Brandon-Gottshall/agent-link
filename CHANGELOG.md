# Changelog

## Unreleased

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
