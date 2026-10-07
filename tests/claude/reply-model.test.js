// Design doc section 7 (B7a): message labels, explicit replies, resolution,
// re-surfacing, and the sender view. Tests T-7.1 to T-7.8 and T-7.10 for the
// Claude side; Codex reminder turns are in tests/codex/reminder-turns.test.js.
// Everything runs on temp files with an injected clock where timing matters.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-reply-model-"));
process.env.AGENT_LINK_RECEIPT_LOG = path.join(tmp, "receipts.jsonl");
for (const name of ["AGENT_LINK_REMINDER_LIMIT", "AGENT_LINK_REMINDER_INTERVAL_MS", "CODEX_AGENT_LINK_RECEIPT_LOG"]) delete process.env[name];

const { openMailbox } = await import("../../src/claude/mailbox.js");
const { makeClaudeSendHandler } = await import("../../src/tools/claude-send.js");
const { makeReplyAgentLinkMessageHandler } = await import("../../src/tools/claude-reply.js");
const { makeWaitHandler } = await import("../../src/tools/claude-wait.js");
const { makeReadInboxHandler } = await import("../../src/tools/read-inbox.js");
const { makeMessageStatusHandler } = await import("../../src/tools/message-status.js");
const { makeAgentLinkChannelBridge } = await import("../../src/claude/channel-bridge.js");
const { runNotifyHook } = await import("../../src/claude/notify-hook.js");
const { messageStatus, reminderSettings, resolveLabels } = await import("../../src/delivery/message-status.js");
const { claimReminders, dueReminders, takeStopSlot } = await import("../../src/delivery/reminders.js");
const { sweepClaims } = await import("../../src/delivery/message-wait.js");
const { healthExtras } = await import("../../src/tools/health.js");
const { listReceipts } = await import("../../src/shared/receipt-index.js");
const { AgentLinkError } = await import("../../src/shared/errors.js");

