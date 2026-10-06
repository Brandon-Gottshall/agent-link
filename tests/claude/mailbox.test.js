// tests/claude/mailbox.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openMailbox, resolveMailboxPath } from "../../src/claude/mailbox.js";
import { envelopeBodies, envelopeBody } from "../helpers/envelope-body.js";

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

// P4-09: ackMessage returns the reply id it wrote.
{
  const mb = openMailbox({ mailboxPath });
  const id = mb.insertMessage({ fromSessionId: "local_a", fromSessionKind: "claude", toSessionId: "local_b", toSessionKind: "claude", body: "q" });
  const replyId = mb.ackMessage({ messageId: id, body: "a" });
  assert.match(String(replyId), /^[0-9A-Z]{26}$/, "ackMessage returns the reply id");
  assert.equal(mb.getMessage({ messageId: replyId }).reply_to_message_id, id);
  mb.close();
}

// P4-05: drainFor with a limit marks only the returned messages delivered.
// P4-04: toSessionIds matches every id form of one recipient.
{
  const p = path.join(tmp, "drain-limit.jsonl");
  const mb = openMailbox({ mailboxPath: p });
  for (const to of ["local_me", "cli-me", "local_cli-me", "local_someone-else"]) {
    mb.insertMessage({ fromSessionId: "local_x", fromSessionKind: "claude", toSessionId: to, toSessionKind: "claude", body: `to ${to}` });
  }
  const ids = ["local_me", "cli-me", "local_cli-me"];
  assert.equal(mb.listPendingFor({ toSessionIds: ids }).length, 3);
  const first = mb.drainFor({ toSessionIds: ids, limit: 1 });
  assert.equal(first.length, 1);
  assert.equal(mb.listPendingFor({ toSessionIds: ids }).length, 2, "messages beyond the limit stay pending");
  assert.equal(mb.drainFor({ toSessionIds: ids }).length, 2);
  assert.equal(mb.listPendingFor({ toSessionId: "local_someone-else" }).length, 1, "other recipients untouched");
  mb.close();
}

// P4-10: a released delivery claim makes the message pending again.
{
  const p = path.join(tmp, "release.jsonl");
  const mb = openMailbox({ mailboxPath: p });
  const id = mb.insertMessage({ fromSessionId: "local_x", fromSessionKind: "codex", toSessionId: "local_me", toSessionKind: "claude", body: "retry me" });
  mb.markDelivered({ messageId: id });
  assert.equal(mb.listPendingFor({ toSessionId: "local_me" }).length, 0);
  mb.releaseDelivery({ messageId: id });
  assert.equal(mb.listPendingFor({ toSessionId: "local_me" }).length, 1);
  mb.close();
}

// W2A-08: bodies over 64 KiB are refused, even by direct inserts.
{
  const mb = openMailbox({ mailboxPath: path.join(tmp, "cap.jsonl") });
  const ok = "y".repeat(64 * 1024);
  mb.insertMessage({ fromSessionId: "a", fromSessionKind: "claude", toSessionId: "b", toSessionKind: "claude", body: ok });
  assert.throws(
    () => mb.insertMessage({ fromSessionId: "a", fromSessionKind: "claude", toSessionId: "b", toSessionKind: "claude", body: ok + "y" }),
    /64 KiB/
  );
  mb.close();
}

// W2A-09: a new mailbox directory is 0700 and the mailbox file 0600; an
// existing world-readable mailbox file is tightened.
{
  const dir = path.join(tmp, "private-dir", "nested");
  const p = path.join(dir, "mailbox.jsonl");
  const mb = openMailbox({ mailboxPath: p });
  mb.insertMessage({ fromSessionId: "a", fromSessionKind: "claude", toSessionId: "b", toSessionKind: "claude", body: "secret" });
  mb.close();
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "mailbox dir must be 0700");
  assert.equal(fs.statSync(p).mode & 0o777, 0o600, "mailbox file must be 0600");

  const loose = path.join(tmp, "loose.jsonl");
  fs.writeFileSync(loose, "", { mode: 0o644 });
  fs.chmodSync(loose, 0o644);
  openMailbox({ mailboxPath: loose }).close();
  assert.equal(fs.statSync(loose).mode & 0o777, 0o600, "existing mailbox file is tightened to 0600");
}

// P4-12: explicit options win over environment variables.
{
  const envPath = path.join(tmp, "from-env.jsonl");
  const explicitDb = path.join(tmp, "explicit.sqlite");
  const prevPath = process.env.AGENT_LINK_MAILBOX_PATH;
  const prevDb = process.env.AGENT_LINK_MAILBOX_DB;
  process.env.AGENT_LINK_MAILBOX_PATH = envPath;
  process.env.AGENT_LINK_MAILBOX_DB = path.join(tmp, "env-legacy.sqlite");
  try {
    assert.equal(resolveMailboxPath({ dbPath: explicitDb }), path.join(tmp, "explicit.jsonl"), "explicit dbPath beats AGENT_LINK_MAILBOX_PATH");
    assert.equal(resolveMailboxPath({ mailboxPath }), mailboxPath);
    assert.equal(resolveMailboxPath(), envPath, "env applies when nothing explicit is given");
  } finally {
    if (prevPath === undefined) delete process.env.AGENT_LINK_MAILBOX_PATH;
    else process.env.AGENT_LINK_MAILBOX_PATH = prevPath;
    if (prevDb === undefined) delete process.env.AGENT_LINK_MAILBOX_DB;
    else process.env.AGENT_LINK_MAILBOX_DB = prevDb;
  }
}

