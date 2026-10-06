// tests/claude/send.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openMailbox } from "../../src/claude/mailbox.js";
import { makeClaudeSendHandler } from "../../src/tools/claude-send.js";
import { listReceipts } from "../../src/shared/receipt-index.js";

const SESSIONS = [
  {
    sessionId: "local_aaa1111",
    cliSessionId: "uuid-aaa",
    title: "Investigate flaky tests",
    processName: "blissful-wonderful-goldberg",
    cwd: "/sessions/blissful-wonderful-goldberg",
    userSelectedFolders: ["/Users/x/courses"],
    loaded: true
  },
  {
    sessionId: "local_bbb2222",
    cliSessionId: "uuid-bbb",
    title: "Refactor payment retry logic",
    processName: "calm-electric-rabbit",
    cwd: "/sessions/calm-electric-rabbit",
    userSelectedFolders: ["/Users/x/work/payments"],
    loaded: false
  },
  {
    sessionId: "local_ccc3333",
    cliSessionId: "uuid-ccc",
    title: "Investigate game subject",
    processName: "lazy-quiet-otter",
    cwd: "/sessions/lazy-quiet-otter",
    userSelectedFolders: [],
    loaded: false
  }
];

function makeSandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-send-"));
  const dbPath = path.join(tmp, "mailbox.sqlite");
  const receiptLog = path.join(tmp, "receipts.jsonl");
  return { tmp, dbPath, receiptLog };
}

function makeHandler({ dbPath, sessions = SESSIONS, host = "claude" }) {
  return makeClaudeSendHandler({
    host,
    listSessions: () => sessions,
    mailboxOpener: () => openMailbox({ dbPath })
  });
}