const uuid = (n) => `7a000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const session = (n, title) => ({ sessionId: `local_${uuid(n)}`, cliSessionId: uuid(n), surface: "code", loaded: true, title });
const SENDER = session(1, "Sender");
const RECEIVER = session(2, "Receiver");
const THIRD = session(3, "Third");
const SESSIONS = [SENDER, RECEIVER, THIRD];
const addr = (s) => `claude:${s.cliSessionId}`;
const SETTINGS = { limit: 3, intervalMs: 30_000, warnings: [] };
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

let n = 0;
function newMailbox() {
  n += 1;
  return path.join(tmp, `mailbox-${n}.jsonl`);
}

function tools(mailboxPath, as, { now = () => Date.now(), settings = SETTINGS } = {}) {
  const deps = {
    host: "claude",
    listSessions: () => SESSIONS,
    mailboxOpener: () => openMailbox({ mailboxPath }),
    resolveCurrentSession: () => as,
    now,
    reminderSettings: () => settings
  };
  return {
    send: makeClaudeSendHandler(deps).message_claude_session,
    reply: makeReplyAgentLinkMessageHandler(deps).reply_agent_link_message,
    wait: makeWaitHandler({ ...deps, pollIntervalMs: 20 }).wait_for_claude_session,
    inbox: makeReadInboxHandler(deps).read_agent_link_inbox,
    status: makeMessageStatusHandler(deps)
  };
}

function row(mailboxPath, messageId) {
  const mb = openMailbox({ mailboxPath });
  try {
    return mb.getMessage({ messageId });
  } finally {
    mb.close();
  }
}

function hook(mailboxPath, event, now, extra = {}) {
  return runNotifyHook(
    { session_id: RECEIVER.cliSessionId, hook_event_name: event, ...extra },
    { resolveSession: () => RECEIVER, mailboxOpener: () => openMailbox({ mailboxPath }), log: () => {}, now: () => now, settings: SETTINGS }
  );
}

// A delivered anticipating message from SENDER to RECEIVER, delivered at T0.
function deliveredMessage(mailboxPath, { anticipation = "reply", replyBy = null, at = T0 } = {}) {
  const mb = openMailbox({ mailboxPath });
  try {
    const id = mb.insertMessage({
      fromSessionId: SENDER.sessionId,
      fromSessionKind: "claude",
      toSessionId: RECEIVER.sessionId,
      toSessionKind: "claude",
      body: "Can you review PR 12?",
      metadata: { sender: { source: "current_session" } },
      anticipation,
      replyBy
    });
    mb.markDelivered({ messageId: id, deliveredAt: at });
    return id;
  } finally {
    mb.close();
  }
}

const rejectsWith = (promise, code, path = null) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof AgentLinkError, String(error));
  assert.equal(error.errorCode, code, error.message);
  if (path) assert.equal(error.details.errors[0].path, path);
  return true;
});

// T-7.1
test("labels: validation and defaults", async () => {
  const mailboxPath = newMailbox();
  const { send } = tools(mailboxPath, SENDER);
  const to = RECEIVER.sessionId;
  await rejectsWith(send({ sessionId: to, message: "x", anticipation: "urgent" }), "invalid_arguments", "anticipation");
  await rejectsWith(send({ sessionId: to, message: "x", anticipation: "reply", replyBy: "tomorrow" }), "invalid_arguments", "replyBy");
  await rejectsWith(send({ sessionId: to, message: "x", anticipation: "reply", replyBy: "2026-10-07 12:00" }), "invalid_arguments", "replyBy");
  await rejectsWith(send({ sessionId: to, message: "x", anticipation: "reply", replyBy: new Date(Date.now() + 10_000).toISOString() }), "invalid_arguments", "replyBy");
  await rejectsWith(send({ sessionId: to, message: "x", anticipation: "fyi", replyBy: new Date(Date.now() + 3_600_000).toISOString() }), "invalid_arguments", "replyBy");
  await rejectsWith(send({ sessionId: to, message: "x", anticipation: "fyi", waitForReply: true, timeoutMs: 0 }), "invalid_arguments", "anticipation");

  const plain = await send({ sessionId: to, message: "fyi by default" });
  assert.equal(plain.anticipation, "fyi");
  assert.equal(plain.messageStatus, null);
  assert.equal(row(mailboxPath, plain.messageId).anticipation, "fyi");

  const waited = await send({ sessionId: to, message: "waitForReply implies reply", waitForReply: true, timeoutMs: 0 });
  assert.equal(waited.anticipation, "reply");
  assert.equal(waited.wait.outcome, "timeout");
  assert.equal(waited.wait.messageStatus, "pending");

  const replyBy = new Date(Date.now() + 3_600_000).toISOString();
  const action = await send({ sessionId: to, message: "do it", anticipation: "action", replyBy });
  assert.equal(action.anticipation, "action");
  assert.equal(action.replyBy, replyBy);
  assert.equal(row(mailboxPath, action.messageId).reply_by, Date.parse(replyBy));

  // An offset time zone is accepted and stored as UTC.
  assert.equal(resolveLabels({ anticipation: "reply", replyBy: "2026-10-07T08:00:00-04:00", now: T0 - 60_000 }).replyBy, Date.parse("2026-10-07T12:00:00Z"));
  // Rows written by 0.5.x have no label and read as fyi.
  const mb = openMailbox({ mailboxPath });
  fs.appendFileSync(mailboxPath, JSON.stringify({ type: "message", at: T0, message: { id: "01J9ZQ3V8K4M2N6P7R8S9T0V1W", from_session_id: "local_x", from_session_kind: "claude", to_session_id: to, to_session_kind: "claude", body: "old", sent_at: T0 } }) + "\n");
  assert.equal(mb.getMessage({ messageId: "01J9ZQ3V8K4M2N6P7R8S9T0V1W" }).anticipation, "fyi");
  mb.close();
});

// T-7.4 and R7.12
test("resolution: reply, decline, done; rules and receipts", async () => {
  const mailboxPath = newMailbox();
  const asSender = tools(mailboxPath, SENDER);
  const asReceiver = tools(mailboxPath, RECEIVER);
  const asThird = tools(mailboxPath, THIRD);
  const send = (anticipation) => asSender.send({ sessionId: RECEIVER.sessionId, message: `${anticipation} please`, anticipation });

  const replyMsg = await send("reply");
  const declineMsg = await send("reply");
  const doneMsg = await send("action");
  const doneNoteMsg = await send("action");
  const fyiMsg = await send("fyi");

  await rejectsWith(asReceiver.reply({ messageId: declineMsg.messageId, resolution: "decline" }), "invalid_arguments", "message");
  await rejectsWith(asReceiver.reply({ messageId: declineMsg.messageId, resolution: "decline", message: "" }), "invalid_arguments", "message");
  await rejectsWith(asReceiver.reply({ messageId: fyiMsg.messageId, resolution: "done" }), "invalid_arguments", "resolution");
  await rejectsWith(asReceiver.reply({ messageId: fyiMsg.messageId, resolution: "decline", message: "no" }), "invalid_arguments", "resolution");
  await rejectsWith(asThird.reply({ messageId: replyMsg.messageId, message: "not mine" }), "wrong_recipient");

  const replied = await asReceiver.reply({ messageId: replyMsg.messageId, message: "LGTM", anticipation: "action" });
  assert.equal(replied.resolution, "reply");
  assert.equal(replied.status, "replied");
  assert.equal(replied.late, false);
  assert.equal(replied.anticipation, "action", "a reply carries its own label");
  const declined = await asReceiver.reply({ messageId: declineMsg.messageId, resolution: "decline", message: "out of scope" });
  assert.equal(declined.status, "declined");
  const done = await asReceiver.reply({ messageId: doneMsg.messageId, resolution: "done" });
  assert.equal(done.status, "done");
  assert.equal(done.messageId, null, "done without a note sends no message");
  assert.equal(done.delivery, "none");
  const doneNote = await asReceiver.reply({ messageId: doneNoteMsg.messageId, resolution: "done", message: "merged" });
  assert.match(doneNote.messageId, /^[0-9A-Z]{26}$/);
  const fyiReply = await asReceiver.reply({ messageId: fyiMsg.messageId, message: "thanks" });
  assert.equal(fyiReply.resolution, null);
  assert.equal(fyiReply.status, null);

  // R7.10: a second resolution of any kind.
  await assert.rejects(asReceiver.reply({ messageId: replyMsg.messageId, resolution: "done" }), (error) => {
    assert.equal(error.errorCode, "already_resolved");
    assert.equal(error.details.messageId, replyMsg.messageId);
    assert.equal(error.details.status, "replied");
    assert.match(error.details.resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
    return true;
  });

  // The sender receives the reply, the reason, and the note as messages,
  // each labeled with inReplyTo.
  const inbox = await asSender.inbox({});
  const byReplyTo = Object.fromEntries(inbox.messages.map((m) => [m.inReplyTo, m]));
  assert.equal(byReplyTo[replyMsg.messageId].anticipation, "action");
  assert.ok(byReplyTo[declineMsg.messageId]);
  assert.ok(byReplyTo[doneNoteMsg.messageId]);
  assert.ok(!byReplyTo[doneMsg.messageId]);
  assert.match(inbox.renderedBlock, new RegExp(`from="${addr(RECEIVER)}" fromHarness="claude" fromVerified="true" to="${addr(SENDER)}" sentAt="[^"]+" anticipation="action" inReplyTo="${replyMsg.messageId}"`));

  // Statuses, as the sender sees them.
  for (const [msg, status] of [[replyMsg, "replied"], [declineMsg, "declined"], [doneMsg, "done"], [doneNoteMsg, "done"], [fyiMsg, null]]) {
    const view = await asSender.status({ messageId: msg.messageId });
    assert.equal(view.status, status, msg.messageId);
  }
  const view = await asSender.status({ messageId: declineMsg.messageId });
  assert.equal(view.resolution.kind, "decline");
  assert.equal(view.resolution.by, addr(RECEIVER));
  assert.equal(view.resolution.late, false);

  // One receipt per resolution (R7.12).
  const receipts = (await listReceipts({ limit: 500 })).data.filter((r) => r.resolution?.kind === "resolution");
  const forMessage = (id) => receipts.filter((r) => r.resolution.messageId === id);
  for (const msg of [replyMsg, declineMsg, doneMsg, doneNoteMsg]) assert.equal(forMessage(msg.messageId).length, 1, msg.messageId);
  assert.equal(forMessage(fyiMsg.messageId).length, 0);
  assert.equal(forMessage(declineMsg.messageId)[0].resolution.resolution, "decline");
});

