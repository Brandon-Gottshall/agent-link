// Role handover (design R7.20, T-7.9): an open message sent through
// role:<name> follows the role when it moves to another session. The new
// holder sees it, is reminded (the count carries over, the cap holds), and
// may resolve it; the previous holder no longer can. Stored lines are never
// rewritten. Temp state, injected clocks.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-role-handover-"));
process.env.AGENT_LINK_RECEIPT_LOG = path.join(tmp, "receipts.jsonl");
for (const name of ["AGENT_LINK_REMINDER_LIMIT", "AGENT_LINK_REMINDER_INTERVAL_MS", "CODEX_AGENT_LINK_RECEIPT_LOG"]) delete process.env[name];

const { openMailbox } = await import("../../src/claude/mailbox.js");
const { createRoleStore } = await import("../../src/registry/roles.js");
const { makeClaudeSendHandler } = await import("../../src/tools/claude-send.js");
const { makeReplyAgentLinkMessageHandler } = await import("../../src/tools/claude-reply.js");
const { makeWaitHandler } = await import("../../src/tools/claude-wait.js");
const { makeReadInboxHandler } = await import("../../src/tools/read-inbox.js");
const { makeMessageStatusHandler } = await import("../../src/tools/message-status.js");
const { makeAgentLinkChannelBridge } = await import("../../src/claude/channel-bridge.js");
const { runNotifyHook } = await import("../../src/claude/notify-hook.js");
const { deliverCodexReminders, lastStopBlockAt } = await import("../../src/delivery/reminders.js");
const { handedOverTo, recipientMatcher, roleRoute } = await import("../../src/delivery/role-handover.js");
const { messageStatus } = await import("../../src/delivery/message-status.js");
const { AgentLinkError } = await import("../../src/shared/errors.js");

const uuid = (n) => `7b000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const session = (n, title) => ({ sessionId: `local_${uuid(n)}`, cliSessionId: uuid(n), surface: "code", loaded: true, title });
const SENDER = session(1, "Sender");
const FIRST = session(2, "First holder");
const SECOND = session(3, "Second holder");
const THIRD = session(4, "Third holder");
const SESSIONS = [SENDER, FIRST, SECOND, THIRD];
const addr = (s) => `claude:${s.cliSessionId}`;
const SETTINGS = { limit: 3, intervalMs: 30_000, warnings: [] };
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const CODEX_THREAD = "019d9000-0000-7000-8000-0000000000c1";

let n = 0;
function fixture() {
  n += 1;
  const dir = path.join(tmp, `case-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const env = { HOME: dir, AGENT_LINK_STATE_DIR: path.join(dir, "state") };
  const roles = createRoleStore({ env, homedir: dir });
  roles.set({ role: "lead", address: addr(FIRST) });
  return { mailboxPath: path.join(dir, "mailbox.jsonl"), roles };
}

function tools({ mailboxPath, roles }, as, { now = () => Date.now() } = {}) {
  const deps = {
    host: "claude",
    listSessions: () => SESSIONS,
    mailboxOpener: () => openMailbox({ mailboxPath }),
    resolveCurrentSession: () => as,
    now,
    reminderSettings: () => SETTINGS,
    roles
  };
  return {
    send: makeClaudeSendHandler(deps).message_claude_session,
    reply: makeReplyAgentLinkMessageHandler(deps).reply_agent_link_message,
    wait: makeWaitHandler({ ...deps, pollIntervalMs: 20 }).wait_for_claude_session,
    inbox: makeReadInboxHandler(deps).read_agent_link_inbox,
    status: makeMessageStatusHandler(deps)
  };
}

function withMailbox(mailboxPath, fn) {
  const mb = openMailbox({ mailboxPath });
  try {
    return fn(mb);
  } finally {
    mb.close();
  }
}

const row = (mailboxPath, messageId) => withMailbox(mailboxPath, (mb) => mb.getMessage({ messageId }));