function cleanup({ tmp, receiptLog }) {
  // unset receipt env so subsequent test blocks rebind it
  delete process.env.CODEX_AGENT_LINK_RECEIPT_LOG;
  if (receiptLog && fs.existsSync(receiptLog)) {
    // ok to keep, tmp dir is removed below
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Test 1: exact-id match → success, queued-online, mailbox insert, receipt written
{
  const sb = makeSandbox();
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = sb.receiptLog;
  const handlers = makeHandler({ dbPath: sb.dbPath });

  const result = await handlers.message_claude_session({
    to: "local_aaa1111",
    body: "Hello loaded session",
    receipt: { purpose: "test-exact" }
  });

  assert.equal(result.error, undefined, "no error for exact match");
  assert.match(result.messageId, /^[0-9A-Z]{26}$/);
  assert.equal(result.delivery, "queued-online");
  assert.equal(result.target.sessionId, "local_aaa1111");
  assert.equal(result.target.loaded, true);
  assert.equal(result.target.title, "Investigate flaky tests");

  // Mailbox row inserted
  const mb = openMailbox({ dbPath: sb.dbPath });
  const rows = mb.inspect({ toSessionId: "local_aaa1111" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, result.messageId);
  assert.equal(rows[0].body, "Hello loaded session");
  const meta = JSON.parse(rows[0].metadata_json);
  assert.equal(meta.receipt.purpose, "test-exact");
  // resolution recorded too (even for exact id matches, we capture how we got there)
  assert.ok(meta.resolution);
  assert.equal(meta.resolution.via, "exact");
  mb.close();

  // Receipt written
  const receipts = await listReceipts();
  assert.equal(receipts.data.length, 1);
  assert.equal(receipts.data[0].action, "message_claude_session");
  assert.equal(receipts.data[0].purpose, "test-exact");
  cleanup(sb);
}

// Test 2: fuzzy resolve → success with matchReasons populated
{
  const sb = makeSandbox();
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = sb.receiptLog;
  const handlers = makeHandler({ dbPath: sb.dbPath });

  const result = await handlers.message_claude_session({
    to: "payment retry",
    body: "fuzzy payload"
  });

  assert.equal(result.error, undefined);
  assert.equal(result.target.sessionId, "local_bbb2222");
  assert.equal(result.delivery, "queued-offline"); // not loaded
  assert.ok(Array.isArray(result.resolution.matchReasons));
  assert.ok(result.resolution.matchReasons.includes("title-substring"));

  // Mailbox row metadata stores the resolution audit
  const mb = openMailbox({ dbPath: sb.dbPath });
  const rows = mb.inspect({ toSessionId: "local_bbb2222" });
  assert.equal(rows.length, 1);
  const meta = JSON.parse(rows[0].metadata_json);
  assert.equal(meta.resolution.via, "fuzzy");
  assert.ok(meta.resolution.matchReasons.includes("title-substring"));
  mb.close();
  cleanup(sb);
}

// Test 3: ambiguous resolve → returns error.ambiguous + candidates; NO insert; NO receipt
{
  const sb = makeSandbox();
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = sb.receiptLog;
  const handlers = makeHandler({ dbPath: sb.dbPath });

  const result = await handlers.message_claude_session({
    to: "Investigate",
    body: "should not insert"
  });

  assert.equal(result.error, "ambiguous");
  assert.ok(Array.isArray(result.candidates));
  assert.ok(result.candidates.length >= 2);
  assert.equal(result.messageId, undefined);
  assert.equal(result.delivery, undefined);

  // No mailbox rows
  const mb = openMailbox({ dbPath: sb.dbPath });
  assert.equal(mb.inspect({}).length, 0);
  mb.close();

  // No receipt written
  const receipts = await listReceipts();
  assert.equal(receipts.data.length, 0);
  cleanup(sb);
}

// Test 4: not-found → returns error.not_found, empty candidates; no insert/receipt
{
  const sb = makeSandbox();
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = sb.receiptLog;
  const handlers = makeHandler({ dbPath: sb.dbPath });

  const result = await handlers.message_claude_session({
    to: "xyz-no-such-query-1234",
    body: "should not insert"
  });

  assert.equal(result.error, "not_found");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.messageId, undefined);

  const mb = openMailbox({ dbPath: sb.dbPath });
  assert.equal(mb.inspect({}).length, 0);
  mb.close();

  const receipts = await listReceipts();
  assert.equal(receipts.data.length, 0);
  cleanup(sb);
}

// Test 5: waitForReply=true with no reply within timeout → returns received:false, error:"timeout"
{
  const sb = makeSandbox();
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = sb.receiptLog;
  const handlers = makeHandler({ dbPath: sb.dbPath });

  const started = Date.now();
  const result = await handlers.message_claude_session({
    to: "local_bbb2222",
    body: "ping",
    waitForReply: true,
    timeoutMs: 200
  });
  const elapsed = Date.now() - started;

  assert.equal(result.error, undefined);
  assert.ok(result.replyConfirmation);
  assert.equal(result.replyConfirmation.received, false);
  assert.equal(result.replyConfirmation.error, "timeout");
  assert.ok(elapsed >= 200, `expected wait >= 200ms, got ${elapsed}`);
  assert.ok(elapsed < 2000, `expected wait far below 2s, got ${elapsed}`);
  cleanup(sb);
}

// Test 6: waitForReply=true with a reply written mid-flight → received:true, body, replyMessageId
{
  const sb = makeSandbox();
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = sb.receiptLog;
  const handlers = makeHandler({ dbPath: sb.dbPath });

  // Run the handler and concurrently insert a reply ~75ms later via a separate mailbox handle
  const sendPromise = handlers.message_claude_session({
    to: "local_aaa1111",
    body: "ping with wait",
    waitForReply: true,
    timeoutMs: 2000
  });

  setTimeout(() => {
    const mb = openMailbox({ dbPath: sb.dbPath });
    try {
      // Find the in-flight message and ack it with a body so the mailbox writes a reply row.
      const pending = mb.inspect({ toSessionId: "local_aaa1111", limit: 1 });
      assert.equal(pending.length, 1, "expected the message to be visible to the replier");
      mb.ackMessage({ messageId: pending[0].id, body: "pong" });
    } finally {
      mb.close();
    }
  }, 75);

  const result = await sendPromise;
  assert.equal(result.error, undefined);
  assert.ok(result.replyConfirmation);
  assert.equal(result.replyConfirmation.received, true);
  assert.equal(result.replyConfirmation.body, "pong");
  assert.match(result.replyConfirmation.replyMessageId, /^[0-9A-Z]{26}$/);
  cleanup(sb);
}

// Bonus: receipt.record === false suppresses the receipt
{
  const sb = makeSandbox();
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = sb.receiptLog;
  const handlers = makeHandler({ dbPath: sb.dbPath });

  const result = await handlers.message_claude_session({
    to: "local_aaa1111",
    body: "quiet send",
    receipt: { record: false, purpose: "shouldnt-log" }
  });
  assert.equal(result.error, undefined);

  const receipts = await listReceipts();
  assert.equal(receipts.data.length, 0, "no receipt should be written when record=false");

  // But the mailbox insert still happened
  const mb = openMailbox({ dbPath: sb.dbPath });
  assert.equal(mb.inspect({}).length, 1);
  mb.close();
  cleanup(sb);
}

console.log("claude-send tests passed");