// T-7.3 (Claude side) and R7.19
test("no automatic replies: only an explicit reply ends a message wait", async () => {
  const mailboxPath = newMailbox();
  const asSender = tools(mailboxPath, SENDER);
  const asReceiver = tools(mailboxPath, RECEIVER);
  const sent = asSender.send({ sessionId: RECEIVER.sessionId, message: "question?", waitForReply: true, timeoutMs: 400 });
  setTimeout(async () => {
    // Reading the inbox (delivery), a channel push, and an unrelated message
    // from the target are not replies.
    await asReceiver.inbox({});
    await asReceiver.send({ sessionId: SENDER.sessionId, message: "unrelated news" });
  }, 50);
  const first = await sent;
  assert.equal(first.wait.outcome, "timeout");
  assert.equal(first.wait.messageStatus, "pending");
  assert.equal(first.wait.reply, undefined);
  assert.equal(row(mailboxPath, first.messageId).acknowledged_at, null);

  const waiting = asSender.wait({ sessionId: RECEIVER.sessionId, replyToMessageId: first.messageId, timeoutMs: 3000 });
  setTimeout(() => asReceiver.reply({ messageId: first.messageId, message: "the answer" }), 50);
  const second = await waiting;
  assert.equal(second.outcome, "reply");
  assert.equal(second.messageStatus, "replied");
  assert.match(second.reply.envelope, /<body>\nthe answer\n<\/body>/);
});

