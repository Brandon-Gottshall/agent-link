// In-process unit tests for the Codex handler modules split out of
// src/server.js in PR B5 (design doc R5.1). Before the split these functions
// were only reachable by spawning the MCP server; now they are imported and
// driven with fake app-servers, clocks and command runners. Nothing here
// spawns a process, opens a socket or writes a receipt.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerError } from "../../src/codex/app-server-client.js";
import { codexThreadDeepLink, makeDesktopRouting } from "../../src/codex/desktop-routing.js";
import {
  buildSubagentRegistryEntry,
  extractLoadedThreadIds,
  extractThreadSpawnSource,
  groupSubagentsByParentThreadId,
  makeLoadedThreads,
  normalizeLoadedThreadEntries
} from "../../src/codex/loaded-threads.js";
import { archiveReceiptEvidence, launchWarnings, makeThreadActions } from "../../src/codex/thread-actions.js";
import {
  buildReplyConfirmation,
  checkTargetOverrides,
  envelopeReplyConfirmation,
  makeThreadMessaging,
  recentItemLine,
  sameDirectory,
  waitOutcome
} from "../../src/codex/thread-messaging.js";
import {
  buildResolveSelection,
  dedupeThreads,
  isTransientIncludeTurnsUnavailable,
  makeThreadQueries
} from "../../src/codex/thread-queries.js";
import { recentItemWindow, safeIdList, summarizeItem, summarizeThread, summarizeTurn } from "../../src/codex/thread-summary.js";
import { appServerErrorHint } from "../../src/server/health.js";
import { makeCurrentClaudeSession } from "../../src/server/index.js";
import { createLifecycle } from "../../src/server/lifecycle.js";
import { shellQuoteForDisplay } from "../../src/shared/process.js";
import { envelopeBody } from "../helpers/envelope-body.js";

const THREAD = "019d4000-0000-7000-8000-000000000001";
const CALLER = "019d4000-0000-7000-8000-0000000000c1";

/** A scripted fake app-server: answers by method, records every request. */
function fakeAppServer(handlers, summary = { connected: true, managed: false }) {
  const requests = [];
  return {
    requests,
    async request(method, params) {
      requests.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new AppServerError(`fake: ${method}`, { code: -32601 });
      return await handler(params);
    },
    getConnectionSummary: () => summary
  };
}

test("summarizeItem passes identifiers only when they look like identifiers", () => {
  assert.deepEqual(summarizeItem({ type: "mcpToolCall", id: "m1", server: "agent link", tool: "list_codex_threads", status: "completed", durationMs: 3 }), {
    type: "mcpToolCall", id: "m1", server: null, tool: "list_codex_threads", status: "completed", durationMs: 3
  });
  assert.deepEqual(summarizeItem({ type: "not a type", id: "x" }), { type: "unknown", id: "x" });
  assert.deepEqual(summarizeItem(null), { type: "unknown", id: null });
  assert.deepEqual(safeIdList(["ok-1", "bad id", 7, "ok:2"]), ["ok-1", "ok:2"]);
  const command = summarizeItem({ type: "commandExecution", id: "c", command: "x".repeat(600), exitCode: 1.5, durationMs: "3" });
  assert.equal(command.command.length <= 501, true);
  assert.equal(command.exitCode, null);
  assert.equal(command.durationMs, null);
  const user = summarizeItem({ type: "userMessage", id: "u", content: [{ type: "text", text: "hi" }, { type: "mention", name: "repo" }, { type: "localImage", path: "/a.png" }, { type: "other" }] });
  assert.equal(user.text, "hi\n[mention] repo\n[localImage] /a.png\n[other]");
});

