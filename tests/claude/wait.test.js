// tests/claude/wait.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openMailbox } from "../../src/claude/mailbox.js";
import { makeWaitHandler } from "../../src/tools/claude-wait.js";

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
  const dbPath = path.join(tmp, "mailbox.sqlite");
  return { tmp, dbPath };
}

function cleanup({ tmp }) {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function makeHandler({ dbPath, sessionsFn }) {
  return makeWaitHandler({
    listSessions: sessionsFn,
    mailboxOpener: () => openMailbox({ dbPath })
  });
}

function insertReply({ dbPath, fromSessionId, toSessionId, body, replyToMessageId = null }) {
  const mb = openMailbox({ dbPath });
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
    dbPath: sb.dbPath,
    sessionsFn: () => [LOADED_SESSION]
  });

  const latestMessageId = "01HFAKEOUTBOUNDIDX12345678";

  // Reply arrives ~50ms in.
  const insertedIdPromise = new Promise((resolve) => {
    setTimeout(() => {
      const id = insertReply({
        dbPath: sb.dbPath,
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
  assert.equal(result.result, "reply");
  assert.equal(result.sessionId, TARGET_SESSION_ID);
  assert.ok(result.message, "message field populated");
  assert.equal(result.message.id, insertedId);
  assert.equal(result.message.body, "thanks for the ping");
  assert.equal(result.message.from_session_id, TARGET_SESSION_ID);
  assert.equal(result.message.reply_to_message_id, latestMessageId);
  cleanup(sb);
}

// Test 2: Reply path without latestMessageId — any inbound from the
// target session resolves the wait, even non-reply messages.
{
  const sb = makeSandbox();
  const handlers = makeHandler({
    dbPath: sb.dbPath,
    sessionsFn: () => [LOADED_SESSION]
  });

  setTimeout(() => {
    insertReply({
      dbPath: sb.dbPath,
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
  assert.equal(result.message.body, "fresh inbound, not a reply");
  assert.equal(result.message.reply_to_message_id, null);
  assert.equal(result.message.from_session_id, TARGET_SESSION_ID);
  cleanup(sb);
}

// Test 3: Idle transition — listSessions reports loaded=true on the
// first call, loaded=false on subsequent calls. The handler should
// detect the transition and return result: "idle".
{
  const sb = makeSandbox();
  let listCalls = 0;
  const sessionsFn = () => {
    listCalls += 1;
    return [
      {
        ...LOADED_SESSION,
        // First call (priming check inside handler) sees loaded=true; any
        // subsequent call sees loaded=false to simulate the session ending
        // its turn and dropping out of the ps view.
        loaded: listCalls <= 1
      }
    ];
  };
  const handlers = makeHandler({ dbPath: sb.dbPath, sessionsFn });

  const result = await handlers.wait_for_claude_session({
    sessionId: TARGET_SESSION_ID,
    timeoutMs: 2000
  });

  assert.equal(result.error, undefined);
  assert.equal(result.result, "idle");
  assert.equal(result.target.sessionId, TARGET_SESSION_ID);
  assert.equal(result.target.lastLoaded, false);
  assert.ok(listCalls >= 2, `expected at least 2 listSessions calls, got ${listCalls}`);
  cleanup(sb);
}

// Test 4: Timeout — no reply, no idle transition. With a session that
// was never loaded, the idle-transition check is skipped entirely, so
// only the mailbox poll runs.
{
  const sb = makeSandbox();
  const handlers = makeHandler({
    dbPath: sb.dbPath,
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
    dbPath: sb.dbPath,
    sessionsFn: () => [{ ...LOADED_SESSION, sessionId: "local_other" }]
  });

  const started = Date.now();
  const result = await handlers.wait_for_claude_session({
    sessionId: TARGET_SESSION_ID,
    timeoutMs: 5000
  });
  const elapsed = Date.now() - started;

  assert.equal(result.error, "not_found");
  assert.equal(result.sessionId, TARGET_SESSION_ID);
  assert.equal(result.result, undefined);
  assert.ok(elapsed < 100, `expected immediate return for not_found, got ${elapsed}ms`);
  cleanup(sb);
}

console.log("claude-wait tests passed");