// R7.19: every wait outcome.
test("message waits report declined, done, unresolved and expired", async () => {
  const mailboxPath = newMailbox();
  const asSender = tools(mailboxPath, SENDER);
  const asReceiver = tools(mailboxPath, RECEIVER);
  const waitFor = (messageId, act) => {
    const p = asSender.wait({ sessionId: RECEIVER.sessionId, replyToMessageId: messageId, timeoutMs: 3000 });
    setTimeout(act, 30);
    return p;
  };
  const a = await asSender.send({ sessionId: RECEIVER.sessionId, message: "a", anticipation: "reply" });
  const declined = await waitFor(a.messageId, () => asReceiver.reply({ messageId: a.messageId, resolution: "decline", message: "busy" }));
  assert.equal(declined.outcome, "declined");
  assert.equal(declined.messageStatus, "declined");
  assert.match(declined.reply.envelope, /busy/);

  const b = await asSender.send({ sessionId: RECEIVER.sessionId, message: "b", anticipation: "action" });
  const done = await waitFor(b.messageId, () => asReceiver.reply({ messageId: b.messageId, resolution: "done" }));
  assert.equal(done.outcome, "done");
  assert.equal(done.reply, undefined, "done without a note returns no reply");

  // Unresolved and expired come from the clock: a wait with a later clock.
  const c = deliveredMessage(mailboxPath, { at: Date.now() - 200_000 });
  const late = tools(mailboxPath, SENDER, { settings: { ...SETTINGS, limit: 0 } });
  const unresolved = await late.wait({ sessionId: RECEIVER.sessionId, replyToMessageId: c, timeoutMs: 1000 });
  assert.equal(unresolved.outcome, "unresolved");
  assert.equal(unresolved.messageStatus, "unresolved");

  const d = deliveredMessage(mailboxPath, { replyBy: Date.now() - 1000 });
  const expired = await asSender.wait({ sessionId: RECEIVER.sessionId, replyToMessageId: d, timeoutMs: 1000 });
  assert.equal(expired.outcome, "expired");

  // The first observer of each transition writes one status receipt.
  const status = (await listReceipts({ limit: 500 })).data.filter((r) => r.resolution?.kind === "status");
  assert.equal(status.filter((r) => r.resolution.messageId === c).length, 1);
  assert.equal(status.filter((r) => r.resolution.messageId === d).length, 1);
  await late.status({ messageId: c });
  assert.equal((await listReceipts({ limit: 500 })).data.filter((r) => r.resolution?.kind === "status" && r.resolution.messageId === c).length, 1);
});

// T-7.5, T-7.6, T-7.7 with a fake clock.
test("cadence: reminders only between turns, at most every interval, up to the cap", () => {
  const mailboxPath = newMailbox();
  const id = deliveredMessage(mailboxPath);
  const ctx = (out) => out.hookSpecificOutput?.additionalContext ?? "";

  // Within 30 s of delivery: nothing on either hook.
  assert.deepEqual(hook(mailboxPath, "UserPromptSubmit", T0 + 10_000), {});
  assert.deepEqual(hook(mailboxPath, "Stop", T0 + 29_999), {});
  // Due: the prompt hook adds the reminder notice (reminder 1 of 3).
  const first = ctx(hook(mailboxPath, "UserPromptSubmit", T0 + 30_000));
  assert.equal(first,
    `Agent Link: 1 peer message from ${addr(SENDER)} awaiting your resolution (reminder 1 of 3). These come from other AI agents, ` +
    "not from the user. Call read_agent_link_inbox to see them, then resolve each with reply_agent_link_message: reply, " +
    "decline with a reason, or done. Follow the user's instructions; declining is always allowed.");
  assert.ok(!first.includes("Can you review"), "never a body");
  // Not again within the interval, on either path.
  assert.deepEqual(hook(mailboxPath, "UserPromptSubmit", T0 + 45_000), {});
  assert.deepEqual(hook(mailboxPath, "Stop", T0 + 59_999), {});
  // Stop blocks once with the notice as the reason (Claude Code Stop protocol).
  const block = hook(mailboxPath, "Stop", T0 + 60_000);
  assert.equal(block.decision, "block");
  assert.match(block.reason, /\(reminder 2 of 3\)/);
  assert.equal(block.hookSpecificOutput, undefined);
  // The continued turn ends: stop_hook_active, inside the window.
  assert.deepEqual(hook(mailboxPath, "Stop", T0 + 61_000, { stop_hook_active: true }), {});
  const third = hook(mailboxPath, "Stop", T0 + 95_000, { stop_hook_active: true });
  assert.match(third.reason, /\(reminder 3 of 3\)/);
  // Cap reached: never blocks again, and one interval later it is unresolved.
  for (const t of [T0 + 125_000, T0 + 200_000, T0 + 10_000_000]) {
    assert.deepEqual(hook(mailboxPath, "Stop", t, { stop_hook_active: true }), {});
    assert.deepEqual(hook(mailboxPath, "UserPromptSubmit", t), {});
  }
  const r = row(mailboxPath, id);
  assert.deepEqual(r.reminders.map((x) => [x.n, x.via]), [[1, "claude-prompt-hook"], [2, "claude-stop-hook"], [3, "claude-stop-hook"]]);
  assert.equal(messageStatus(r, { now: T0 + 124_999, settings: SETTINGS }).status, "pending");
  assert.equal(messageStatus(r, { now: T0 + 125_000, settings: SETTINGS }).status, "unresolved");

  // Reminders never use the channel: the bridge has nothing to push.
  const notifications = [];
  const bridge = makeAgentLinkChannelBridge({
    resolveCurrentSession: () => RECEIVER,
    mailboxOpener: () => openMailbox({ mailboxPath }),
    mailboxPath,
    watch: false,
    notify: async (notification) => notifications.push(notification)
  });
  return bridge.pollOnce().then((result) => {
    assert.equal(result.delivered, 0);
    assert.equal(notifications.length, 0);
  });
});

