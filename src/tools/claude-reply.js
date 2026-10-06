import { openMailbox, messageBodyTooLarge } from "../claude/mailbox.js";
import { canonicalClaudeSessionId, claudeSessionAliases } from "../claude/identity.js";
import { buildReceipt, safeAppendReceipt } from "../shared/receipt-index.js";

export const replyAgentLinkMessageTool = {
  name: "reply_agent_link_message",
  description:
    "Reply to an inbound Agent Link message by messageId. The tool looks up the original sender, records " +
    "the reply with reply_to_message_id, and acknowledges the original message.",
  inputSchema: {
    type: "object",
    properties: {
      messageId: { type: "string", description: "Inbound Agent Link message id to reply to." },
      body: { type: "string", description: "Reply body to send back to the original sender." }
    },
    required: ["messageId", "body"],
    additionalProperties: false
  }
};

export function makeReplyAgentLinkMessageHandler({
  mailboxOpener,
  resolveCurrentSession,
  host = "claude",
  appendReceipt = safeAppendReceipt
} = {}) {
  const openMb = typeof mailboxOpener === "function"
    ? mailboxOpener
    : () => openMailbox();

  return {
    reply_agent_link_message: async ({ messageId, body } = {}, toolContext = {}) => {
      if (typeof messageId !== "string" || !messageId.trim()) {
        return { error: "invalid_arguments", message: "`messageId` must be a non-empty string" };
      }
      if (typeof body !== "string" || !body.length) {
        return { error: "invalid_arguments", message: "`body` must be a non-empty string" };
      }
      const tooLarge = messageBodyTooLarge(body);
      if (tooLarge) return tooLarge;

      const session = typeof resolveCurrentSession === "function" ? resolveCurrentSession() : null;
      if (!session?.sessionId) {
        return { error: "no_current_session", message: "Could not resolve the current Claude session." };
      }
      const currentSessionId = canonicalClaudeSessionId(session);

      const mb = openMb();
      let original;
      let replyId;
      try {
        original = mb.getMessage({ messageId });
        if (!original) return { error: "not_found", messageId };
        // Mail may be addressed to any id form of this session.
        if (!claudeSessionAliases(session).includes(original.to_session_id)) {
          return {
            error: "wrong_recipient",
            messageId,
            expectedSessionId: original.to_session_id,
            currentSessionId
          };
        }
        mb.markAcknowledged({ messageId });
        // The reply always comes from the canonical id, whatever id form the
        // original was addressed to, so the sender's wait can match it.
        replyId = mb.insertMessage({
          fromSessionId: currentSessionId,
          fromSessionKind: "claude",
          toSessionId: original.from_session_id,
          toSessionKind: original.from_session_kind,
          body,
          replyToMessageId: messageId
        });
      } finally {
        mb.close();
      }

      const target = {
        sessionId: original.from_session_id,
        kind: original.from_session_kind
      };
      const built = buildReceipt({
        action: "reply_message",
        receipt: null,
        host,
        target: {
          sessionId: original.from_session_id,
          kind: original.from_session_kind
        },
        message: body,
        delivery: "queued-mailbox",
        runtimeCallerContext: toolContext.runtimeCallerContext ?? null
      });
      const receipt = { recorded: true, ...await appendReceipt(built) };

      return {
        messageId: replyId,
        replyToMessageId: messageId,
        target,
        delivery: "queued-mailbox",
        receipt
      };
    }
  };
}
