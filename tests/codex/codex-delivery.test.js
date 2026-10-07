// Background Codex delivery and push safety (B7b fix round a2): the
// background preflight (fresh thread/read and held check before every push,
// F1), passes only on a connected endpoint and only for threads the tracker
// saw (F2), one background turn per thread per pass and the tracker marking
// a thread active on an accepted turn (F4), the shared-daemon refusal (F5),
// the deny-only rollout check (F6), sender-only status in message waits
// (F7), lost push responses and stale push claims (F10), the archive
// not_found case (F11), confirmDelivery, pushQueuedCodexMail and
// makeCodexDelivery. Pure in-process tests on a fake app-server and a temp
// mailbox; nothing is spawned.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMailbox } from "../../src/claude/mailbox.js";
import {
  desktopPushPolicy,
  desktopPushReport,
  makeBackgroundPreflight,
  makeThreadStatusTracker,
  pushClaimKey,
  pushCodexMessage,
  pushQueuedCodexMail,
  sweepStalePushClaims
} from "../../src/delivery/codex-push.js";
import { codexRecipientOf, confirmDelivery, makeCodexDelivery } from "../../src/delivery/codex-delivery.js";
import { makeRolloutCheck, parseLsofFields } from "../../src/codex/rollout-holders.js";
import { pollMessageResolution } from "../../src/delivery/message-wait.js";
import { makeThreadActions } from "../../src/codex/thread-actions.js";
import { makeThreadMessaging } from "../../src/codex/thread-messaging.js";
import { makeThreadQueries } from "../../src/codex/thread-queries.js";
import { AppServerError } from "../../src/codex/app-server-client.js";

const T = "019d9300-0000-7000-8000-000000000001";
const U = "019d9300-0000-7000-8000-000000000002";
const SENDER = "019d9300-0000-7000-8000-0000000000aa";
const SETTINGS = { limit: 3, intervalMs: 30_000, warnings: [] };
const NO_ROLES = (/** @type {any} */ row) => codexRecipientOf(row, null);

function tempMailbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "al-cd-"));
  const mailboxPath = path.join(dir, "mailbox.jsonl");
  return { dir, mailboxPath, open: () => openMailbox({ mailboxPath }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A fake app-server: `threads` maps id -> {status, path?, turns?}.
 * @param {Record<string, any>} threads
 * @param {{failTurnStart?: string | null, connected?: boolean}} [options]
 */
function fakeAppServer(threads, { failTurnStart = null, connected = true } = {}) {
  const requests = [];
  let turn = 0;
  return {
    requests,
    connected,
    isConnected() {
      return this.connected;
    },
    async request(method, params) {
      requests.push({ method, params });
      const t = threads[params?.threadId];
      if (method === "thread/read") {
        if (!t) throw new AppServerError(`thread not found: ${params.threadId}`, { code: -32600 });
        return { thread: { id: params.threadId, status: { type: t.status }, path: t.path ?? null, ...(params.includeTurns ? { turns: t.turns ?? [] } : {}) } };
      }
      if (method === "turn/start") {
        if (failTurnStart) throw new AppServerError(failTurnStart, { code: -32603 });
        turn += 1;
        if (t) t.status = "active";
        return { turn: { id: `turn-${turn}`, status: "inProgress", items: [] } };
      }
      throw new AppServerError(`fake: ${method}`, { code: -32601 });
    },
    getConnectionSummary: () => ({ connected, managed: false })
  };
}

const starts = (/** @type {any} */ app) => app.requests.filter((r) => r.method === "turn/start");
const idle = (/** @type {string[]} */ ...ids) => {
  const tracker = makeThreadStatusTracker();
  for (const id of ids) tracker.observe({ method: "thread/status/changed", params: { threadId: id, status: { type: "idle" } } });
  return tracker;
};
function queue(mb, threadId, { body = "queued", anticipation = "fyi", ageMs = 10_000 } = {}) {
  const id = mb.insertMessage({ fromSessionId: SENDER, fromSessionKind: "codex", toSessionId: threadId, toSessionKind: "codex", body, metadata: { sender: { source: "runtime_context" } }, anticipation, sentAt: Date.now() - ageMs });
  return id;
}
const pending = (/** @type {any} */ row) => !row.delivered_at;

test("F1/F2: the background preflight reads the thread and checks held before any push", async () => {
  const box = tempMailbox();
  try {
    const mb = box.open();
    const a = queue(mb, T);
    const b = queue(mb, U);
    const app = fakeAppServer({ [T]: { status: "notLoaded" }, [U]: { status: "idle" } });
    // T: the tracker's idle record is stale (the endpoint restarted); U: never seen.
    const tracker = idle(T);
    const preflight = makeBackgroundPreflight({ appServer: app, tracker, sent: new Set() });
    const results = await pushQueuedCodexMail({ appServer: app, mailbox: mb, preflight, recipientOf: NO_ROLES, isPendingFor: pending });
    assert.deepEqual(Object.fromEntries(results.map((r) => [r.messageId, r.outcome])), { [a]: "held", [b]: "not_known_idle" });
    assert.equal(starts(app).length, 0, "no turn to a held or unseen thread");
    assert.deepEqual(app.requests.map((r) => [r.method, r.params.threadId]), [["thread/read", T]], "an unseen thread is not even read");
    assert.equal(tracker.get(T), null, "a held thread is forgotten");
  } finally {
    box.cleanup();
  }
});

test("F4: one background turn per thread per pass; an accepted turn marks the thread active", async () => {
  const box = tempMailbox();
  try {
    const mb = box.open();
    const first = queue(mb, T, { ageMs: 20_000 });
    queue(mb, T, { ageMs: 10_000 });
    queue(mb, T, { ageMs: 2 * 3_600_000 }); // older than an hour: left to the inbox
    const app = fakeAppServer({ [T]: { status: "idle" } });
    const tracker = idle(T);
    const preflight = makeBackgroundPreflight({ appServer: app, tracker, sent: new Set() });
    const results = await pushQueuedCodexMail({ appServer: app, mailbox: mb, preflight, recipientOf: NO_ROLES, isPendingFor: pending });
    assert.deepEqual(results.map((r) => [r.messageId, r.outcome]), [[first, "sent"]]);
    assert.equal(starts(app).length, 1);
    assert.equal(starts(app)[0].params.clientUserMessageId, first);
    assert.equal(tracker.isKnownIdle(T), false, "active until the endpoint says otherwise");
    assert.equal(mb.getMessage({ messageId: first }).delivered_via, "codex-turn");
    // A second pass before the turn ends sends nothing.
    const again = await pushQueuedCodexMail({ appServer: app, mailbox: mb, preflight: makeBackgroundPreflight({ appServer: app, tracker, sent: new Set() }), recipientOf: NO_ROLES, isPendingFor: pending });
    assert.deepEqual(again.map((r) => r.outcome), ["busy"]);
    assert.equal(starts(app).length, 1);
  } finally {
    box.cleanup();
  }
});

test("F4: a due reminder and a queued message for one thread give one turn per pass", async () => {
  const box = tempMailbox();
  try {
    const mb = box.open();
    const open = queue(mb, T, { anticipation: "reply", ageMs: 120_000 });
    mb.markDelivered({ messageId: open, deliveredAt: Date.now() - 100_000 });
    queue(mb, T, { ageMs: 10_000 });
    const app = fakeAppServer({ [T]: { status: "idle" } });
    const delivery = makeCodexDelivery({ appServer: app, tracker: idle(T), mailboxOpener: box.open, mailboxExists: () => true, settings: SETTINGS });
    const result = await delivery.pass();
    assert.deepEqual(result.reminders.map((r) => r.outcome), ["sent"]);
    assert.deepEqual(result.pushed.map((r) => r.outcome), ["turn_sent_this_pass"]);
    assert.equal(starts(app).length, 1, "the queued message waits for the next pass");
  } finally {
    box.cleanup();
  }
});

test("F2: no pass without a connected endpoint, and none touches unseen threads; F1: endpoint changes clear the tracker", async () => {
  const box = tempMailbox();
  try {
    const mb = box.open();
    queue(mb, T);
    const app = fakeAppServer({ [T]: { status: "idle" } }, { connected: false });
    const tracker = idle(T);
    const delivery = makeCodexDelivery({ appServer: app, tracker, mailboxOpener: box.open, mailboxExists: () => true, settings: SETTINGS });
    assert.deepEqual(await delivery.pass(), { skipped: "not_connected" });
    assert.equal(app.requests.length, 0, "never connects (never starts a managed app-server)");
    delivery.onConnectionChange("closed");
    assert.equal(tracker.size, 0);
    app.connected = true;
    const result = await delivery.pass();
    assert.deepEqual(result, { claims: [] });
    assert.equal(app.requests.length, 0, "an empty tracker makes no requests, so the endpoint can idle out");
    // Notifications feed the tracker; then the pass delivers.
    delivery.onNotification({ method: "turn/completed", params: { threadId: T, turn: { id: "x", status: "completed", items: [] } } });
    const after = await delivery.pass();
    assert.deepEqual(after.pushed.map((r) => r.outcome), ["sent"]);
    delivery.stop();
  } finally {
    box.cleanup();
  }
});

test("confirmDelivery marks a pushed message delivered from its clientId, only for its own thread", () => {
  const box = tempMailbox();
  try {
    const mb = box.open();
    const id = queue(mb, T);
    assert.equal(confirmDelivery({ threadId: U, messageId: id }, { mailboxOpener: box.open, mailboxExists: () => true }), false);
    assert.equal(confirmDelivery({ threadId: T, messageId: id }, { mailboxOpener: box.open, mailboxExists: () => true }), true);
    assert.equal(mb.getMessage({ messageId: id }).delivered_via, "codex-turn");
    assert.equal(confirmDelivery({ threadId: T, messageId: id }, { mailboxOpener: box.open, mailboxExists: () => true }), false, "once");
    assert.equal(confirmDelivery({ threadId: T, messageId: id }, { mailboxOpener: box.open, mailboxExists: () => false }), false);
  } finally {
    box.cleanup();
  }
});

test("F10: a failed push checks the thread for its clientId before releasing the claim", async () => {
  const box = tempMailbox();
  try {
    const mb = box.open();
    // Found: the push reached the thread; delivered, claim kept.
    const reached = queue(mb, T);
    let app = fakeAppServer({ [T]: { status: "idle", turns: [{ id: "tr", items: [{ type: "userMessage", id: "u", clientId: reached }] }] } }, { failTurnStart: "timeout" });
    const tracker = idle(T);
    let push = await pushCodexMessage({ appServer: app, mailbox: mb, messageId: reached, threadId: T, text: "x", plan: "start", tracker });
    assert.equal(push.delivery, "delivered");
    assert.ok(push.warnings.some((w) => w.code === "codex_push_response_lost"));
    assert.ok(mb.listClaims().includes(pushClaimKey(reached)));
    assert.equal(tracker.isKnownIdle(T), false);
    // Not found: released for a retry.
    const lost = queue(mb, U);
    app = fakeAppServer({ [U]: { status: "idle", turns: [] } }, { failTurnStart: "boom" });
    push = await pushCodexMessage({ appServer: app, mailbox: mb, messageId: lost, threadId: U, text: "x", plan: "start" });
    assert.equal(push.delivery, "queued");
    assert.ok(!mb.listClaims().includes(pushClaimKey(lost)));
    // Unreadable: the claim stays until the stale-claim sweep can check.
    const unknown = queue(mb, U);
    app = fakeAppServer({}, { failTurnStart: "boom" });
    push = await pushCodexMessage({ appServer: app, mailbox: mb, messageId: unknown, threadId: U, text: "x", plan: "start" });
    assert.equal(push.delivery, "queued");
    assert.ok(mb.listClaims().includes(pushClaimKey(unknown)));
    assert.equal(push.warnings[0].details.verified, false);
  } finally {
    box.cleanup();
  }
});

test("F10: stale push claims are settled from the thread: delivered, released, or kept", async () => {
  const box = tempMailbox();
  try {
    const mb = box.open();
    const seen = queue(mb, T);
    const unseen = queue(mb, U);
    const fresh = queue(mb, U);
    for (const id of [seen, unseen, fresh]) assert.ok(mb.claim(pushClaimKey(id)));
    const old = (Date.now() - 600_000) / 1000;
    for (const id of [seen, unseen]) utimesSync(path.join(`${box.mailboxPath}.claims`, pushClaimKey(id)), old, old);
    const app = fakeAppServer({ [T]: { status: "idle", turns: [{ id: "tr", items: [{ type: "userMessage", clientId: seen }] }] }, [U]: { status: "idle", turns: [] } });
    const results = await sweepStalePushClaims({ appServer: app, mailbox: mb, recipientOf: NO_ROLES });
    assert.deepEqual(Object.fromEntries(results.map((r) => [r.messageId, r.outcome])), { [seen]: "delivered", [unseen]: "released" });
    assert.ok(mb.getMessage({ messageId: seen }).delivered_at);
    assert.ok(!mb.listClaims().includes(pushClaimKey(unseen)));
    assert.ok(mb.listClaims().includes(pushClaimKey(fresh)), "a fresh claim is left alone");
  } finally {
    box.cleanup();
  }
});

test("F6: a thread whose transcript another process has open is held; lsof problems never block", async () => {
  assert.deepEqual(parseLsofFields("p100\ng100\nfcwd\np200\ng300\n"), [{ pid: 100, pgid: 100 }, { pid: 200, pgid: 300 }]);
  const fakeRun = (/** @type {any} */ outcome) => (/** @type {any} */ _f, /** @type {any} */ _a, /** @type {any} */ _o, /** @type {any} */ cb) => cb(outcome.error ?? null, outcome.stdout ?? "");
  const own = () => 100;
  assert.deepEqual(await makeRolloutCheck({ ownProcessGroup: own, run: fakeRun({ stdout: "p101\ng100\n" }), selfPid: 1 })("/r.jsonl"), { held: false, checked: true }, "our own endpoint's group");
  assert.equal((await makeRolloutCheck({ ownProcessGroup: own, run: fakeRun({ stdout: "p101\ng100\np555\ng555\n" }), selfPid: 1 })("/r.jsonl")).held, true);
  assert.deepEqual(await makeRolloutCheck({ ownProcessGroup: own, run: fakeRun({ error: { code: 1 }, stdout: "" }), selfPid: 1 })("/r.jsonl"), { held: false, checked: true });
  assert.equal((await makeRolloutCheck({ ownProcessGroup: own, run: fakeRun({ error: { code: "ENOENT" } }), selfPid: 1 })("/r.jsonl")).checked, false);
  assert.equal((await makeRolloutCheck({ ownProcessGroup: () => null, run: fakeRun({ stdout: "p555\n" }) })("/r.jsonl")).reason, "endpoint_pid_unknown");
  assert.equal((await makeRolloutCheck({ ownProcessGroup: own, run: fakeRun({ stdout: "p555\n" }) })(null)).reason, "no_rollout_path");
  // In a push: nothing is claimed or sent, and the message stays queued.
  const box = tempMailbox();
  try {
    const mb = box.open();
    const id = queue(mb, T);
    const app = fakeAppServer({ [T]: { status: "idle" } });
    const push = await pushCodexMessage({ appServer: app, mailbox: mb, messageId: id, threadId: T, text: "x", plan: "start", rolloutPath: "/r.jsonl", rolloutCheck: async () => ({ held: true, checked: true }) });
    assert.equal(push.delivery, "queued");
    assert.equal(push.warnings[0].details.signal, "rollout-open-elsewhere");
    assert.equal(starts(app).length, 0);
    assert.equal(mb.listClaims().length, 0);
    // And in the foreground send path, from thread/read's `path`.
    const messaging = makeThreadMessaging({
      appServer: /** @type {any} */ ({ ...app, async request(method, params) { if (method === "thread/read") return { thread: { id: T, status: { type: "idle" }, path: "/desk/rollout.jsonl", cwd: "/w", model: "m" } }; return app.request(method, params); } }),
      host: "codex",
      resolveCurrentSession: () => null,
      queries: makeThreadQueries({ appServer: /** @type {any} */ (app) }),
      mailboxOpener: box.open,
      rolloutCheck: async (p) => ({ held: p === "/desk/rollout.jsonl", checked: true })
    });
    const result = await messaging.messageThread({ threadId: T, message: "hi", receipt: { record: false } }, { callerContext: { threadId: SENDER } });
    assert.equal(result.delivery, "queued");
    assert.equal(starts(app).length, 0);
  } finally {
    box.cleanup();
  }
});

test("F5: shared-daemon is refused unless the endpoint is explicit", () => {
  const refused = desktopPushPolicy({ AGENT_LINK_CODEX_DESKTOP_PUSH: "shared-daemon" });
  assert.equal(refused.mode, "mailbox-only");
  assert.equal(refused.refused, "shared-daemon");
  assert.equal(refused.isHeld({ type: "notLoaded" }), true);
  assert.ok(desktopPushReport({ AGENT_LINK_CODEX_DESKTOP_PUSH: "shared-daemon" }).warnings.some((w) => w.code === "desktop_push_override_refused"));
  const explicit = desktopPushPolicy({ AGENT_LINK_CODEX_DESKTOP_PUSH: "shared-daemon", AGENT_LINK_CODEX_SOCK: "/tmp/x.sock" });
  assert.equal(explicit.mode, "shared-daemon");
  assert.equal(explicit.refused, null);
  assert.ok(desktopPushReport({ AGENT_LINK_CODEX_DESKTOP_PUSH: "shared-daemon", AGENT_LINK_CODEX_URL: "ws://127.0.0.1:1" }).warnings.some((w) => w.code === "desktop_push_unverified"));
  assert.equal(desktopPushPolicy({}).mode, "mailbox-only");
});

test("F7: a message wait shows status only to the message's sender", async () => {
  const box = tempMailbox();
  try {
    const mb = box.open();
    const id = queue(mb, T, { anticipation: "reply" });
    const asOther = await pollMessageResolution(mb, { messageId: id, fromIds: [T], toIds: [U], timeoutMs: 0, settings: SETTINGS });
    assert.deepEqual([asOther.outcome, asOther.messageStatus], ["timeout", null]);
    const asSender = await pollMessageResolution(mb, { messageId: id, fromIds: [T], toIds: [SENDER], timeoutMs: 0, settings: SETTINGS });
    assert.deepEqual([asSender.outcome, asSender.messageStatus], ["timeout", "pending"]);
  } finally {
    box.cleanup();
  }
});

test("F11: \"no rollout found\" is already_archived only for a thread that exists", async () => {
  const noRollout = () => { throw new AppServerError("no rollout found for thread id x", { code: -32600 }); };
  const appFor = (/** @type {any} */ read) => ({
    requests: [],
    async request(/** @type {string} */ method, /** @type {any} */ params) {
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/read") return read(params);
      if (method === "thread/archive") return noRollout();
      throw new AppServerError(`fake: ${method}`, { code: -32601 });
    },
    getConnectionSummary: () => ({ connected: true, managed: false, codexHome: null })
  });
  const actionsFor = (/** @type {any} */ app) => makeThreadActions({ appServer: app, messaging: /** @type {any} */ ({ sendToThread: async () => { throw new Error("unused"); }, recordActionReceipt: async () => ({ recorded: false }) }), desktop: /** @type {any} */ ({}) });
  const missing = actionsFor(appFor(() => { throw new AppServerError("thread not found", { code: -32600 }); }));
  await assert.rejects(missing.archiveThread({ threadId: T, receipt: { record: false } }), (error) => error.errorCode === "not_found");
  const archived = actionsFor(appFor(() => ({ thread: { id: T, status: { type: "notLoaded" }, path: "/x/archived_sessions/rollout.jsonl" } })));
  const result = await archived.archiveThread({ threadId: T, receipt: { record: false } });
  assert.equal(result.action, "already_archived");
});

test("N1: the stale-claim sweep rotates, gives up on unreadable claims, and then makes no requests", async () => {
  const box = tempMailbox();
  try {
    const mb = box.open();
    const { makePushClaimSweepState } = await import("../../src/delivery/codex-push.js");
    const old = (Date.now() - 600_000) / 1000;
    const stale = (/** @type {string} */ id) => {
      assert.ok(mb.claim(pushClaimKey(id)));
      utimesSync(path.join(`${box.mailboxPath}.claims`, pushClaimKey(id)), old, old);
    };
    // 20 claims on an unreadable thread (sorted first), one on a readable one.
    const stuck = Array.from({ length: 20 }, () => queue(mb, "019d9300-0000-7000-8000-0000000000ff"));
    for (const id of stuck) stale(id);
    const later = queue(mb, U);
    stale(later);
    // A message outside the one-hour push window is abandoned without a read.
    const ancient = queue(mb, T, { ageMs: 2 * 3_600_000 });
    stale(ancient);
    const app = fakeAppServer({ [U]: { status: "idle", turns: [] } });
    const state = makePushClaimSweepState();
    const abandoned = [];
    const sweep = () => sweepStalePushClaims({ appServer: app, mailbox: mb, recipientOf: NO_ROLES, state, onAbandon: (info) => abandoned.push(info) });
    let first = await sweep();
    assert.equal(first.filter((r) => r.outcome === "kept").length, 20, "max applies after filtering");
    assert.deepEqual(first.filter((r) => r.messageId === ancient).map((r) => r.outcome), ["abandoned"]);
    first = await sweep();
    assert.ok(first.some((r) => r.messageId === later && r.outcome === "released"), "rotation reaches the readable claim on the next pass");
    for (let pass = 0; pass < 6; pass += 1) await sweep();
    assert.equal(abandoned.filter((a) => a.reason === "unreadable").length, 20);
    assert.deepEqual(abandoned.filter((a) => a.reason === "outside_push_window").map((a) => a.messageId), [ancient]);
    const before = app.requests.length;
    assert.deepEqual(await sweep(), []);
    assert.equal(app.requests.length, before, "nothing left to settle: no request, so an idle endpoint can shut down");
    assert.ok(mb.listClaims().includes(pushClaimKey(stuck[0])), "an abandoned claim stays: the message is never pushed again");
  } finally {
    box.cleanup();
  }
});

test("N1: background passes with stale unreadable claims stop making requests", async () => {
  const box = tempMailbox();
  try {
    const mb = box.open();
    const id = queue(mb, "019d9300-0000-7000-8000-0000000000fe");
    assert.ok(mb.claim(pushClaimKey(id)));
    const old = (Date.now() - 600_000) / 1000;
    utimesSync(path.join(`${box.mailboxPath}.claims`, pushClaimKey(id)), old, old);
    const app = fakeAppServer({});
    const delivery = makeCodexDelivery({ appServer: app, mailboxOpener: box.open, mailboxExists: () => true, settings: SETTINGS });
    for (let pass = 0; pass < 5; pass += 1) await delivery.pass();
    const before = app.requests.length;
    assert.equal(before, 5, "one read per pass until it gives up");
    await delivery.pass();
    await delivery.pass();
    assert.equal(app.requests.length, before, "no request keeps the endpoint's idle timer from firing");
  } finally {
    box.cleanup();
  }
});

test("F6 follow-up: lsof by absolute path on darwin, skips counted, first skip logged once", async () => {
  const calls = [];
  const logged = [];
  const logger = { warn: (/** @type {string} */ event, /** @type {any} */ data) => logged.push([event, data.reason]) };
  const run = (/** @type {string} */ file, /** @type {any} */ _a, /** @type {any} */ _o, /** @type {any} */ cb) => {
    calls.push(file);
    cb({ killed: true, signal: "SIGTERM" }, "");
  };
  const check = makeRolloutCheck({ ownProcessGroup: () => 100, run, platform: "darwin", lsofPath: "/usr/sbin/lsof", logger });
  assert.equal((await check("/r.jsonl")).reason, "lsof_timeout");
  assert.equal((await check(null)).reason, "no_rollout_path");
  assert.deepEqual(calls, ["/usr/sbin/lsof"]);
  assert.deepEqual(check.stats(), { checked: 0, held: 0, skipped: { lsof_timeout: 1, no_rollout_path: 1 } });
  assert.deepEqual(logged, [["rollout_check.skipped", "lsof_timeout"]], "only the first skip is logged");
  const linux = [];
  await makeRolloutCheck({ ownProcessGroup: () => 100, run: (file, _a, _o, cb) => { linux.push(file); cb(null, "p555\ng555\n"); }, platform: "linux", logger })("/r.jsonl").then((r) => assert.equal(r.held, true));
  assert.deepEqual(linux, ["lsof"]);
});

test("shutdown stops background Codex delivery: timers cleared, listeners removed", async () => {
  const { createLifecycle } = await import("../../src/server/lifecycle.js");
  const { startCodexDelivery } = await import("../../src/delivery/codex-delivery.js");
  const listeners = { notification: 0, connection: 0 };
  const app = {
    ...fakeAppServer({}),
    onNotification: () => {
      listeners.notification += 1;
      return () => { listeners.notification -= 1; };
    },
    onConnectionChange: () => {
      listeners.connection += 1;
      return () => { listeners.connection -= 1; };
    }
  };
  const delivery = startCodexDelivery({ appServer: app, mailboxExists: () => false, settings: SETTINGS });
  assert.deepEqual(listeners, { notification: 1, connection: 1 });
  let forkSweepStopped = 0;
  const lifecycle = createLifecycle({ appServer: { close: async () => {}, killManagedSync: () => {} }, exit: () => {} });
  // As src/server/index.js wires both background loops.
  lifecycle.onShutdown(() => delivery.stop());
  lifecycle.onShutdown(() => { forkSweepStopped += 1; });
  await lifecycle.shutdown(0);
  assert.deepEqual(listeners, { notification: 0, connection: 0 });
  assert.equal(forkSweepStopped, 1);
});
