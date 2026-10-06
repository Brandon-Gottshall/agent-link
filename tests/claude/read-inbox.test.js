// tests/claude/read-inbox.test.js
//
// Verifies the read_agent_link_inbox MCP tool: returns pending messages for
// the current session as a visible MCP tool result, marks them delivered in
// the same transaction by default, and supports limit + idempotent inspection
// (markAsDelivered:false).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openMailbox } from "../../src/claude/mailbox.js";
import { makeReadInboxHandler, readInboxTool } from "../../src/tools/read-inbox.js";

function makeSandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-readinbox-"));
  return { tmp, dbPath: path.join(tmp, "mailbox.sqlite") };
}

function cleanup(sb) {
  fs.rmSync(sb.tmp, { recursive: true, force: true });
}

function makeHandler({ dbPath, session }) {
  return makeReadInboxHandler({
    resolveCurrentSession: () => session,
    mailboxOpener: () => openMailbox({ dbPath })
  });
}

const SESSION_ME = { sessionId: "local_me", cliSessionId: "fake-cli-id", title: "me" };

// Sanity: tool def shape.
{
  assert.equal(readInboxTool.name, "read_agent_link_inbox");
  assert.ok(typeof readInboxTool.description === "string" && readInboxTool.description.length > 0);
  assert.match(readInboxTool.description, /visible/i, "description must mention visibility");
  assert.equal(readInboxTool.inputSchema.type, "object");
}

// Test 1: first call returns both messages, renders the block, marks them delivered.
// Test 2 (combined): second call returns 0 messages.
{
  const sb = makeSandbox();
  const mb = openMailbox({ dbPath: sb.dbPath });
  mb.insertMessage({
    fromSessionId: "local_a",
    fromSessionKind: "claude",
    toSessionId: "local_me",
    toSessionKind: "claude",
    body: "first"
  });
  mb.insertMessage({
    fromSessionId: "local_b",
    fromSessionKind: "claude",
    toSessionId: "local_me",
    toSessionKind: "claude",
    body: "second"
  });
  mb.close();

  const handler = makeHandler({ dbPath: sb.dbPath, session: SESSION_ME });

  const r1 = await handler.read_agent_link_inbox({});
  assert.equal(r1.messages.length, 2, "first call returns both pending messages");
  assert.equal(r1.messages[0].body, "first");
  assert.equal(r1.messages[1].body, "second");
  assert.equal(r1.sessionId, "local_me", "result includes current sessionId");
  assert.match(r1.renderedBlock, /<agent-link-inbox count="2">/);
  assert.match(r1.renderedBlock, /first/);
  assert.match(r1.renderedBlock, /second/);

  // Verify they were marked delivered in the DB.
  const mbCheck = openMailbox({ dbPath: sb.dbPath });
  const stillPending = mbCheck.listPendingFor({ toSessionId: "local_me" });
  mbCheck.close();
  assert.equal(stillPending.length, 0, "messages should be drained after default read");

  // Second call returns nothing.
  const r2 = await handler.read_agent_link_inbox({});
  assert.equal(r2.messages.length, 0);
  assert.match(r2.renderedBlock, /count="0"/);

  cleanup(sb);
}

// Test 3: markAsDelivered:false returns pending messages without draining.
{
  const sb = makeSandbox();
  const mb = openMailbox({ dbPath: sb.dbPath });
  mb.insertMessage({
    fromSessionId: "local_c",
    fromSessionKind: "claude",
    toSessionId: "local_me",
    toSessionKind: "claude",
    body: "third"
  });
  mb.close();

  const handler = makeHandler({ dbPath: sb.dbPath, session: SESSION_ME });

  const r1 = await handler.read_agent_link_inbox({ markAsDelivered: false });
  assert.equal(r1.messages.length, 1);
  assert.equal(r1.messages[0].body, "third");

  // Still pending — next default call must still find it.
  const r2 = await handler.read_agent_link_inbox({});
  assert.equal(r2.messages.length, 1, "markAsDelivered:false must leave message pending");
  assert.equal(r2.messages[0].body, "third");

  // Now it has been drained.
  const r3 = await handler.read_agent_link_inbox({});
  assert.equal(r3.messages.length, 0);

  cleanup(sb);
}

// Test 4: limit caps the number of returned messages.
{
  const sb = makeSandbox();
  const mb = openMailbox({ dbPath: sb.dbPath });
  for (let i = 0; i < 3; i++) {
    mb.insertMessage({
      fromSessionId: `local_n${i}`,
      fromSessionKind: "claude",
      toSessionId: "local_me",
      toSessionKind: "claude",
      body: `msg-${i}`
    });
  }
  mb.close();

  const handler = makeHandler({ dbPath: sb.dbPath, session: SESSION_ME });

  // limit:1 + markAsDelivered:false so we can verify count, and so the
  // remaining messages stay pending for later reads.
  const r = await handler.read_agent_link_inbox({ limit: 1, markAsDelivered: false });
  assert.equal(r.messages.length, 1, "limit:1 must cap the returned messages at 1");
  assert.match(r.renderedBlock, /count="1"/);

  cleanup(sb);
}

// Test 5: result includes sessionId of current session.
{
  const sb = makeSandbox();
  const handler = makeHandler({ dbPath: sb.dbPath, session: SESSION_ME });
  const r = await handler.read_agent_link_inbox({});
  assert.equal(r.sessionId, "local_me");
  cleanup(sb);
}

// Test 6: no current session resolvable -> returns {error: "no_current_session"}.
{
  const sb = makeSandbox();
  const handler = makeHandler({ dbPath: sb.dbPath, session: null });
  const r = await handler.read_agent_link_inbox({});
  assert.equal(r.error, "no_current_session");
  assert.deepEqual(r.messages, []);
  cleanup(sb);
}

console.log("read-inbox tests passed");