test("summarizeThread windows recent items across turns, and ignores a map index", () => {
  const turns = [
    { id: "t1", status: "completed", items: [{ type: "agentMessage", id: "a1", text: "one" }, { type: "agentMessage", id: "a2", text: "two" }] },
    { id: "t2", status: "completed", items: [{ type: "agentMessage", id: "a3", text: "three" }] }
  ];
  const thread = { id: THREAD, name: "T", preview: "p", status: { type: "idle" }, createdAt: 1779086400, updatedAt: 1779086460, path: "/h/sessions/x.jsonl", turns };
  const summary = summarizeThread(thread, { includeTurns: true, recentItems: 2 });
  assert.deepEqual(summary.recentItems.map((item) => [item.id, item.turnId]), [["a2", "t1"], ["a3", "t2"]]);
  assert.equal(summary.turns[0].itemsOmitted, 1);
  assert.equal(summary.createdAt, "2026-05-18T06:40:00.000Z");
  // Array#map passes the index as `options`; turns stay out.
  assert.equal([thread].map(summarizeThread)[0].recentItems, undefined);
  assert.deepEqual(recentItemWindow(turns, 0), { items: [], turns: [] });
  assert.deepEqual(summarizeTurn({ id: "t", status: "inProgress" }).items, []);
});

test("buildReplyConfirmation covers no wait, a failed wait, and a completed turn", () => {
  assert.deepEqual(buildReplyConfirmation(null, "turn"), { waited: false });
  const failed = buildReplyConfirmation({ ok: false, waitedMs: null, timedOut: null, thread: null, error: "boom", details: null, unsupported: true, hint: "h" }, "turn");
  assert.deepEqual(failed, { waited: true, ok: false, timedOut: null, turnStatus: null, finalResponse: null, finalResponseItem: null, error: "boom", details: null, unsupported: true, hint: "h" });
  const thread = { turns: [{ id: "turn", status: "completed", items: [{ type: "agentMessage", id: "a", text: "done", phase: "final_answer" }] }] };
  const ok = buildReplyConfirmation({ ok: true, timedOut: false, waitedMs: 5, thread, waitState: { warnings: ["w"] } }, "turn", 5);
  assert.equal(ok.ok, true);
  assert.equal(ok.finalResponse, "done");
  assert.deepEqual(ok.warnings, ["w"]);
  assert.deepEqual(ok.recentItems.map((item) => item.id), ["a"]);
  const silent = buildReplyConfirmation({ ok: true, timedOut: false, waitedMs: 5, thread: { turns: [{ id: "turn", status: "completed", items: [] }] } }, "turn");
  assert.equal(silent.ok, false);
  assert.match(silent.error, /No final agent response text/);
});

