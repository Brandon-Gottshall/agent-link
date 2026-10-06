// tests/claude/channel-wait-race.test.js
//
// A Claude Code sender that blocks on a reply (message_claude_session with
// waitForReply, or wait_for_claude_session) runs its channel bridge in the same
// process. The bridge wakes ~50 ms after the mailbox changes while the wait
// polls every 250 ms, so the bridge used to claim the reply first and push it
// as a second <agent-link-message> on top of the tool result. These tests run
// a live bridge (fs.watch on, short poll) next to each wait and require the
// reply to reach the caller exactly once.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMailbox } from "../../src/claude/mailbox.js";
import { makeAgentLinkChannelBridge } from "../../src/claude/channel-bridge.js";
import { activeWaitCount } from "../../src/claude/active-waits.js";
import { makeClaudeSendHandler } from "../../src/tools/claude-send.js";
import { makeWaitHandler } from "../../src/tools/claude-wait.js";

// Hermetic: never touch the real ~/.claude or ~/.codex.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-channel-wait-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
for (const key of ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) delete process.env[key];
process.env.CODEX_AGENT_LINK_RECEIPT_LOG = path.join(tmp, "receipts.jsonl");
process.env.AGENT_LINK_MAILBOX_PATH = path.join(tmp, "default-mailbox.jsonl");

const ME = { sessionId: "local_me", cliSessionId: "uuid-me", surface: "code", loaded: true };
const TARGET = {
  sessionId: "local_target",
  cliSessionId: "uuid-target",
  title: "Target session",
  surface: "code",
  loaded: true
};