test("Stop blocks at most once per interval per recipient, never for fyi or undelivered mail", () => {
  const mailboxPath = newMailbox();
  deliveredMessage(mailboxPath, { at: T0 });
  deliveredMessage(mailboxPath, { at: T0 + 5_000 });
  deliveredMessage(mailboxPath, { anticipation: "fyi", at: T0 - 100_000 });
  const block = hook(mailboxPath, "Stop", T0 + 30_000);
  assert.match(block.reason, /^Agent Link: 1 peer message /);
  // The second message falls due 5 s later, inside the recipient's window.
  assert.deepEqual(hook(mailboxPath, "Stop", T0 + 35_000), {});
  // After the window, one block lists everything due.
  const next = hook(mailboxPath, "Stop", T0 + 65_000);
  assert.match(next.reason, /^Agent Link: 2 peer messages from .+ \(reminder 2 of 3\)/);

  // fyi and not-yet-delivered anticipating mail never block.
  const quiet = newMailbox();
  deliveredMessage(quiet, { anticipation: "fyi", at: T0 });
  const mb = openMailbox({ mailboxPath: quiet });
  mb.insertMessage({ fromSessionId: SENDER.sessionId, fromSessionKind: "claude", toSessionId: RECEIVER.sessionId, toSessionKind: "claude", body: "queued", anticipation: "reply" });
  mb.close();
  for (const t of [T0 + 30_000, T0 + 600_000]) assert.deepEqual(hook(quiet, "Stop", t), {});
  // A resolved message never blocks.
  const resolved = newMailbox();
  const id = deliveredMessage(resolved, { at: T0 });
  const rmb = openMailbox({ mailboxPath: resolved });
  // Item 8: a resolution not written by the recipient is ignored.
  rmb.recordResolution({ messageId: id, kind: "done", by: THIRD.sessionId, at: T0 + 1 });
  assert.equal(rmb.getMessage({ messageId: id }).resolution, null);
  rmb.recordResolution({ messageId: id, kind: "done", by: RECEIVER.sessionId, byAddress: addr(RECEIVER), at: T0 + 2 });
  assert.equal(rmb.getMessage({ messageId: id }).resolution.kind, "done");
  assert.equal(rmb.getMessage({ messageId: id }).resolution.by, addr(RECEIVER));
  rmb.close();
  assert.deepEqual(hook(resolved, "Stop", T0 + 60_000), {});
});

test("cap 0, deadlines, and late resolution", async () => {
  const mailboxPath = newMailbox();
  const zero = { ...SETTINGS, limit: 0 };
  const id = deliveredMessage(mailboxPath);
  assert.equal(messageStatus(row(mailboxPath, id), { now: T0 + 29_999, settings: zero }).status, "pending");
  assert.equal(messageStatus(row(mailboxPath, id), { now: T0 + 30_000, settings: zero }).status, "unresolved");
  assert.equal(dueReminders([row(mailboxPath, id)], { now: T0 + 30_000, settings: zero }).length, 0, "limit 0: no reminders");

  // replyBy passes before any reminder: expired, and no more reminders.
  const deadline = deliveredMessage(mailboxPath, { replyBy: T0 + 40_000 });
  assert.equal(messageStatus(row(mailboxPath, deadline), { now: T0 + 39_999, settings: SETTINGS }).status, "pending");
  assert.equal(messageStatus(row(mailboxPath, deadline), { now: T0 + 40_000, settings: SETTINGS }).status, "expired");
  assert.equal(dueReminders([row(mailboxPath, deadline)], { now: T0 + 40_000, settings: SETTINGS }).length, 0);

  // A recipient that never takes another turn stays pending (no deadline).
  const never = deliveredMessage(mailboxPath);
  assert.equal(messageStatus(row(mailboxPath, never), { now: T0 + 10 * 86_400_000, settings: SETTINGS }).status, "pending");

  // Late resolution after expired: final status, late:true.
  const asReceiver = tools(mailboxPath, RECEIVER, { now: () => T0 + 50_000 });
  const result = await asReceiver.reply({ messageId: deadline, message: "sorry, late" });
  assert.equal(result.status, "replied");
  assert.equal(result.late, true);
  const view = await tools(mailboxPath, SENDER, { now: () => T0 + 50_001 }).status({ messageId: deadline });
  assert.equal(view.status, "replied");
  assert.equal(view.resolution.late, true);
  // And after unresolved.
  const asLate = tools(mailboxPath, RECEIVER, { now: () => T0 + 31_000, settings: zero });
  assert.equal((await asLate.reply({ messageId: id, resolution: "done" })).late, true);

  // Interval below 30000 and a bad limit are ignored and reported.
  const settings = reminderSettings({ AGENT_LINK_REMINDER_INTERVAL_MS: "1000", AGENT_LINK_REMINDER_LIMIT: "21" });
  assert.equal(settings.intervalMs, 30_000);
  assert.equal(settings.limit, 3);
  assert.deepEqual(settings.warnings.map((w) => w.code).sort(), ["reminder_interval_ignored", "reminder_limit_ignored"]);
  assert.deepEqual(reminderSettings({ AGENT_LINK_REMINDER_INTERVAL_MS: "45000", AGENT_LINK_REMINDER_LIMIT: "0" }), { limit: 0, intervalMs: 45_000, warnings: [] });
  const health = healthExtras({ source: { HOME: tmp, AGENT_LINK_STATE_DIR: path.join(tmp, "state"), AGENT_LINK_REMINDER_INTERVAL_MS: "5" } });
  assert.equal(health.reminders.intervalMs, 30_000);
  assert.equal(health.reminders.codexTurns, false);
  assert.equal(health.reminders.warnings[0].code, "reminder_interval_ignored");
});