test("envelopeReplyConfirmation envelopes the reply and strips raw text", () => {
  const thread = { turns: [{ id: "turn", status: "completed", items: [{ type: "commandExecution", id: "c9", command: "ls" }, { type: "agentMessage", id: "a", text: "the answer" }] }] };
  const raw = buildReplyConfirmation({ ok: true, timedOut: false, waitedMs: 1, thread, waitState: { finalResponse: { text: "the answer", source: "x" } } }, "turn");
  const sent = { from: CALLER, messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" };
  const out = envelopeReplyConfirmation(raw, { threadId: THREAD, sent });
  assert.equal(out.enveloped, true);
  assert.equal(envelopeBody(out.finalResponse), "the answer");
  assert.match(out.finalResponse, new RegExp(`from="${THREAD}"`));
  assert.match(out.finalResponse, /replyTo="01ARZ3NDEKTSV4RRFFQ69G5FAV"/);
  assert.equal(out.finalResponseItem.text, undefined);
  assert.equal(out.waitState.finalResponse.text, undefined);
  assert.ok(out.recentItems.every((item) => item.text === undefined && item.command === undefined));
  assert.match(out.recentItemsEnvelope, /\[commandExecution c9\] \$ ls/);
  assert.equal(out.reply.from, THREAD);
  assert.deepEqual(envelopeReplyConfirmation({ waited: false }, { threadId: THREAD, sent }), { waited: false });
  assert.equal(recentItemLine({ type: "reasoning", id: "r", summary: ["a", "b"] }), "[reasoning r] a / b");
  assert.equal(recentItemLine({ type: "x", id: "y" }), "");
});

test("waitOutcome maps confirmations to the section 3.4 wait shape", () => {
  assert.deepEqual(waitOutcome({ unsupported: true, error: "e", hint: "h" }, { threadId: THREAD, turnId: "t", waitedMs: null }), { outcome: "unavailable", waitedMs: null, target: { threadId: THREAD, address: `codex:${THREAD}` }, error: "e", hint: "h" });
  assert.deepEqual(waitOutcome({ timedOut: true }, { threadId: THREAD, turnId: "t", waitedMs: 9 }), { outcome: "timeout", waitedMs: 9, target: { threadId: THREAD, address: `codex:${THREAD}` } });
  const done = waitOutcome({ timedOut: false, turnStatus: "completed", finalResponse: "env", recentItems: [], recentItemsEnvelope: null }, { threadId: THREAD, turnId: "t", waitedMs: 3 });
  assert.equal(done.outcome, "turn_completed");
  assert.deepEqual(done.turn, { turnId: "t", status: "completed", finalResponse: "env", completedAt: null });
  assert.equal(done.recentItemsEnvelope, null);
});

test("checkTargetOverrides: equal values forward, known differences conflict, unknown values warn", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-link-overrides-"));
  try {
    const thread = { cwd: realpathSync(dir), model: "m1", reasoningEffort: null };
    // A non-canonical path to the same directory (macOS /var -> /private/var) is the same directory.
    assert.equal(sameDirectory(dir, realpathSync(dir)), true);
    const same = checkTargetOverrides(thread, { cwd: dir, model: "m1" });
    assert.deepEqual(same.forward, { cwd: dir, model: "m1" });
    assert.deepEqual(same.conflicts, []);
    const conflict = checkTargetOverrides(thread, { model: "m2", effort: "high" });
    assert.deepEqual(conflict.conflicts, [{ field: "model", requested: "m2", threadValue: "m1" }]);
    assert.deepEqual(conflict.warnings.map((warning) => warning.code), ["target-override-unverified"]);
    const steering = checkTargetOverrides(thread, { model: "m2" }, { steering: true });
    assert.deepEqual(steering.conflicts, []);
    assert.equal(steering.warnings[0].code, "target-override-ignored-steer");
    assert.deepEqual(checkTargetOverrides(thread, { model: "m2", allowTargetOverride: true }).forward, { model: "m2" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archiveReceiptEvidence reports the loaded-thread guard", () => {
  const archive = { alreadyArchived: false, from: "/a", to: "/b", archiveStateBefore: { scope: "active" }, archiveStateAfter: { scope: "archived" } };
  const passed = archiveReceiptEvidence({ loadedCheck: { checked: true, loaded: false, source: "app-server", loadedThreadIds: ["x", "y"] }, archive, action: "app_server_archive" });
  assert.equal(passed.loadedThreadGuard.status, "loaded_thread_guard_passed");
  assert.equal(passed.loadedThreadGuard.loadedThreadIdsCount, 2);
  assert.equal(passed.archiveMove.source, "local-jsonl");
  assert.equal(archiveReceiptEvidence({ loadedCheck: { checked: true, loaded: true }, archive, action: "a" }).loadedThreadGuard.status, "loaded_thread_detected");
  const unchecked = archiveReceiptEvidence({ loadedCheck: { checked: false, loaded: null, error: "down" }, archive: { ...archive, source: "app-server", response: {} }, action: "a" });
  assert.equal(unchecked.loadedThreadGuard.status, "loaded_thread_guard_unchecked");
  assert.equal(unchecked.loadedThreadGuard.error, "down");
  assert.deepEqual(unchecked.archiveMove.appServerResponse, {});
  assert.deepEqual(launchWarnings({}), []);
  assert.equal(launchWarnings({ ephemeral: true })[0].code, "ephemeral-thread-limited-history");
});

test("loaded-thread helpers normalize ids, entries and subagent sources", () => {
  assert.deepEqual(extractLoadedThreadIds({ data: ["a", { id: "b" }, { threadId: "c" }, { localThreadId: "d" }, null] }), ["a", "b", "c", "d"]);
  assert.deepEqual(extractLoadedThreadIds({ threadIds: ["x"] }), ["x"]);
  assert.deepEqual(normalizeLoadedThreadEntries({ data: ["a", { threadId: "b", extra: 1 }, { id: "  " }, 4] }), [{ id: "a" }, { threadId: "b", extra: 1, id: "b" }]);
  assert.deepEqual(normalizeLoadedThreadEntries({}, ["z"]), [{ id: "z" }]);
  const source = { subagent: { thread_spawn: { parent_thread_id: "p", depth: 2, agent_path: "w", agent_nickname: "N", agent_role: "r" } } };
  assert.deepEqual(extractThreadSpawnSource(source), { parentThreadId: "p", depth: 2, agentPath: "w", agentNickname: "N", agentRole: "r" });
  assert.equal(extractThreadSpawnSource("cli"), null);
  const entry = buildSubagentRegistryEntry({ id: "s", source, path: "/h/archived_sessions/s.jsonl" }, undefined);
  assert.equal(entry.parentThreadId, "p");
  assert.equal(entry.sidebarMembership, "unknown");
  assert.equal(entry.archiveState.scope, "archived");
  assert.deepEqual(Object.keys(groupSubagentsByParentThreadId([entry, { parentThreadId: null }])), ["p", "unknown"]);
});

test("buildResolveSelection flags ties; dedupeThreads keeps the first", () => {
  assert.equal(buildResolveSelection([]).bestId, null);
  const tie = buildResolveSelection([{ id: "a", match: { score: 5 } }, { id: "b", match: { score: 5 } }, { id: "c", match: { score: 1 } }]);
  assert.equal(tie.ambiguous, true);
  assert.deepEqual(tie.tiedCandidateIds, ["a", "b"]);
  assert.equal(buildResolveSelection([{ id: "a", match: { score: 5 } }]).ambiguous, false);
  assert.deepEqual(dedupeThreads([{ id: "a", n: 1 }, { id: "a", n: 2 }, { id: "b" }]), [{ id: "a", n: 1 }, { id: "b" }]);
  assert.equal(isTransientIncludeTurnsUnavailable(new Error("thread not materialized yet")), true);
  assert.equal(isTransientIncludeTurnsUnavailable(new Error("other")), false);
});

test("appServerErrorHint: transport codes get a hint, JSON-RPC errors do not", () => {
  assert.equal(appServerErrorHint(new Error("x")), null);
  assert.equal(appServerErrorHint(new AppServerError("rpc", { code: -32600 })), null);
  assert.match(appServerErrorHint(new AppServerError("x", { code: "readiness-timeout" })), /AGENT_LINK_CODEX_STARTUP_TIMEOUT_MS/);
  assert.match(appServerErrorHint(new AppServerError("x", { code: "startup-failure-cached", cachedCode: "spawn-failed" })), /cached; Agent Link will try again/);
});

test("desktop routing: platform gate, dry run, and the injected command runner", async () => {
  const appServer = { getConnectionSummary: () => ({ managed: true }) };
  const linux = makeDesktopRouting({ appServer, platform: () => "linux", run: () => assert.fail("must not run") });
  assert.deepEqual(await linux.openCodexDesktopThread({ threadId: THREAD }), {
    attempted: false,
    reason: "Codex Desktop thread routing is currently implemented for macOS only",
    deepLink: codexThreadDeepLink(THREAD),
    threadId: THREAD
  });
  const dry = makeDesktopRouting({ appServer, platform: () => "darwin", dryRun: () => true, run: () => assert.fail("must not run") });
  const dryResult = await dry.openCodexDesktopThread({ threadId: THREAD, ephemeral: true });
  assert.equal(dryResult.dryRun, true);
  assert.equal(dryResult.command, `open -g codex://threads/${THREAD}`);
  assert.equal(dryResult.warnings.length, 2);
  const runs = [];
  const ok = makeDesktopRouting({ appServer, platform: () => "darwin", dryRun: () => false, run: async (command, args) => { runs.push([command, ...args]); return { code: 0, signal: null }; } });
  const okResult = await ok.openCodexDesktopThread({ threadId: THREAD });
  assert.deepEqual(runs, [["open", "-g", `codex://threads/${THREAD}`]]);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.exitCode, 0);
  const failing = makeDesktopRouting({ appServer, platform: () => "darwin", dryRun: () => false, run: async () => ({ error: new Error("ENOENT open") }) });
  const failResult = await failing.openCodexDesktopThread({ threadId: THREAD });
  assert.equal(failResult.ok, false);
  assert.equal(failResult.error, "ENOENT open");
  assert.equal(codexThreadDeepLink("a b/c"), "codex://threads/a%20b%2Fc");
  assert.equal(shellQuoteForDisplay("codex://threads/x"), "codex://threads/x");
  assert.equal(shellQuoteForDisplay("it's"), `'it'\\''s'`);
});

test("waitForThreadRead retries a transient read and stops at the deadline, on a fake clock", async () => {
  let clock = 1000;
  const waits = [];
  let reads = 0;
  const appServer = fakeAppServer({
    "thread/read": async () => {
      reads += 1;
      if (reads === 1) throw new Error("includeTurns is unavailable before first user message");
      return { thread: { id: THREAD, status: { type: "active" }, turns: [{ id: "t", status: "inProgress", items: [] }] } };
    }
  });
  const queries = makeThreadQueries({
    appServer,
    now: () => clock,
    wait: async (ms) => { waits.push(ms); clock += ms; }
  });
  const result = await queries.waitForThreadRead({ threadId: THREAD, timeoutMs: 1000, pollIntervalMs: 250 });
  assert.equal(result.timedOut, true);
  assert.equal(result.waitedMs, 1000);
  assert.deepEqual(waits, [250, 250, 250, 250]);
  assert.equal(reads, 4);
});

test("messageThread starts a turn through the injected app-server", async () => {
  const appServer = fakeAppServer({
    "thread/read": async () => ({ thread: { id: THREAD, name: "T", status: { type: "idle" }, cwd: "/w", model: "m" } }),
    "turn/start": async () => ({ turn: { id: "turn-9", status: "inProgress", items: [] } })
  });
  const queries = makeThreadQueries({ appServer });
  const messaging = makeThreadMessaging({ appServer, host: "codex", resolveCurrentSession: () => null, queries });
  const result = await messaging.messageThread(
    { threadId: THREAD, message: "hello", receipt: { record: false } },
    { callerContext: { available: true, threadId: CALLER, turnId: "ct", source: "runtime_context" } }
  );
  assert.deepEqual(appServer.requests.map((request) => request.method), ["thread/read", "turn/start"]);
  const input = appServer.requests[1].params.input;
  assert.equal(envelopeBody(input[0].text), "hello");
  assert.equal(result.action, "started_turn");
  assert.equal(result.deliveredVia, "turn/start");
  assert.equal(result.turn.id, "turn-9");
  assert.deepEqual(result.receipt, { ok: true, recorded: false, reason: "receipt.record was false" });
  await assert.rejects(messaging.messageThread({ threadId: THREAD, message: "x", cwd: "/elsewhere" }), (error) => error.errorCode === "permission_denied");
});

test("launchThread names a blank thread and routes the GUI through the injected desktop", async () => {
  const appServer = fakeAppServer({
    "thread/start": async () => ({ thread: { id: THREAD, status: { type: "idle" } } }),
    "thread/name/set": async () => ({})
  });
  const queries = makeThreadQueries({ appServer });
  const messaging = makeThreadMessaging({ appServer, host: "codex", resolveCurrentSession: () => null, queries });
  const opened = [];
  const desktop = { openCodexDesktopThread: async (options) => { opened.push(options); return { attempted: true, ok: true, threadId: options.threadId }; } };
  const actions = makeThreadActions({ appServer, messaging, desktop });
  const result = await actions.launchThreadTool({ openInGui: true, receipt: { record: false } });
  assert.deepEqual(appServer.requests.map((request) => request.method), ["thread/start", "thread/name/set"]);
  assert.equal(result.thread.name, "New thread");
  assert.equal(result.action, "started_thread+named_thread");
  assert.deepEqual(opened, [{ threadId: THREAD, ephemeral: false }]);
  assert.equal(result.gui.opened, true);
});

test("listLoadedThreads pages to a thread and classifies sidebar membership", async () => {
  const appServer = fakeAppServer({
    "thread/loaded/list": async (params) => params.cursor === "p2" ? { data: ["b"], nextCursor: null } : { data: ["a"], nextCursor: "p2" },
    "desktop/sidebar/state/read": async () => { throw new AppServerError("no sidebar", { code: -32601 }); }
  });
  const loaded = makeLoadedThreads({ appServer, collectAppServerThreadSummaries: async () => ({ data: [], nextCursor: null, backwardsCursor: null }) });
  const result = await loaded.listLoadedThreads({ threadId: "b" });
  assert.deepEqual(result.lookup, { threadId: "b", loaded: true, pagesScanned: 2, complete: true });
  assert.equal(result.sidebarStateError.message, "no sidebar");
  assert.equal(result.loadedThreads[0].sidebarMembership !== undefined, true);
  await assert.rejects(loaded.getSidebarState(), (error) => error.errorCode === "unsupported");
});

test("lifecycle: shutdown closes the app-server once and exits; a hung close is killed at the hard limit", async () => {
  const exits = [];
  const kills = [];
  let closes = 0;
  const lifecycle = createLifecycle({
    appServer: { close: async () => { closes += 1; }, killManagedSync: (signal) => kills.push(signal) },
    exit: (code) => exits.push(code)
  });
  const stopped = [];
  lifecycle.setChannelBridge({ stop: () => stopped.push(true) });
  const first = lifecycle.shutdown(143);
  assert.equal(lifecycle.shutdown(0), first, "shutdown is idempotent");
  await first;
  assert.deepEqual(exits, [143]);
  assert.equal(closes, 1);
  assert.deepEqual(stopped, [true]);
  assert.deepEqual(kills, []);

  const hungExits = [];
  const hungKills = [];
  const hung = createLifecycle({
    appServer: { close: () => new Promise(() => {}), killManagedSync: (signal) => hungKills.push(signal) },
    exit: (code) => hungExits.push(code),
    hardLimitMs: 10
  });
  hung.fatal("test.fatal", new Error("boom"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(hungKills, ["SIGKILL"]);
  assert.deepEqual(hungExits, [1]);
});

test("makeCurrentClaudeSession memoizes per source and only on the Claude host", () => {
  let now = 0;
  const calls = [];
  let answer = null;
  const current = makeCurrentClaudeSession({ host: "claude", now: () => now, sessionId: () => "sid", resolve: (options) => { calls.push(options); return answer; } });
  assert.equal(current(), null);
  now = 4_999;
  current();
  assert.equal(calls.length, 1, "a miss is retried after 5 s, not before");
  now = 5_000;
  answer = { sessionId: "s", source: "transcript" };
  assert.equal(current().sessionId, "s");
  assert.equal(calls.length, 2);
  now = 34_999;
  current();
  assert.equal(calls.length, 2, "a transcript-only session is re-checked after 30 s");
  now = 35_000;
  answer = { sessionId: "s", source: "sidecar" };
  current();
  now = 10_000_000;
  current();
  assert.equal(calls.length, 3, "a sidecar session is kept for good");
  assert.deepEqual(calls[0], { sessionId: "sid" });
  assert.equal(makeCurrentClaudeSession({ host: "codex", resolve: () => assert.fail("not on codex") })(), null);
});
