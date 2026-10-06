import { openMailbox } from "../claude/mailbox.js";

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

export function makeReplyAgentLinkMessageHandler({ mailboxOpener, resolveCurrentSession } = {}) {
  const openMb = typeof mailboxOpener === "function"
    ? mailboxOpener
    : () => openMailbox();

  return {
    reply_agent_link_message: async ({ messageId, body } = {}) => {
      if (typeof messageId !== "string" || !messageId.trim()) {
        return { error: "invalid_arguments", message: "`messageId` must be a non-empty string" };
      }
      if (typeof body !== "string" || !body.length) {
        return { error: "invalid_arguments", message: "`body` must be a non-empty string" };
      }

      const session = typeof resolveCurrentSession === "function" ? resolveCurrentSession() : null;
      if (!session?.sessionId) {
        return { error: "no_current_session", message: "Could not resolve the current Claude session." };
      }

      const mb = openMb();
      try {
        const original = mb.getMessage({ messageId });
        if (!original) return { error: "not_found", messageId };
        if (original.to_session_id !== session.sessionId) {
          return {
            error: "wrong_recipient",
            messageId,
            expectedSessionId: original.to_session_id,
            currentSessionId: session.sessionId
          };
        }
        mb.ackMessage({ messageId, body });
        const reply = mb.inspect({ replyToMessageId: messageId, limit: 1 })[0] ?? null;
        return {
          messageId: reply?.id ?? null,
          replyToMessageId: messageId,
          target: {
            sessionId: original.from_session_id,
            kind: original.from_session_kind
          },
          delivery: "queued-mailbox"
        };
      } finally {
        mb.close();
      }
    }
  };
}