// T-7.8
test("sender view: get_agent_link_message_status", async () => {
  const mailboxPath = newMailbox();
  const asSender = tools(mailboxPath, SENDER);
  const sent = await asSender.send({ sessionId: RECEIVER.sessionId, message: "secret body text", anticipation: "reply" });
  const view = await asSender.status({ messageId: sent.messageId });
  assert.deepEqual(Object.keys(view).sort(), ["anticipation", "delivery", "from", "inReplyTo", "messageId", "reminders", "replyBy", "resolution", "status", "to"]);
  assert.equal(view.from, addr(SENDER));
  assert.equal(view.to, addr(RECEIVER));
  assert.equal(view.delivery, "queued");
  assert.equal(view.status, "pending");
  assert.deepEqual(view.reminders, { count: 0, limit: 3, lastAt: null, nextDueAt: null });
  assert.ok(!JSON.stringify(view).includes("secret body"), "never a body");

  // The recipient may read it; delivery and the next due time show up.
  await tools(mailboxPath, RECEIVER).inbox({});
  const recv = await tools(mailboxPath, RECEIVER).status({ messageId: sent.messageId });
  assert.equal(recv.delivery, "delivered");
  assert.match(recv.reminders.nextDueAt, /^\d{4}-/);

  await assert.rejects(tools(mailboxPath, THIRD).status({ messageId: sent.messageId }), (error) => {
    assert.equal(error.errorCode, "permission_denied");
    assert.equal(error.details.reason, "not_participant");
    return true;
  });
  await rejectsWith(asSender.status({ messageId: "01J9ZQ3V8K4M2N6P7R8S9T0V1Z" }), "not_found");

  // A reply row written without a resolution event (a 0.5.x reply tool, or a
  // send with replyToMessageId) still resolves the message as replied.
  const mb = openMailbox({ mailboxPath });
  mb.insertMessage({ fromSessionId: RECEIVER.sessionId, fromSessionKind: "claude", toSessionId: SENDER.sessionId, toSessionKind: "claude", body: "ok", replyToMessageId: sent.messageId });
  mb.close();
  assert.equal((await asSender.status({ messageId: sent.messageId })).status, "replied");
  assert.equal((await asSender.status({ messageId: sent.messageId })).delivery, "delivered");
});

// The inbox shows open messages again, so the reminder's instruction works.
test("read_agent_link_inbox lists open messages awaiting resolution", async () => {
  const mailboxPath = newMailbox();
  const asSender = tools(mailboxPath, SENDER);
  const asReceiver = tools(mailboxPath, RECEIVER);
  const open = await asSender.send({ sessionId: RECEIVER.sessionId, message: "needs an answer", anticipation: "reply" });
  await asSender.send({ sessionId: RECEIVER.sessionId, message: "just so you know" });
  const first = await asReceiver.inbox({});
  assert.equal(first.messages.length, 2);
  assert.equal(first.openCount, 0);
  const again = await asReceiver.inbox({});
  assert.equal(again.openCount, 1);
  assert.equal(again.messages.length, 1);
  assert.equal(again.messages[0].id, open.messageId);
  assert.equal(again.messages[0].open, true);
  assert.equal(again.messages[0].status, "pending");
  assert.match(again.renderedBlock, /A reply is expected\. Call reply_agent_link_message/);
  assert.equal((await asReceiver.inbox({ includeOpen: false })).messages.length, 0);
  await asReceiver.reply({ messageId: open.messageId, message: "done" });
  assert.equal((await asReceiver.inbox({})).openCount, 0);
});