let sandboxCount = 0;
function makeSandbox() {
  const dir = path.join(tmp, `case-${++sandboxCount}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "mailbox.jsonl");
}

function startBridge(mailboxPath, notifications) {
  const bridge = makeAgentLinkChannelBridge({
    resolveCurrentSession: () => ME,
    mailboxOpener: () => openMailbox({ mailboxPath }),
    mailboxPath,
    notify: async (notification) => notifications.push(notification),
    pollIntervalMs: 20,
    maxPollIntervalMs: 20,
    watch: true
  });
  bridge.start();
  return bridge;
}

function insert(mailboxPath, { from, to, body, replyToMessageId = null }) {
  const mb = openMailbox({ mailboxPath });
  try {
    return mb.insertMessage({
      fromSessionId: from,
      fromSessionKind: "claude",
      toSessionId: to,
      toSessionKind: "claude",
      body,
      replyToMessageId
    });
  } finally {
    mb.close();
  }
}

function findOutbound(mailboxPath) {
  const mb = openMailbox({ mailboxPath });
  try {
    return mb.inspect({ fromSessionId: ME.sessionId, toSessionId: TARGET.sessionId })[0] ?? null;
  } finally {
    mb.close();
  }
}

function readMessage(mailboxPath, messageId) {
  const mb = openMailbox({ mailboxPath });
  try {
    return mb.getMessage({ messageId });
  } finally {
    mb.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

function sendHandler(mailboxPath) {
  return makeClaudeSendHandler({
    host: "claude",
    listSessions: () => [TARGET],
    mailboxOpener: () => openMailbox({ mailboxPath }),
    resolveCurrentSession: () => ME,
    appendReceipt: async () => ({ ok: true })
  });
}

function waitHandler(mailboxPath, { mailboxOpener } = {}) {
  return makeWaitHandler({
    host: "claude",
    listSessions: () => [TARGET],
    mailboxOpener: mailboxOpener ?? (() => openMailbox({ mailboxPath })),
    resolveCurrentSession: () => ME,
    isSessionLoaded: () => true
  });
}

// 1. message_claude_session(waitForReply): the reply lands between two wait
//    polls. Only the tool result may carry it; the bridge must not push it.
{
  const mailboxPath = makeSandbox();
  const notifications = [];
  const bridge = startBridge(mailboxPath, notifications);
  try {
    const pending = sendHandler(mailboxPath).message_claude_session({
      to: TARGET.sessionId,
      body: "question?",
      waitForReply: true,
      timeoutMs: 5_000
    });
    assert.ok(await waitUntil(() => findOutbound(mailboxPath)), "outbound message was written");
    const outbound = findOutbound(mailboxPath);
    await sleep(30); // just past the wait's first poll, well before its next one
    const replyId = insert(mailboxPath, {
      from: TARGET.sessionId,
      to: ME.sessionId,
      body: "answer",
      replyToMessageId: outbound.id
    });
    const result = await pending;
    assert.equal(result.replyConfirmation.received, true);
    assert.equal(result.replyConfirmation.replyMessageId, replyId);
    await sleep(150); // give the bridge several more polls
    assert.equal(notifications.length, 0, "reply must not also arrive as a channel message");
    const stored = readMessage(mailboxPath, replyId);
    assert.ok(stored.delivered_at && stored.acknowledged_at, "wait consumed the reply");
    assert.equal(activeWaitCount(), 0, "wait unregistered");
  } finally {
    bridge.stop();
  }
}

// 2. wait_for_claude_session with latestMessageId.
{
  const mailboxPath = makeSandbox();
  const notifications = [];
  const bridge = startBridge(mailboxPath, notifications);
  try {
    const outboundId = insert(mailboxPath, { from: ME.sessionId, to: TARGET.sessionId, body: "q" });
    const pending = waitHandler(mailboxPath).wait_for_claude_session({
      sessionId: TARGET.sessionId,
      latestMessageId: outboundId,
      timeoutMs: 5_000
    });
    await sleep(30);
    const replyId = insert(mailboxPath, {
      from: TARGET.sessionId,
      to: ME.sessionId,
      body: "a",
      replyToMessageId: outboundId
    });
    const result = await pending;
    assert.equal(result.result, "reply");
    assert.equal(result.message.id, replyId);
    await sleep(150);
    assert.equal(notifications.length, 0, "reply must not also arrive as a channel message");
    assert.equal(activeWaitCount(), 0);
  } finally {
    bridge.stop();
  }
}

// 3. wait_for_claude_session without latestMessageId: the sender+recipient
//    match is held, while an unrelated message to the caller (from someone
//    else) is still delivered by the bridge during the wait.
{
  const mailboxPath = makeSandbox();
  const notifications = [];
  const bridge = startBridge(mailboxPath, notifications);
  try {
    const pending = waitHandler(mailboxPath).wait_for_claude_session({
      sessionId: TARGET.sessionId,
      timeoutMs: 5_000
    });
    await sleep(30);
    const otherId = insert(mailboxPath, { from: "local_other", to: ME.sessionId, body: "unrelated" });
    const replyId = insert(mailboxPath, { from: TARGET.sessionId, to: ME.sessionId, body: "news" });
    const result = await pending;
    assert.equal(result.result, "reply");
    assert.equal(result.message.id, replyId);
    assert.ok(await waitUntil(() => notifications.length >= 1), "unrelated message delivered");
    await sleep(150);
    assert.deepEqual(notifications.map((n) => n.params.meta.message_id), [otherId]);
  } finally {
    bridge.stop();
  }
}

// 4. Timeout: a matching reply the wait never saw (it landed after the wait's
//    last check) is held while the wait runs and delivered by the bridge as
//    soon as the wait times out. The wait's opener hides the reply to make
//    that window deterministic.
{
  const mailboxPath = makeSandbox();
  const notifications = [];
  const bridge = startBridge(mailboxPath, notifications);
  try {
    const outboundId = insert(mailboxPath, { from: ME.sessionId, to: TARGET.sessionId, body: "q" });
    const blindOpener = () => {
      const mb = openMailbox({ mailboxPath });
      return { ...mb, inspect: () => [] };
    };
    const pending = waitHandler(mailboxPath, { mailboxOpener: blindOpener }).wait_for_claude_session({
      sessionId: TARGET.sessionId,
      latestMessageId: outboundId,
      timeoutMs: 400
    });
    await sleep(30);
    const replyId = insert(mailboxPath, {
      from: TARGET.sessionId,
      to: ME.sessionId,
      body: "late",
      replyToMessageId: outboundId
    });
    await sleep(150);
    assert.equal(notifications.length, 0, "held while the wait is active");
    const result = await pending;
    assert.equal(result.result, "timeout");
    assert.equal(activeWaitCount(), 0);
    assert.ok(await waitUntil(() => notifications.length === 1), "delivered after the wait timed out");
    assert.equal(notifications[0].params.meta.message_id, replyId);
    assert.ok(readMessage(mailboxPath, replyId).delivered_at);
  } finally {
    bridge.stop();
  }
}

// 5. Timeout of message_claude_session(waitForReply) with no reply leaves no
//    registration behind, so a later reply is delivered normally.
{
  const mailboxPath = makeSandbox();
  const notifications = [];
  const bridge = startBridge(mailboxPath, notifications);
  try {
    const result = await sendHandler(mailboxPath).message_claude_session({
      to: TARGET.sessionId,
      body: "anyone?",
      waitForReply: true,
      timeoutMs: 100
    });
    assert.equal(result.replyConfirmation.received, false);
    assert.equal(activeWaitCount(), 0);
    const replyId = insert(mailboxPath, {
      from: TARGET.sessionId,
      to: ME.sessionId,
      body: "late answer",
      replyToMessageId: result.messageId
    });
    assert.ok(await waitUntil(() => notifications.length === 1), "late reply delivered by the channel");
    assert.equal(notifications[0].params.meta.message_id, replyId);
  } finally {
    bridge.stop();
  }
}

console.log("channel-wait-race tests passed");
