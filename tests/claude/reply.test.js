import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openMailbox } from "../../src/claude/mailbox.js";
import { makeReplyAgentLinkMessageHandler, replyAgentLinkMessageTool } from "../../src/tools/claude-reply.js";
import { listReceipts } from "../../src/shared/receipt-index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-reply-"));
const mailboxPath = path.join(tmp, "mailbox.jsonl");
// Replies write receipts; keep them out of the real receipt log.
process.env.CODEX_AGENT_LINK_RECEIPT_LOG = path.join(tmp, "receipts.jsonl");

assert.equal(replyAgentLinkMessageTool.name, "reply_agent_link_message");

{
  const mb = openMailbox({ mailboxPath });
  const originalId = mb.insertMessage({
    fromSessionId: "local_sender",
    fromSessionKind: "claude",
    toSessionId: "local_receiver",
    toSessionKind: "claude",
    body: "please respond"
  });
  mb.close();

  const handler = makeReplyAgentLinkMessageHandler({
    mailboxOpener: () => openMailbox({ mailboxPath }),
    resolveCurrentSession: () => ({ sessionId: "local_receiver", surface: "code" })
  });

  const result = await handler.reply_agent_link_message({
    messageId: originalId,
    body: "acknowledged"
  });

  assert.equal(result.error, undefined);
  assert.equal(result.replyToMessageId, originalId);
  assert.match(result.messageId, /^[0-9A-Z]{26}$/);

  const check = openMailbox({ mailboxPath });
  const original = check.inspect({ toSessionId: "local_receiver" }).find((m) => m.id === originalId);
  const replies = check.inspect({ replyToMessageId: originalId });
  assert.ok(original.acknowledged_at, "reply helper acknowledges the original");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].from_session_id, "local_receiver");
  assert.equal(replies[0].to_session_id, "local_sender");
  assert.equal(replies[0].body, "acknowledged");
  check.close();
}

{
  const handler = makeReplyAgentLinkMessageHandler({
    mailboxOpener: () => openMailbox({ mailboxPath }),
    resolveCurrentSession: () => ({ sessionId: "local_receiver", surface: "code" })
  });
  const result = await handler.reply_agent_link_message({ messageId: "missing", body: "nope" });
  assert.equal(result.error, "not_found");
}

// P1-15 / W2B-15: a reply writes a reply_message receipt and reports the
// write result.
{
  const receipts = await listReceipts();
  const replyReceipts = receipts.data.filter((r) => r.action === "reply_message");
  assert.equal(replyReceipts.length, 1, "the successful reply above wrote one reply_message receipt");
  assert.equal(replyReceipts[0].target.sessionId, "local_sender");
  assert.equal(replyReceipts[0].target.kind, "claude");
  assert.equal(replyReceipts[0].messagePreview, "acknowledged");

  const mb = openMailbox({ mailboxPath });
  const id = mb.insertMessage({
    fromSessionId: "local_sender",
    fromSessionKind: "codex",
    toSessionId: "local_receiver",
    toSessionKind: "claude",
    body: "receipt please"
  });
  mb.close();
  const handler = makeReplyAgentLinkMessageHandler({
    mailboxOpener: () => openMailbox({ mailboxPath }),
    resolveCurrentSession: () => ({ sessionId: "local_receiver", surface: "code" })
  });
  const result = await handler.reply_agent_link_message({ messageId: id, body: "with receipt" });
  assert.equal(result.receipt?.ok, true);
  assert.equal(result.receipt.recorded, true);
  assert.equal(result.receipt.path, process.env.CODEX_AGENT_LINK_RECEIPT_LOG);
}

// P4-04: mail an older version queued under the raw CLI id (or local_<cli>)
// can be replied to by the session whose canonical id is its sidecar id, and
// the reply comes from the canonical id.
{
  const mb = openMailbox({ mailboxPath });
  const legacyId = mb.insertMessage({
    fromSessionId: "local_sender",
    fromSessionKind: "claude",
    toSessionId: "cli-uuid-receiver",
    toSessionKind: "claude",
    body: "addressed to the raw CLI id"
  });
  mb.close();
  const handler = makeReplyAgentLinkMessageHandler({
    mailboxOpener: () => openMailbox({ mailboxPath }),
    resolveCurrentSession: () => ({ sessionId: "local_receiver", cliSessionId: "cli-uuid-receiver", surface: "code" })
  });
  const result = await handler.reply_agent_link_message({ messageId: legacyId, body: "reply to legacy" });
  assert.equal(result.error, undefined, `legacy-addressed mail must be repliable (got ${result.error})`);
  const check = openMailbox({ mailboxPath });
  const reply = check.getMessage({ messageId: result.messageId });
  check.close();
  assert.equal(reply.from_session_id, "local_receiver");
  assert.equal(reply.to_session_id, "local_sender");

  // Someone else's mail is still refused.
  const other = makeReplyAgentLinkMessageHandler({
    mailboxOpener: () => openMailbox({ mailboxPath }),
    resolveCurrentSession: () => ({ sessionId: "local_bystander", cliSessionId: "cli-bystander" })
  });
  const refused = await other.reply_agent_link_message({ messageId: legacyId, body: "not mine" });
  assert.equal(refused.error, "wrong_recipient");
}

// W2A-08: reply bodies over 64 KiB are refused with a clear error.
{
  const handler = makeReplyAgentLinkMessageHandler({
    mailboxOpener: () => openMailbox({ mailboxPath }),
    resolveCurrentSession: () => ({ sessionId: "local_receiver" })
  });
  const result = await handler.reply_agent_link_message({ messageId: "anything", body: "x".repeat(64 * 1024 + 1) });
  assert.equal(result.error, "invalid_arguments");
  assert.match(result.message, /64 KiB/);
  assert.equal(result.maxBodyBytes, 64 * 1024);
}

// W2A-09 (review item 6): the receipt log's new directory is 0700 and the
// file 0600; an existing world-readable log this user owns is tightened.
{
  const { appendReceipt, buildReceipt } = await import("../../src/shared/receipt-index.js");
  const built = buildReceipt({ action: "reply_message", target: { sessionId: "local_x" }, message: "m" });
  const nestedDir = path.join(tmp, "receipts-dir", "nested");
  const nested = path.join(nestedDir, "receipts.jsonl");
  await appendReceipt(built, { path: nested });
  assert.equal(fs.statSync(nestedDir).mode & 0o777, 0o700, "new receipt dir must be 0700");
  assert.equal(fs.statSync(nested).mode & 0o777, 0o600, "new receipt log must be 0600");
  const loose = path.join(tmp, "loose-receipts.jsonl");
  fs.writeFileSync(loose, "");
  fs.chmodSync(loose, 0o644);
  await appendReceipt(built, { path: loose });
  assert.equal(fs.statSync(loose).mode & 0o777, 0o600, "existing receipt log is tightened to 0600");
  // An existing parent directory is not changed.
  const sharedDir = path.join(tmp, "shared-dir");
  fs.mkdirSync(sharedDir, { mode: 0o755 });
  fs.chmodSync(sharedDir, 0o755);
  await appendReceipt(built, { path: path.join(sharedDir, "r.jsonl") });
  assert.equal(fs.statSync(sharedDir).mode & 0o777, 0o755);
}

delete process.env.CODEX_AGENT_LINK_RECEIPT_LOG;
fs.rmSync(tmp, { recursive: true, force: true });
console.log("claude-reply tests passed");
