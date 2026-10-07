import { openMailbox } from "../claude/mailbox.js";
import { storedAddress } from "../registry/addresses.js";
import { currentRecipient, noCurrentSession } from "../delivery/recipient.js";
import { buildReceipt, safeAppendReceipt } from "../shared/receipt-index.js";
import { assertPeerBodyWithinLimit } from "../shared/envelope.js";
import { handedOverTo, readRoleTable, recipientMatcher, roleRoute } from "../delivery/role-handover.js";
import { AgentLinkError } from "../shared/errors.js";
import { commonOut, enumOf, out, str } from "../server/schemas.js";
import {
  ANTICIPATIONS,
  RESOLUTIONS,
  isAnticipating,
  isLateResolution,
  messageStatus,
  reminderSettings,
  resolveLabels
} from "../delivery/message-status.js";

import { claimResolution } from "../delivery/resolution.js";

const RESOLVED_STATUS = Object.freeze({ reply: "replied", decline: "declined", done: "done" });

/** @type {import("../server/registry.js").ToolDefinition} */
export const replyAgentLinkMessageTool = {
  name: "reply_agent_link_message",
  description:
    "Reply to or resolve an inbound Agent Link message by messageId, from a Claude session or a Codex thread (the only way to resolve one: a turn's final " +
    "response is never a reply). resolution 'reply' (default) sends `message` back to the sender; 'decline' sends " +
    "`message` as the reason; 'done' marks a requested action finished, with an optional note. A reply or action " +
    "message resolves once (a second resolution is already_resolved); an fyi message only takes resolution 'reply', " +
    "which sends a reply and sets no status. The reply is itself a labeled message (anticipation, replyBy). Writes a " +
    "receipt and acknowledges the original. Fails with not_found for an unknown messageId and wrong_recipient for a " +
    "message not addressed to the caller.",
  inputSchema: {
    type: "object",
    properties: {
      messageId: str("Inbound Agent Link message id to reply to or resolve."),
      resolution: enumOf(RESOLUTIONS, "reply (default): send a reply. decline: refuse, with the reason in message. done: the requested action is finished; message is an optional note. decline and done are only for reply/action messages."),
      message: str("Text sent back to the original sender (at most 64 KiB): the reply, the decline reason, or the done note. Required for reply and decline."),
      anticipation: enumOf(ANTICIPATIONS, "What this reply expects from the original sender: reply, action, or fyi (default). reply or action opens a new obligation on the original sender."),
      replyBy: str("Optional deadline for this reply's own anticipation, ISO 8601 with a time zone, at least 30 s ahead. Not allowed with fyi.")
    },
    required: ["messageId"],
    additionalProperties: false
  },
  removedArguments: [{ name: "body", replacement: "message" }],
  output: {
    messageId: out(["string", "null"], "Id of the reply message, or null for done without a note."),
    replyToMessageId: out("string", "The message replied to or resolved."),
    target: out("object", "{address, sessionId, kind} of the original sender; address is null for an external sender."),
    delivery: out("string", "queued-mailbox; delivered when a reply to a Codex thread was pushed to it as a turn (codex-turn); or none when no message was sent (done without a note)."),
    resolution: out(["string", "null"], "reply, decline, or done when the original was a reply/action message; null for an fyi reply."),
    status: out(["string", "null"], "The original message's status after this call: replied, declined, done, or null for fyi."),
    late: out("boolean", "True when the message was resolved after it became unresolved or expired."),
    anticipation: enumOf(ANTICIPATIONS, "The reply message's own anticipation label."),
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
 * @property {() => number} [now]
 * @property {() => import("../delivery/message-status.js").ReminderSettings} [reminderSettings]
 * @property {import("../registry/roles.js").RoleStore | null} [roles]  role table (role handover, R7.20)
 * @property {((options: {messageId: string, threadId: string}) => Promise<{delivery: string, warnings?: any[]}>) | null} [pushToCodex]  pushes a reply to a Codex sender (src/delivery/codex-push.js pushWhenIdle)
 */

/** @param {ClaudeReplyDeps} [deps] */
export function makeReplyAgentLinkMessageHandler({
  mailboxOpener,
  resolveCurrentSession,
  host = "claude",
  appendReceipt = safeAppendReceipt,
  now = () => Date.now(),
  reminderSettings: settingsFn = () => reminderSettings(),
  roles = null,
  pushToCodex = null
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
      const { messageId, message: body, resolution = "reply", anticipation, replyBy } = rawArgs ?? {};
      if (typeof messageId !== "string" || !messageId.trim()) {
        throw invalid("messageId", "`messageId` must be a non-empty string.");
      }
      const hasBody = typeof body === "string" && body.length > 0;
      if (!hasBody && resolution !== "done") {
        // R7.8: a decline needs its reason; a reply needs its text.
        throw invalid("message", resolution === "decline"
          ? "`message` must give the reason for declining."
          : "`message` must be a non-empty string.");
      }
      if (hasBody) assertPeerBodyWithinLimit(body);
      const at = now();
      const labels = resolveLabels({ anticipation, replyBy, waitForReply: false, now: at });

      // A Claude session or a Codex thread, from runtime identity (R1.4, R1.13).
      const me = currentRecipient({ host, callerContext: toolContext.runtimeCallerContext ?? null, resolveCurrentSession });
      if (!me) throw noCurrentSession("reply_agent_link_message", host);
      const currentSessionId = me.storedId;
      const resolverAddress = me.address;

      const mb = openMb();
      let original;
      let replyId = null;
      let resolved = null;
      try {
        original = mb.getMessage({ messageId });
        if (!original) {
          throw new AgentLinkError("not_found", `No Agent Link message has id ${JSON.stringify(messageId).slice(0, 80)}.`, {
            details: { id: messageId, candidates: [] },
            hint: "Use the messageId from the <agent-link-message> envelope or read_agent_link_inbox."
          });
        }
        // R7.7: only the recipient may reply or resolve. Mail may be
        // addressed to any id form of this session. For a message sent
        // through role:<name> and still open, the recipient is the role's
        // current holder (R7.20): the previous holder is refused.
        const table = readRoleTable(roles);
        const holder = handedOverTo(original, table);
        if (!recipientMatcher({ aliases: me.aliases, address: me.address, table })(original)) {
          throw new AgentLinkError("wrong_recipient", holder
            ? `That message was sent to ${roleRoute(original)?.via ?? "a role"} and has been handed over to ${holder}.`
            : "That message was not addressed to this session.", {
            details: { messageId, expected: holder ?? original.to_session_id, caller: currentSessionId, ...(holder ? { via: roleRoute(original)?.via ?? null } : {}) }
          });
        }
        const anticipating = isAnticipating(original);
        if (!anticipating && resolution !== "reply") {
          // R7.9: an fyi message has nothing to resolve.
          throw new AgentLinkError("invalid_arguments", `An fyi message cannot be resolved as "${resolution}"; reply to it instead, or leave it.`, {
            details: { errors: [{ path: "resolution", rule: "conflict", expected: "reply for an fyi message" }] }
          });
        }
        const settings = settingsFn();
        const view = messageStatus(original, { now: at, settings });
        if (anticipating && original.resolution) throw alreadyResolved(messageId, view);
        // R7.10 under concurrency: take the resolve claim before writing
        // anything, so of two racing resolvers exactly one succeeds.
        if (anticipating) {
          const claimed = claimResolution(mb, messageId);
          if (!claimed.ok) {
            throw alreadyResolved(messageId, claimed.row ? messageStatus(claimed.row, { now: at, settings }) : view);
          }
        }
        mb.markAcknowledged({ messageId });
        if (hasBody) {
          // The reply always comes from the canonical id, whatever id form
          // the original was addressed to, so the sender's wait can match it.
          replyId = mb.insertMessage({
            fromSessionId: currentSessionId,
            fromSessionKind: me.harness,
            toSessionId: original.from_session_id,
            toSessionKind: original.from_session_kind,
            body,
            // The sender is the caller's runtime identity (R1.4).
            metadata: { sender: { source: me.source } },
            replyToMessageId: messageId,
            anticipation: labels.anticipation,
            replyBy: labels.replyBy
          });
        }
        if (anticipating) {
          resolved = { kind: resolution, late: isLateResolution(view), at };
          mb.recordResolution({
            messageId,
            kind: resolution,
            // The stored recipient id: the view trusts only the recipient.
            by: original.to_session_id,
            byAddress: resolverAddress,
            late: resolved.late,
            replyMessageId: replyId,
            at
          });
        }
      } finally {
        mb.close();
      }

      // The original sender's canonical address (read-time migration of the
      // stored id, R1.6); null for an external or invalid sender.
      const senderAddress = storedAddress(original.from_session_id, original.from_session_kind);
      const address = senderAddress.includes(":") ? senderAddress : null;
      const target = {
        address,
        sessionId: original.from_session_id,
        kind: original.from_session_kind
      };
      let delivery = replyId ? "queued-mailbox" : "none";
      /** @type {Array<Record<string, any>>} */
      let pushWarnings = [];
      // A reply to a Codex thread is pushed to it as a turn when it is idle
      // (R1.10, R1.11); otherwise it stays queued for its wait or inbox.
      if (replyId && original.from_session_kind === "codex" && typeof pushToCodex === "function") {
        const threadId = String(original.from_session_id).replace(/^codex:/, "");
        try {
          const pushed = await pushToCodex({ messageId: replyId, threadId });
          if (pushed.delivery === "delivered") delivery = "delivered";
          pushWarnings = pushed.warnings ?? [];
        } catch (error) {
          pushWarnings = [{ code: "codex_push_failed", message: `The reply is queued in the mailbox; pushing it failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600) }];
        }
        for (const warning of pushWarnings) toolContext.warn?.(warning);
      }
      const built = buildReceipt({
        action: "reply_message",
        receipt: null,
        host,
        target: {
          address,
          sessionId: original.from_session_id,
          kind: original.from_session_kind
        },
        message: hasBody ? body : null,
        delivery,
        runtimeCallerContext: toolContext.runtimeCallerContext ?? null,
        // R7.12: one receipt per resolution.
        resolution: resolved
          ? { kind: "resolution", messageId, resolution: resolved.kind, by: resolverAddress, at: new Date(resolved.at).toISOString(), late: resolved.late }
          : null
      });
      const receipt = { recorded: true, ...await appendReceipt(built) };

      return {
        messageId: replyId,
        replyToMessageId: messageId,
        target,
        delivery,
        resolution: resolved ? resolved.kind : null,
        status: resolved ? RESOLVED_STATUS[/** @type {"reply" | "decline" | "done"} */ (resolved.kind)] : null,
        late: resolved ? resolved.late : false,
        anticipation: labels.anticipation,
        receipt
      };
    }
  };
}

/**
 * @param {string} messageId
 * @param {ReturnType<typeof messageStatus>} view
 */
function alreadyResolved(messageId, view) {
  const status = view.status === "pending" ? "resolving" : view.status;
  return new AgentLinkError("already_resolved", `Message ${messageId} is already ${status}.`, {
    details: { messageId, status: view.status, resolvedAt: view.resolution?.at ?? null },
    hint: "Send a new message with message_claude_session if there is more to say."
  });
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