// What message_claude_session writes for sessionId "role:lead" held by
// FIRST, optionally delivered at T0.
function roleMessage(mailboxPath, { anticipation = "reply", delivered = true, role = "lead", heldBy = FIRST } = {}) {
  return withMailbox(mailboxPath, (mb) => {
    const id = mb.insertMessage({
      fromSessionId: SENDER.sessionId,
      fromSessionKind: "claude",
      toSessionId: heldBy.sessionId,
      toSessionKind: "claude",
      body: "Please review the release notes.",
      metadata: { sender: { source: "current_session" }, role: { via: `role:${role}`, address: addr(heldBy), procedure: null } },
      anticipation
    });
    if (delivered) mb.markDelivered({ messageId: id, deliveredAt: T0 });
    return id;
  });
}

function hook({ mailboxPath, roles }, as, event, now, { table = () => roles.read().table, extra = {} } = {}) {
  return runNotifyHook(
    { session_id: as.cliSessionId, hook_event_name: event, ...extra },
    { resolveSession: () => as, mailboxOpener: () => openMailbox({ mailboxPath }), log: () => {}, now: () => now, settings: SETTINGS, roleTable: table }
  );
}

const reminderText = (output) => output?.hookSpecificOutput?.additionalContext ?? output?.reason ?? null;

const rejectsWith = (promise, code) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof AgentLinkError, String(error));
  assert.equal(error.errorCode, code, error.message);
  return true;
});

test("send through a role records the holder at send time; nothing moves until the role does", async () => {
  const fx = fixture();
  const { send } = tools(fx, SENDER);
  const sent = await send({ sessionId: "role:lead", message: "Ship it?", anticipation: "reply" });
  assert.equal(sent.via, "role:lead");
  const stored = row(fx.mailboxPath, sent.messageId);
  assert.deepEqual(roleRoute(stored), { name: "lead", via: "role:lead", sentTo: addr(FIRST) });
  assert.equal(handedOverTo(stored, fx.roles.read().table), null, "same holder: no handover");
  fx.roles.set({ role: "lead", address: addr(SECOND) });
  assert.equal(handedOverTo(stored, fx.roles.read().table), addr(SECOND));
  const line = fs.readFileSync(fx.mailboxPath, "utf8");
  fx.roles.set({ role: "lead", address: addr(FIRST) });
  assert.equal(handedOverTo(row(fx.mailboxPath, sent.messageId), fx.roles.read().table), null, "moved back: the first holder again");
  assert.equal(fs.readFileSync(fx.mailboxPath, "utf8"), line, "a role change writes nothing to the mailbox");
});

test("T-7.9: the new holder sees the open message; the previous holder does not", async () => {
  const fx = fixture();
  const id = roleMessage(fx.mailboxPath);
  const fyi = roleMessage(fx.mailboxPath, { anticipation: "fyi", delivered: false });
  fx.roles.set({ role: "lead", address: addr(SECOND) });

  const first = await tools(fx, FIRST).inbox({ markAsDelivered: false });
  assert.deepEqual(first.messages.map((m) => m.id), [fyi], "the first holder keeps only the fyi message, which never moves");
  const second = await tools(fx, SECOND).inbox({ markAsDelivered: false });
  assert.deepEqual(second.messages.map((m) => [m.id, m.open]), [[id, true]]);
  assert.match(second.renderedBlock, /Please review the release notes/);

  // Cleared role: nobody holds it, so the message stays with its stored recipient.
  fx.roles.clear("lead");
  assert.deepEqual((await tools(fx, FIRST).inbox({ markAsDelivered: false })).messages.map((m) => m.id).sort(), [fyi, id].sort());
  assert.equal((await tools(fx, SECOND).inbox({ markAsDelivered: false })).messages.length, 0);
});