// T-7.10: two processes racing for the same due reminder.
test("racing reminders: exactly one reminded event and one notice", () => {
  const mailboxPath = newMailbox();
  const id = deliveredMessage(mailboxPath);
  const a = openMailbox({ mailboxPath });
  const b = openMailbox({ mailboxPath });
  const dueA = dueReminders(a.inspect({ limit: 100 }), { now: T0 + 30_000, settings: SETTINGS });
  const dueB = dueReminders(b.inspect({ limit: 100 }), { now: T0 + 30_000, settings: SETTINGS });
  assert.equal(dueA.length, 1);
  assert.equal(dueB.length, 1);
  const claimedA = claimReminders(a, dueA, { via: "claude-stop-hook", now: T0 + 30_000, settings: SETTINGS });
  const claimedB = claimReminders(b, dueB, { via: "claude-prompt-hook", now: T0 + 30_000, settings: SETTINGS });
  assert.equal(claimedA.length + claimedB.length, 1);
  assert.equal(row(mailboxPath, id).reminders.length, 1);
  a.close();
  b.close();
  // Two hook invocations on the same due state: one notice.
  const racing = newMailbox();
  deliveredMessage(racing);
  const outs = [hook(racing, "Stop", T0 + 30_000), hook(racing, "UserPromptSubmit", T0 + 30_000)];
  assert.equal(outs.filter((o) => o.decision === "block" || o.hookSpecificOutput).length, 1);
});

test("send with replyToMessageId resolves the original as replied", async () => {
  const mailboxPath = newMailbox();
  const asSender = tools(mailboxPath, SENDER);
  const asReceiver = tools(mailboxPath, RECEIVER);
  const sent = await asSender.send({ sessionId: RECEIVER.sessionId, message: "q", anticipation: "reply" });
  const answer = await asReceiver.send({ sessionId: SENDER.sessionId, message: "a", replyToMessageId: sent.messageId });
  const r = row(mailboxPath, sent.messageId);
  assert.equal(r.resolution.kind, "reply");
  assert.equal(r.resolution.replyMessageId, answer.messageId);
  assert.equal((await asSender.status({ messageId: sent.messageId })).status, "replied");
});

// Review item I2: a crash between taking a reminder claim and appending the
// `reminded` event must not pin the message at pending forever.
test("orphaned reminder claims still count toward the cap", () => {
  const mailboxPath = newMailbox();
  const deliveredAt = Date.now() - 200_000;
  const id = deliveredMessage(mailboxPath, { at: deliveredAt });
  const mb = openMailbox({ mailboxPath });
  // Claims taken, events never written.
  for (const n of [1, 2, 3]) assert.ok(mb.claim(`reminder-${id}-${n}`));
  const r = mb.getMessage({ messageId: id });
  mb.close();
  assert.deepEqual(r.reminders.map((x) => [x.n, x.via]), [[1, null], [2, null], [3, null]]);
  const now = Date.now();
  assert.equal(messageStatus(r, { now, settings: SETTINGS }).status, "pending");
  assert.equal(messageStatus(r, { now, settings: SETTINGS }).due, false, "the cap is reached: no fourth reminder");
  assert.equal(messageStatus(r, { now: now + 31_000, settings: SETTINGS }).status, "unresolved");

  // One orphan: the next reminder is number 2, not a second number 1.
  const one = newMailbox();
  const id1 = deliveredMessage(one, { at: deliveredAt });
  const mb1 = openMailbox({ mailboxPath: one });
  assert.ok(mb1.claim(`reminder-${id1}-1`));
  const due = dueReminders([mb1.getMessage({ messageId: id1 })], { now: Date.now() + 31_000, settings: SETTINGS });
  const claimed = claimReminders(mb1, due, { via: "claude-prompt-hook", now: Date.now() + 31_000, settings: SETTINGS });
  assert.deepEqual(claimed.map((c) => c.n), [2]);
  mb1.close();
});

// Review items 3 and 5: the Stop slot is per recipient, across processes.
test("Stop slot: one block per interval per recipient across mailbox handles", () => {
  const mailboxPath = newMailbox();
  deliveredMessage(mailboxPath, { at: T0 });
  deliveredMessage(mailboxPath, { at: T0 });
  const a = openMailbox({ mailboxPath });
  const b = openMailbox({ mailboxPath });
  const open = a.inspect({ limit: 100 });
  const slot = (mb, now, stopHookActive = false) => takeStopSlot(mb, { recipientKey: RECEIVER.cliSessionId, open, now, settings: SETTINGS, stopHookActive });
  assert.equal(slot(a, T0 + 59_999), true);
  assert.equal(slot(b, T0 + 59_999), false, "same instant, other process");
  assert.equal(slot(b, T0 + 60_001), false, "neighbouring bucket inside the interval");
  assert.equal(slot(b, T0 + 70_000, true), false, "stop_hook_active inside the window");
  assert.equal(slot(b, T0 + 90_000, true), true, "a later window may block again");
  assert.equal(slot(a, T0 + 90_000), false);
  a.close();
  b.close();
});

