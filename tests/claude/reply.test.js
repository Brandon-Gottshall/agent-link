import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openMailbox } from "../../src/claude/mailbox.js";
import { makeReplyAgentLinkMessageHandler, replyAgentLinkMessageTool } from "../../src/tools/claude-reply.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-reply-"));
const mailboxPath = path.join(tmp, "mailbox.jsonl");

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

fs.rmSync(tmp, { recursive: true, force: true });
console.log("claude-reply tests passed");