test("T-7.9: a message still queued at handover is new mail for the new holder (hook notice, inbox, channel)", async () => {
  const fx = fixture();
  const id = roleMessage(fx.mailboxPath, { delivered: false });
  fx.roles.set({ role: "lead", address: addr(SECOND) });

  assert.deepEqual(hook(fx, FIRST, "UserPromptSubmit", T0), {}, "no notice for the previous holder");
  assert.match(reminderText(hook(fx, SECOND, "UserPromptSubmit", T0)), /1 pending peer message/);

  const pushed = [];
  const bridge = (as) => makeAgentLinkChannelBridge({
    resolveCurrentSession: () => as,
    mailboxOpener: () => openMailbox({ mailboxPath: fx.mailboxPath }),
    mailboxPath: fx.mailboxPath,
    roles: fx.roles,
    watch: false,
    notify: async (notification) => { pushed.push([as.cliSessionId, notification.params.meta?.message_id ?? notification.params.meta?.messageId]); }
  });
  assert.equal((await bridge(FIRST).pollOnce({ force: true })).delivered, 0);
  assert.equal((await bridge(SECOND).pollOnce({ force: true })).delivered, 1);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0][0], SECOND.cliSessionId);
  assert.ok(row(fx.mailboxPath, id).delivered_at);
});

test("T-7.9: reminders go to the new holder only, the count carries over, and the cap holds", () => {
  const fx = fixture();
  const id = roleMessage(fx.mailboxPath);
  assert.match(reminderText(hook(fx, FIRST, "UserPromptSubmit", T0 + 30_000)), /reminder 1 of 3/);
  fx.roles.set({ role: "lead", address: addr(SECOND) });

  assert.deepEqual(hook(fx, FIRST, "UserPromptSubmit", T0 + 60_000), {}, "the previous holder stops receiving reminders");
  assert.deepEqual(hook(fx, FIRST, "Stop", T0 + 60_001), {}, "and its Stop hook never blocks for it");
  assert.match(reminderText(hook(fx, SECOND, "UserPromptSubmit", T0 + 60_000)), /reminder 2 of 3/);
  assert.match(reminderText(hook(fx, SECOND, "Stop", T0 + 90_000)), /reminder 3 of 3/);
  assert.deepEqual(hook(fx, SECOND, "UserPromptSubmit", T0 + 120_000), {}, "capped");

  const reminders = row(fx.mailboxPath, id).reminders;
  assert.deepEqual(reminders.map((r) => [r.n, r.to]), [[1, addr(FIRST)], [2, addr(SECOND)], [3, addr(SECOND)]]);
  assert.equal(messageStatus(row(fx.mailboxPath, id), { now: T0 + 120_000, settings: SETTINGS }).status, "unresolved");
});

test("T-7.9 concurrency: a role change inside the reminder window, and holders racing on stale tables", () => {
  const fx = fixture();
  const id = roleMessage(fx.mailboxPath);
  const before = fx.roles.read().table;
  assert.match(reminderText(hook(fx, FIRST, "UserPromptSubmit", T0 + 30_000)), /reminder 1 of 3/);
  // The role moves 10 s into the interval: the new holder waits for the
  // interval that started with the previous holder's reminder.
  fx.roles.set({ role: "lead", address: addr(SECOND) });
  assert.deepEqual(hook(fx, SECOND, "UserPromptSubmit", T0 + 40_000), {});
  // Both holders' hooks run at the same instant once it is due; the first
  // holder's hook still read the table from before the move. Exactly one
  // reminder is recorded (claim before notify).
  const outputs = [
    hook(fx, FIRST, "UserPromptSubmit", T0 + 60_000, { table: () => before }),
    hook(fx, SECOND, "UserPromptSubmit", T0 + 60_000)
  ];
  assert.equal(outputs.filter((output) => reminderText(output)).length, 1);
  assert.deepEqual(row(fx.mailboxPath, id).reminders.map((r) => r.n), [1, 2]);
});