// Review item 4: an older-style reply (a reply row, no resolution event)
// stops reminders.
test("no reminder after the recipient replied the older way", () => {
  const mailboxPath = newMailbox();
  const id = deliveredMessage(mailboxPath);
  const mb = openMailbox({ mailboxPath });
  mb.insertMessage({ fromSessionId: RECEIVER.cliSessionId, fromSessionKind: "claude", toSessionId: SENDER.sessionId, toSessionKind: "claude", body: "done", replyToMessageId: id });
  mb.close();
  assert.deepEqual(hook(mailboxPath, "Stop", T0 + 30_000), {});
  assert.deepEqual(hook(mailboxPath, "UserPromptSubmit", T0 + 30_000), {});
});

// Review item 7: the status tool writes nothing.
test("get_agent_link_message_status is read-only", async () => {
  const mailboxPath = newMailbox();
  const asSender = tools(mailboxPath, SENDER);
  const expired = deliveredMessage(mailboxPath, { replyBy: Date.now() - 1000 });
  const answered = deliveredMessage(mailboxPath);
  const mb = openMailbox({ mailboxPath });
  mb.insertMessage({ fromSessionId: RECEIVER.sessionId, fromSessionKind: "claude", toSessionId: SENDER.sessionId, toSessionKind: "claude", body: "ok", replyToMessageId: answered });
  mb.close();
  const before = fs.readFileSync(mailboxPath, "utf8");
  const claimsBefore = fs.existsSync(`${mailboxPath}.claims`) ? fs.readdirSync(`${mailboxPath}.claims`) : [];
  assert.equal((await asSender.status({ messageId: answered })).status, "replied");
  assert.equal((await asSender.status({ messageId: expired })).status, "expired");
  assert.equal(fs.readFileSync(mailboxPath, "utf8"), before, "no mailbox write");
  assert.deepEqual(fs.existsSync(`${mailboxPath}.claims`) ? fs.readdirSync(`${mailboxPath}.claims`) : [], claimsBefore, "no claim");
});

// Review item 6: bounded claim collection and the claims directory mode.
test("claim sweep removes claims nothing needs and keeps the rest", async () => {
  const mailboxPath = newMailbox();
  const resolvedId = deliveredMessage(mailboxPath);
  const openId = deliveredMessage(mailboxPath, { at: Date.now() - 1000 });
  const expiredId = deliveredMessage(mailboxPath, { replyBy: Date.now() - 1000 });
  const mb = openMailbox({ mailboxPath });
  const dir = `${mailboxPath}.claims`;
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  // Resolved: its resolve and reminder claims go.
  assert.ok(mb.claim(`reminder-${resolvedId}-1`));
  mb.recordReminder({ messageId: resolvedId, n: 1, via: "claude-prompt-hook" });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "a looser claims dir is tightened");
  assert.ok(mb.claim(`resolve-${resolvedId}`));
  mb.recordResolution({ messageId: resolvedId, kind: "done", by: RECEIVER.sessionId });
  // Open: a recorded reminder's claim goes; an orphan claim stays (it is the count).
  assert.ok(mb.claim(`reminder-${openId}-1`));
  mb.recordReminder({ messageId: openId, n: 1, via: "claude-stop-hook" });
  assert.ok(mb.claim(`reminder-${openId}-2`));
  const receipts = [];
  const result = await sweepClaims(mb, { appendReceipt: async (r) => { receipts.push(r); return { ok: true }; }, settings: SETTINGS });
  const left = fs.readdirSync(dir).sort();
  assert.ok(left.includes(`reminder-${openId}-2`));
  assert.ok(!left.some((n) => n.includes(resolvedId)));
  assert.ok(!left.includes(`reminder-${openId}-1`));
  assert.ok(left.includes(`status-${expiredId}-expired`), "the transition is claimed once");
  assert.equal(receipts.filter((r) => r.resolution?.messageId === expiredId).length, 1, "the sweep writes the expired receipt");
  assert.equal(result.receipts, 1);
  assert.ok(result.removed >= 3);
  await sweepClaims(mb, { appendReceipt: async (r) => { receipts.push(r); return { ok: true }; }, settings: SETTINGS });
  assert.equal(receipts.length, 1, "a second pass writes no second receipt");
  mb.close();
});
