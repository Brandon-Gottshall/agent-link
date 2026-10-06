// tests/claude/wait.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openMailbox } from "../../src/claude/mailbox.js";
import { makeWaitHandler } from "../../src/tools/claude-wait.js";
import { envelopeBodies, envelopeBody } from "../helpers/envelope-body.js";

const TARGET_SESSION_ID = "local_aaa1111";

const LOADED_SESSION = {
  sessionId: TARGET_SESSION_ID,
  cliSessionId: "uuid-aaa",
  title: "Investigate flaky tests",
  processName: "blissful-wonderful-goldberg",
  cwd: "/sessions/blissful-wonderful-goldberg",
  userSelectedFolders: [],
  loaded: true
};

function makeSandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-wait-"));
  const mailboxPath = path.join(tmp, "mailbox.jsonl");
  return { tmp, mailboxPath };
}

function cleanup({ tmp }) {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function makeHandler({ mailboxPath, sessionsFn }) {
  return makeWaitHandler({
    listSessions: sessionsFn,
    mailboxOpener: () => openMailbox({ mailboxPath })
  });
}

function insertReply({ mailboxPath, fromSessionId, toSessionId, body, replyToMessageId = null }) {
  const mb = openMailbox({ mailboxPath });
  try {
    return mb.insertMessage({
      fromSessionId,
      fromSessionKind: "claude",
      toSessionId,
      toSessionKind: "claude",
      body,
      metadata: null,
      replyToMessageId
    });
  } finally {
    mb.close();
  }
}

// Test 1: Reply path with latestMessageId — reply arrives mid-flight.
{
  const sb = makeSandbox();
  const handlers = makeHandler({
    mailboxPath: sb.mailboxPath,
    sessionsFn: () => [LOADED_SESSION]
  });

  const latestMessageId = "01J9ZQ3V8K4M2N6P7R8S9T0V2A";

  // Reply arrives ~50ms in.
  const insertedIdPromise = new Promise((resolve) => {
    setTimeout(() => {
      const id = insertReply({
        mailboxPath: sb.mailboxPath,
        fromSessionId: TARGET_SESSION_ID,
        toSessionId: "external",
        body: "thanks for the ping",
        replyToMessageId: latestMessageId
      });
      resolve(id);
    }, 50);
  });

  const result = await handlers.wait_for_claude_session({
    sessionId: TARGET_SESSION_ID,
    latestMessageId,
    timeoutMs: 2000
  });

  const insertedId = await insertedIdPromise;
  assert.equal(result.error, undefined, "no error on reply path");
  // Section 3.4 shape; result/message/sessionId stay as deprecated duplicates.
  assert.equal(result.outcome, "reply");
  assert.ok(Number.isInteger(result.waitedMs));
  assert.deepEqual(result.target, { sessionId: TARGET_SESSION_ID, address: "claude:uuid-aaa" });
  assert.deepEqual(result.reply, result.message);
  assert.equal(result.result, "reply");
  assert.equal(result.sessionId, TARGET_SESSION_ID);
  assert.ok(result.message, "message field populated");
  assert.equal(result.message.id, insertedId);
  assert.equal(envelopeBody(result.message.envelope), "thanks for the ping");
  assert.ok(!("from_session_id" in result.message) && !("body" in result.message), "structured reply carries no raw row fields");
  assert.equal(result.message.replyTo, latestMessageId);
  cleanup(sb);
}

// Test 2: Reply path without latestMessageId — any inbound from the
// target session resolves the wait, even non-reply messages.
{
  const sb = makeSandbox();
  const handlers = makeHandler({
    mailboxPath: sb.mailboxPath,
    sessionsFn: () => [LOADED_SESSION]
  });

  setTimeout(() => {
    insertReply({
      mailboxPath: sb.mailboxPath,
      fromSessionId: TARGET_SESSION_ID,
      toSessionId: "external",
      body: "fresh inbound, not a reply",
      replyToMessageId: null
    });
  }, 50);

  const result = await handlers.wait_for_claude_session({
    sessionId: TARGET_SESSION_ID,
    timeoutMs: 2000
  });

  assert.equal(result.result, "reply");
  assert.equal(envelopeBody(result.message.envelope), "fresh inbound, not a reply");
  assert.equal(result.message.replyTo, null);
  assert.ok(!("from_session_id" in result.message) && !("body" in result.message), "structured reply carries no raw row fields");
  cleanup(sb);
}

// Test 3: Idle transition — the listing reports loaded=true at the start;
// the single-session liveness probe later reports the process gone. The
// handler should return result: "idle" without re-listing every session.
{
  const sb = makeSandbox();
  let listCalls = 0;
  let livenessCalls = 0;
  const handlers = makeWaitHandler({
    listSessions: () => {
      listCalls += 1;
      return [LOADED_SESSION];
    },
    isSessionLoaded: (session) => {
      livenessCalls += 1;
      assert.equal(session.cliSessionId, "uuid-aaa", "liveness is checked for the target only");
      return false;
    },
    livenessIntervalMs: 50,
    mailboxOpener: () => openMailbox({ mailboxPath: sb.mailboxPath })
  });

  const result = await handlers.wait_for_claude_session({
    sessionId: TARGET_SESSION_ID,
    timeoutMs: 2000
  });

  assert.equal(result.error, undefined);
  assert.equal(result.result, "idle");
  assert.equal(result.target.sessionId, TARGET_SESSION_ID);
  assert.equal(result.target.lastLoaded, false);
  assert.equal(listCalls, 1, `the full listing runs once (saw ${listCalls})`);
  assert.equal(livenessCalls, 1);
  cleanup(sb);
}

// P4-06 / W2A-13: while waiting, liveness is probed for the one session no
// more than every 2 s by default, and the full listing never repeats.
{
  const sb = makeSandbox();
  let listCalls = 0;
  let livenessCalls = 0;
  const handlers = makeWaitHandler({
    listSessions: () => {
      listCalls += 1;
      return [LOADED_SESSION];
    },
    isSessionLoaded: () => {
      livenessCalls += 1;
      return true;
    },
    mailboxOpener: () => openMailbox({ mailboxPath: sb.mailboxPath })
  });
  const result = await handlers.wait_for_claude_session({ sessionId: TARGET_SESSION_ID, timeoutMs: 1500 });
  assert.equal(result.result, "timeout");
  assert.equal(listCalls, 1, `full listing must not repeat every poll (saw ${listCalls})`);
  assert.equal(livenessCalls, 0, `liveness probed more often than every 2 s (saw ${livenessCalls} in 1.5 s)`);
  cleanup(sb);
}

// P4-06 / W2B-02: without latestMessageId, a message the target sent before
// the wait started does not resolve it.
{
  const sb = makeSandbox();
  insertReply({ mailboxPath: sb.mailboxPath, fromSessionId: TARGET_SESSION_ID, toSessionId: "external", body: "stale, from yesterday" });
  await new Promise((r) => setTimeout(r, 5));
  const handlers = makeHandler({ mailboxPath: sb.mailboxPath, sessionsFn: () => [{ ...LOADED_SESSION, loaded: false }] });
  const result = await handlers.wait_for_claude_session({ sessionId: TARGET_SESSION_ID, timeoutMs: 300 });
  assert.equal(result.result, "timeout", `old message must not resolve a new wait (got ${result.result}: ${result.message?.body})`);
  cleanup(sb);
}

// P4-06: only mail addressed to the caller resolves the wait.
{
  const sb = makeSandbox();
  const handlers = makeWaitHandler({
    host: "claude",
    resolveCurrentSession: () => ({ sessionId: "local_waiter", cliSessionId: "uuid-waiter" }),
    listSessions: () => [{ ...LOADED_SESSION, loaded: false }],
    mailboxOpener: () => openMailbox({ mailboxPath: sb.mailboxPath })
  });
  setTimeout(() => {
    insertReply({ mailboxPath: sb.mailboxPath, fromSessionId: TARGET_SESSION_ID, toSessionId: "local_bystander", body: "for someone else" });
  }, 30);
  setTimeout(() => {
    insertReply({ mailboxPath: sb.mailboxPath, fromSessionId: TARGET_SESSION_ID, toSessionId: "uuid-waiter", body: "for the waiter" });
  }, 400);
  const result = await handlers.wait_for_claude_session({ sessionId: TARGET_SESSION_ID, timeoutMs: 2000 });
  assert.equal(result.result, "reply");
  assert.equal(envelopeBody(result.message.envelope), "for the waiter", "mail to another recipient must not resolve the wait");
  cleanup(sb);
}

// P4-06: waiting by cliSessionId matches messages sent under the sidecar
// sessionId (and vice versa).
{
  const sb = makeSandbox();
  const handlers = makeHandler({ mailboxPath: sb.mailboxPath, sessionsFn: () => [{ ...LOADED_SESSION, loaded: false }] });
  setTimeout(() => {
    insertReply({ mailboxPath: sb.mailboxPath, fromSessionId: TARGET_SESSION_ID, toSessionId: "external", body: "sent under the sidecar id" });
  }, 30);
  const result = await handlers.wait_for_claude_session({ sessionId: "uuid-aaa", timeoutMs: 2000 });
  assert.equal(result.result, "reply", `cliSessionId input must match (got ${result.result})`);
  assert.equal(envelopeBody(result.message.envelope), "sent under the sidecar id");
  cleanup(sb);
}

// M3: target.sessionId is the stored id, whatever form the caller passed
// (here an address); target.address is the canonical address.
{
  const sb = makeSandbox();
  const handlers = makeHandler({ mailboxPath: sb.mailboxPath, sessionsFn: () => [{ ...LOADED_SESSION, loaded: false }] });
  const result = await handlers.wait_for_claude_session({ sessionId: "claude:uuid-aaa", timeoutMs: 0 });
  assert.equal(result.outcome, "timeout");
  assert.deepEqual(result.target, { sessionId: TARGET_SESSION_ID, address: "claude:uuid-aaa" });
  assert.equal(result.sessionId, TARGET_SESSION_ID);
  cleanup(sb);
}

// W2B-10: an archived session can be waited on by exact id through the
// default session index (which used to drop archived sessions).
{
  const sb = makeSandbox();
  const codeRoot = path.join(sb.tmp, "claude-code-sessions");
  fs.mkdirSync(path.join(codeRoot, "acct", "org"), { recursive: true });
  fs.writeFileSync(path.join(codeRoot, "acct", "org", "local_arch.json"), JSON.stringify({
    sessionId: "local_arch", cliSessionId: "uuid-arch", cwd: "/x", model: "opus", title: "Archived", isArchived: true
  }));
  const handlers = makeWaitHandler({
    listOptions: {
      desktopRoot: path.join(sb.tmp, "none"),
      codeRoot,
      projectsRoot: path.join(sb.tmp, "no-projects"),
      psOutput: ""
    },
    mailboxOpener: () => openMailbox({ mailboxPath: sb.mailboxPath })
  });
  const result = await handlers.wait_for_claude_session({ sessionId: "local_arch", timeoutMs: 50 });
  assert.equal(result.error, undefined, "archived session must not be not_found");
  assert.equal(result.result, "timeout");
  const byCli = await handlers.wait_for_claude_session({ sessionId: "uuid-arch", timeoutMs: 50 });
  assert.equal(byCli.result, "timeout");
  cleanup(sb);
}

// Test 4: Timeout — no reply, no idle transition. With a session that
// was never loaded, the idle-transition check is skipped entirely, so
// only the mailbox poll runs.
{
  const sb = makeSandbox();
  const handlers = makeHandler({
    mailboxPath: sb.mailboxPath,
    sessionsFn: () => [{ ...LOADED_SESSION, loaded: false }]
  });

  const started = Date.now();
  const result = await handlers.wait_for_claude_session({
    sessionId: TARGET_SESSION_ID,
    timeoutMs: 200
  });
  const elapsed = Date.now() - started;

  assert.equal(result.error, undefined);
  assert.equal(result.result, "timeout");
  assert.equal(result.sessionId, TARGET_SESSION_ID);
  assert.ok(elapsed >= 200, `expected wait >= 200ms, got ${elapsed}`);
  assert.ok(elapsed < 2000, `expected wait far below 2s, got ${elapsed}`);
  cleanup(sb);
}

// Test 5: Session not found — synthetic registry has no matching id.
// Should return immediately without polling.
{
  const sb = makeSandbox();
  const handlers = makeHandler({
    mailboxPath: sb.mailboxPath,
    sessionsFn: () => [{ ...LOADED_SESSION, sessionId: "local_other" }]
  });

  const started = Date.now();
  await assert.rejects(handlers.wait_for_claude_session({
    sessionId: TARGET_SESSION_ID,
    timeoutMs: 5000
  }), (error) => {
    assert.equal(error.errorCode, "not_found");
    assert.equal(error.details.query, TARGET_SESSION_ID);
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 100, `expected immediate return for not_found, got ${elapsed}ms`);
  cleanup(sb);
}

// Review item 3: a reply returned by wait_for_claude_session counts as
// delivered. B waits on A, A replies to B, the wait returns the reply, and
// B's inbox then returns nothing.
{
  const sb = makeSandbox();
  const { makeReadInboxHandler } = await import("../../src/tools/read-inbox.js");
  const B = { sessionId: "local_bbbbbbbb-0000-4000-8000-00000000000b", cliSessionId: "bbbbbbbb-1111-4000-8000-00000000000b" };
  const open = () => openMailbox({ mailboxPath: sb.mailboxPath });
  const handlers = makeWaitHandler({
    host: "claude",
    resolveCurrentSession: () => B,
    listSessions: () => [{ ...LOADED_SESSION, loaded: false }],
    mailboxOpener: open
  });
  const question = insertReply({ mailboxPath: sb.mailboxPath, fromSessionId: B.sessionId, toSessionId: TARGET_SESSION_ID, body: "question" });
  setTimeout(() => {
    insertReply({ mailboxPath: sb.mailboxPath, fromSessionId: TARGET_SESSION_ID, toSessionId: B.sessionId, body: "answer", replyToMessageId: question });
  }, 50);
  const result = await handlers.wait_for_claude_session({ sessionId: TARGET_SESSION_ID, latestMessageId: question, timeoutMs: 2000 });
  assert.equal(envelopeBody(result.message.envelope), "answer");
  const inbox = await makeReadInboxHandler({ mailboxOpener: open, resolveCurrentSession: () => B }).read_agent_link_inbox({});
  assert.deepEqual(inbox.messages, [], "a reply returned by the wait must not be delivered again");
  const mb = open();
  const stored = mb.getMessage({ messageId: result.message.id });
  mb.close();
  assert.ok(stored.delivered_at && stored.acknowledged_at);
  cleanup(sb);
}

// Review item 4: the tool description states the new semantics.
{
  const { claudeWaitTool } = await import("../../src/tools/claude-wait.js");
  assert.match(claudeWaitTool.description, /addressed to the caller/);
  assert.match(claudeWaitTool.description, /after the wait started/);
  assert.match(claudeWaitTool.inputSchema.properties.replyToMessageId.description, /^Recommended/);
  assert.deepEqual(claudeWaitTool.aliases, [{ canonical: "replyToMessageId", aliases: ["latestMessageId"] }]);
}

console.log("claude-wait tests passed");