test("T-7.9: the new holder resolves; the previous holder gets wrong_recipient; the sender's status and wait follow", async () => {
  const fx = fixture();
  const { send, wait, status } = tools(fx, SENDER);
  const sent = await send({ sessionId: "role:lead", message: "Approve the release?", anticipation: "reply" });
  await tools(fx, FIRST).inbox({});
  fx.roles.set({ role: "lead", address: addr(SECOND) });

  await rejectsWith(tools(fx, FIRST).reply({ messageId: sent.messageId, message: "yes" }), "wrong_recipient");
  const open = await status({ messageId: sent.messageId });
  assert.equal(open.status, "pending");
  assert.equal(open.via, "role:lead");
  assert.equal(open.holder, addr(SECOND));
  const holderView = await tools(fx, SECOND).status({ messageId: sent.messageId });
  assert.equal(holderView.holder, addr(SECOND), "the new holder may read the status");

  const waiting = wait({ sessionId: FIRST.sessionId, replyToMessageId: sent.messageId, timeoutMs: 5_000 });
  const replied = await tools(fx, SECOND).reply({ messageId: sent.messageId, message: "Approved." });
  assert.equal(replied.status, "replied");
  const done = await waiting;
  assert.equal(done.outcome, "reply");
  assert.match(done.reply.message ?? JSON.stringify(done.reply), /Approved\./);

  const resolved = await status({ messageId: sent.messageId });
  assert.equal(resolved.status, "replied");
  assert.equal(resolved.resolution.by, addr(SECOND), "the resolver's address is recorded in by");
  assert.equal(resolved.holder, addr(SECOND), "the holder that resolved it");
  await rejectsWith(tools(fx, SECOND).reply({ messageId: sent.messageId, resolution: "done" }), "already_resolved");
  // Resolved: a later role change moves it no further.
  fx.roles.set({ role: "lead", address: addr(THIRD) });
  assert.equal((await status({ messageId: sent.messageId })).holder, addr(SECOND));
  await rejectsWith(tools(fx, THIRD).reply({ messageId: sent.messageId, resolution: "done" }), "wrong_recipient");
});

test("previous holders' Stop blocks do not gate the new holder (reminder `to`)", () => {
  const rows = [{ reminders: [{ n: 1, via: "claude-stop-hook", at: T0, to: addr(FIRST) }, { n: 2, via: "claude-stop-hook", at: T0 + 5, to: addr(SECOND) }] }];
  assert.equal(lastStopBlockAt(rows, [SECOND.cliSessionId]), T0 + 5);
  assert.equal(lastStopBlockAt(rows, [uuid(9)]), null);
  assert.equal(lastStopBlockAt([{ reminders: [{ n: 1, via: "claude-stop-hook", at: T0 }] }], [uuid(9)]), T0, "older reminders without `to` still count");
});

test("recipientMatcher: stored recipient unless handed over; unreadable tables hand nothing over", () => {
  const fx = fixture();
  const id = roleMessage(fx.mailboxPath);
  const stored = row(fx.mailboxPath, id);
  fx.roles.set({ role: "lead", address: addr(SECOND) });
  const table = fx.roles.read().table;
  assert.equal(recipientMatcher({ aliases: [FIRST.sessionId, FIRST.cliSessionId], table })(stored), false);
  assert.equal(recipientMatcher({ aliases: [SECOND.sessionId, SECOND.cliSessionId], table })(stored), true);
  assert.equal(recipientMatcher({ aliases: [FIRST.sessionId], table: null })(stored), true);
  const legacy = { ...stored, metadata_json: JSON.stringify({ role: { via: "role:lead" } }) };
  assert.equal(handedOverTo(legacy, table), null, "no recorded holder (sent before handover existed): never moves");
});

test("handover to a Codex holder: the reminder turn goes to that thread", async () => {
  const fx = fixture();
  const id = roleMessage(fx.mailboxPath);
  fx.roles.set({ role: "lead", address: `codex:${CODEX_THREAD}` });
  const requests = [];
  const appServer = {
    request: async (method, params) => {
      requests.push([method, params.threadId]);
      return method === "thread/read" ? { thread: { status: { type: "idle" } } } : {};
    }
  };
  const results = await withMailbox(fx.mailboxPath, (mailbox) => deliverCodexReminders({ appServer, mailbox, now: T0 + 30_000, settings: SETTINGS, roleTable: fx.roles.read().table }));
  assert.deepEqual(results.map((r) => [r.threadId, r.outcome]), [[CODEX_THREAD, "sent"]]);
  assert.deepEqual(requests, [["thread/read", CODEX_THREAD], ["turn/start", CODEX_THREAD]]);
  assert.deepEqual(row(fx.mailboxPath, id).reminders.map((r) => [r.n, r.to]), [[1, `codex:${CODEX_THREAD}`]]);
  assert.deepEqual(hook(fx, FIRST, "UserPromptSubmit", T0 + 60_000), {}, "the Claude previous holder is not reminded");
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
