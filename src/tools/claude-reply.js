import { openMailbox } from "../claude/mailbox.js";
import { canonicalClaudeSessionId, claudeSessionAliases } from "../claude/identity.js";
import { buildReceipt, safeAppendReceipt } from "../shared/receipt-index.js";
import { assertPeerBodyWithinLimit } from "../shared/envelope.js";
import { AgentLinkError } from "../shared/errors.js";
import { applyAliases } from "../server/registry.js";
import { commonOut, out, str } from "../server/schemas.js";

/** @type {import("../server/registry.js").ToolDefinition} */
export const replyAgentLinkMessageTool = {
  name: "reply_agent_link_message",
  description:
    "Reply to an inbound Agent Link message by messageId. The tool looks up the original sender, records " +
    "the reply with replyToMessageId, writes a reply receipt, and acknowledges the original message. Fails with " +
    "not_found for an unknown messageId and wrong_recipient for a message not addressed to the caller.",
  inputSchema: {
    type: "object",
    properties: {
      messageId: str("Inbound Agent Link message id to reply to."),
      message: str("Reply text to send back to the original sender (at most 64 KiB).")
    },
    required: ["messageId"],
    additionalProperties: false
  },
  aliases: [{ canonical: "message", aliases: ["body"], required: true }],
  output: {
    messageId: out("string", "Id of the reply message."),
    replyToMessageId: out("string", "The message replied to."),
    target: out("object", "{sessionId, kind} of the original sender."),
    delivery: out("string", "queued-mailbox."),
    receipt: commonOut.receipt
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
};

/**
 * @typedef {object} ClaudeReplyDeps
 * @property {() => any} [mailboxOpener]
 * @property {(() => any) | null} [resolveCurrentSession]
 * @property {string} [host]
 * @property {(receipt: any) => Promise<any>} [appendReceipt]
 */

/** @param {ClaudeReplyDeps} [deps] */
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
    /**
     * @param {Record<string, any>} [rawArgs]
     * @param {{runtimeCallerContext?: unknown, warn?: (w: any) => void}} [toolContext]
     */
    reply_agent_link_message: async (rawArgs = {}, toolContext = {}) => {
      /** @type {any[]} */
      const aliasWarnings = [];
      const { messageId, message: body } = applyAliases(replyAgentLinkMessageTool, rawArgs, aliasWarnings);
      for (const warning of aliasWarnings) toolContext.warn?.(warning);
      if (typeof messageId !== "string" || !messageId.trim()) {
        throw invalid("messageId", "`messageId` must be a non-empty string.");
      }
      if (typeof body !== "string" || !body.length) {
        throw invalid("message", "`message` must be a non-empty string.");
      }
      assertPeerBodyWithinLimit(body);

      const session = typeof resolveCurrentSession === "function" ? resolveCurrentSession() : null;
      if (!session?.sessionId) {
        throw new AgentLinkError("no_current_session", "Could not resolve the current Claude session.", {
          details: { host, sources: ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "session sidecar", "transcript"] },
          hint: "reply_agent_link_message must run inside an indexed Claude session."
        });
      }
      const currentSessionId = canonicalClaudeSessionId(session);

      const mb = openMb();
      let original;
      let replyId;
      try {
        original = mb.getMessage({ messageId });
        if (!original) {
          throw new AgentLinkError("not_found", `No Agent Link message has id ${JSON.stringify(messageId).slice(0, 80)}.`, {
            details: { id: messageId, candidates: [] },
            hint: "Use the messageId from the <agent-link-message> envelope or read_agent_link_inbox."
          });
        }
        // Mail may be addressed to any id form of this session.
        if (!claudeSessionAliases(session).includes(original.to_session_id)) {
          throw new AgentLinkError("wrong_recipient", "That message was not addressed to this session.", {
            details: { messageId, expected: original.to_session_id, caller: currentSessionId }
          });
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
          // The sender is the resolved current session (runtime identity).
          metadata: { sender: { source: "current_session" } },
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

/**
 * @param {string} path
 * @param {string} message
 */
function invalid(path, message) {
  return new AgentLinkError("invalid_arguments", message, {
    details: { errors: [{ path, rule: "required", expected: "non-empty string" }] }
  });
}

/**
 * @param {Parameters<typeof makeReplyAgentLinkMessageHandler>[0]} deps
 * @returns {import("../server/registry.js").ToolEntry[]}
 */
export function replyAgentLinkMessageEntries(deps) {
  const handlers = makeReplyAgentLinkMessageHandler(deps);
  return [{
    definition: replyAgentLinkMessageTool,
    handler: (args, ctx) => handlers.reply_agent_link_message(args, { runtimeCallerContext: ctx.callerContext, warn: ctx.warn })
  }];
}