// P4-14: a record without sent_at gets a deterministic timestamp (its event
// time, else 0), not the time of each read.
{
  const p = path.join(tmp, "no-sent-at.jsonl");
  fs.writeFileSync(p, [
    JSON.stringify({ type: "message", at: 1700000000000, message: { id: "M1", from_session_id: "a", from_session_kind: "claude", to_session_id: "b", to_session_kind: "claude", body: "x" } }),
    JSON.stringify({ type: "message", message: { id: "M2", from_session_id: "a", from_session_kind: "claude", to_session_id: "b", to_session_kind: "claude", body: "y" } })
  ].join("\n") + "\n");
  const mb = openMailbox({ mailboxPath: p });
  const first = mb.getMessage({ messageId: "M1" }).sent_at;
  const second = mb.getMessage({ messageId: "M2" }).sent_at;
  assert.equal(first, 1700000000000);
  assert.equal(second, 0);
  assert.equal(mb.getMessage({ messageId: "M2" }).sent_at, second, "stable across reads");
  mb.close();
}

// W2A-10: agent_link_mailbox_inspect returns only the caller's mail unless
// scope:"all" is passed explicitly.
{
  const p = path.join(tmp, "inspect-scope.jsonl");
  const mb = openMailbox({ mailboxPath: p });
  mb.insertMessage({ fromSessionId: "local_other", fromSessionKind: "claude", toSessionId: "local_me", toSessionKind: "claude", body: "to me" });
  mb.insertMessage({ fromSessionId: "local_me", fromSessionKind: "claude", toSessionId: "local_other", toSessionKind: "claude", body: "from me" });
  mb.insertMessage({ fromSessionId: "local_other", fromSessionKind: "claude", toSessionId: "local_third", toSessionKind: "claude", body: "not mine" });
  mb.close();
  const { makeMailboxInspectHandler } = await import("../../src/tools/mailbox-inspect.js");
  const handlers = makeMailboxInspectHandler({
    host: "claude",
    mailboxOpener: () => openMailbox({ mailboxPath: p }),
    resolveCurrentSession: () => ({ sessionId: "local_me", cliSessionId: "cli-me" })
  });
  const mine = await handlers.agent_link_mailbox_inspect({});
  assert.equal(mine.messages.length, 2);
  assert.ok(mine.messages.every((m) => !("body" in m) && !("envelope" in m) && !("metadata_json" in m)), "no bodies by default");
  assert.ok(!JSON.stringify(mine).includes("to me"));
  const withBodies = await handlers.agent_link_mailbox_inspect({ includeBodies: true });
  assert.deepEqual(withBodies.messages.map((m) => envelopeBody(m.envelope)).sort(), ["from me", "to me"]);
  const filtered = await handlers.agent_link_mailbox_inspect({ toSessionId: "local_third" });
  assert.equal(filtered.messages.length, 0, "filters cannot widen past the caller's mail");
  const all = await handlers.agent_link_mailbox_inspect({ scope: "all" });
  assert.equal(all.messages.length, 3);
}

// W2A-08 (review item 1): the whole serialized event line is capped, so
// metadata cannot bypass the body cap.
{
  const p = path.join(tmp, "line-cap.jsonl");
  const mb = openMailbox({ mailboxPath: p });
  assert.throws(
    () => mb.insertMessage({ fromSessionId: "a", fromSessionKind: "claude", toSessionId: "b", toSessionKind: "claude", body: "small", metadata: { note: "n".repeat(600 * 1024) } }),
    /limited to 524288 bytes \(512 KiB\)/
  );
  // A maximal body that JSON escaping expands 6x still fits.
  mb.insertMessage({ fromSessionId: "a", fromSessionKind: "claude", toSessionId: "b", toSessionKind: "claude", body: "\u0001".repeat(64 * 1024) });
  mb.close();
  assert.ok(fs.statSync(p).size < 512 * 1024);
}

// W2A-10 (review item 7): an unresolved caller (fallback "external") sees
// no mail by default, not every other unresolved caller's mail.
{
  const p = path.join(tmp, "inspect-unresolved.jsonl");
  const mb = openMailbox({ mailboxPath: p });
  mb.insertMessage({ fromSessionId: "local_x", fromSessionKind: "claude", toSessionId: "external", toSessionKind: "external", body: "to some external caller" });
  mb.close();
  const { makeMailboxInspectHandler } = await import("../../src/tools/mailbox-inspect.js");
  const handlers = makeMailboxInspectHandler({ host: "unknown", mailboxOpener: () => openMailbox({ mailboxPath: p }) });
  const result = await handlers.agent_link_mailbox_inspect({});
  assert.deepEqual(result.messages, []);
  assert.match(result.note, /Could not identify the calling session/);
  assert.equal((await handlers.agent_link_mailbox_inspect({ scope: "all" })).messages.length, 1);
}

// Health uses mailboxStatus(), which never creates the mailbox dir or file.
{
  const { mailboxStatus } = await import("../../src/claude/mailbox.js");
  const p = path.join(tmp, "not-created", "mailbox.jsonl");
  const status = mailboxStatus({ mailboxPath: p });
  assert.equal(fs.existsSync(path.dirname(p)), false, "status must not create the mailbox dir");
  assert.equal(status.exists, false);
  assert.equal(status.writable, true);
  assert.equal(status.pendingMessagesCount, 0);
  const existing = path.join(tmp, "status.jsonl");
  const mb = openMailbox({ mailboxPath: existing });
  mb.insertMessage({ fromSessionId: "a", fromSessionKind: "claude", toSessionId: "b", toSessionKind: "claude", body: "x" });
  mb.close();
  assert.equal(mailboxStatus({ mailboxPath: existing }).pendingMessagesCount, 1);
}

fs.rmSync(tmp, { recursive: true });
console.log("mailbox tests passed");
