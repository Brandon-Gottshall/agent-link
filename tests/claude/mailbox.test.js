// tests/claude/mailbox.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openMailbox, resolveMailboxPath } from "../../src/claude/mailbox.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-mailbox-"));
const mailboxPath = path.join(tmp, "mailbox.jsonl");

// Path resolution prefers the new JSONL path and maps legacy .sqlite paths.
{
  assert.equal(resolveMailboxPath({ mailboxPath }), mailboxPath);
  assert.equal(
    resolveMailboxPath({ dbPath: path.join(tmp, "legacy.sqlite") }),
    path.join(tmp, "legacy.jsonl")
  );
}

// Insert + reopen + drain roundtrip uses append-only JSONL events.
{
  const mb = openMailbox({ mailboxPath });
  const id = mb.insertMessage({
    fromSessionId: "local_a",
    fromSessionKind: "claude",
    toSessionId: "local_b",
    toSessionKind: "claude",
    body: "Hello from A",
    metadata: { receipt: { purpose: "test" } }
  });
  assert.match(id, /^[0-9A-Z]{26}$/);
  mb.close();

  assert.ok(fs.existsSync(mailboxPath), "mailbox is a JSONL file");
  const lines = fs.readFileSync(mailboxPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].type, "message");
  assert.equal(lines[0].message.id, id);

  const reopened = openMailbox({ mailboxPath });
  const pending = reopened.listPendingFor({ toSessionId: "local_b" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].body, "Hello from A");

  const drained = reopened.drainFor({ toSessionId: "local_b" });
  assert.equal(drained.length, 1);
  assert.equal(reopened.listPendingFor({ toSessionId: "local_b" }).length, 0);
  assert.ok(reopened.inspect({ toSessionId: "local_b" })[0].delivered_at, "drain appends delivered state");
  reopened.close();
}

// Ack closes the loop and writes a linked reply message.
{
  const mb = openMailbox({ mailboxPath });
  const id = mb.insertMessage({
    fromSessionId: "local_a",
    fromSessionKind: "claude",
    toSessionId: "local_b",
    toSessionKind: "claude",
    body: "ack me"
  });
  mb.drainFor({ toSessionId: "local_b" });
  mb.ackMessage({ messageId: id, body: "got it" });
  const replies = mb.inspect({ replyToMessageId: id });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].from_session_id, "local_b");
  assert.equal(replies[0].to_session_id, "local_a");
  assert.equal(replies[0].body, "got it");
  assert.ok(mb.inspect({ toSessionId: "local_b" }).find((m) => m.id === id).acknowledged_at);
  mb.close();
}

fs.rmSync(tmp, { recursive: true });
console.log("mailbox tests passed");
