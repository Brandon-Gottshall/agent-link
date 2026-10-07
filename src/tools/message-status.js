// src/tools/message-status.js
//
// get_agent_link_message_status (design doc R7.18): the sender's (or the
// recipient's) view of one message's labels, delivery state, and
// resolution status. Read-only: it writes nothing (transition receipts come
// from waits and the server's claim sweep, R7.17). Never returns a body.
import { openMailbox } from "../claude/mailbox.js";
import { resolveCallerIdentity } from "../claude/identity.js";
import { addressAliases, mailboxRowAddresses, storedAddress } from "../registry/addresses.js";
import { AgentLinkError } from "../shared/errors.js";
import { ANTICIPATIONS, MESSAGE_STATUSES, deliveryState, labelFields, reminderSettings } from "../delivery/message-status.js";
import { settleImplicitReply } from "../delivery/message-wait.js";
import { enumOf, out, str } from "../server/schemas.js";

/** @type {import("../server/registry.js").ToolDefinition} */
export const messageStatusTool = {
  name: "get_agent_link_message_status",
  description:
    "Status of one Agent Link message, for its sender or its recipient (anyone else gets permission_denied). " +
    "Returns the labels (from, to, anticipation, replyBy), delivery (queued, delivered, acknowledged), status " +
    "(pending, replied, declined, done, unresolved, expired; null for an fyi message), the resolution " +
    "({kind, by, at, late, replyMessageId} or null), and reminders ({count, limit, lastAt, nextDueAt}). Never returns a " +
    "message body: read replies with read_agent_link_inbox or a wait.",
  inputSchema: {
    type: "object",
    properties: {
      messageId: str("The Agent Link message id, as returned by the send tool or shown in the envelope.")
    },
    required: ["messageId"],
    additionalProperties: false
  },
  output: {
    messageId: out("string", "The message id."),
    from: out("string", "Sender address, external, or invalid."),
    to: out("string", "Recipient address, or invalid."),
    anticipation: enumOf(ANTICIPATIONS, "reply, action, or fyi."),
    replyBy: out(["string", "null"], "Deadline (ISO 8601), or null."),
    inReplyTo: out(["string", "null"], "The message this one answers, or null."),
    delivery: enumOf(["queued", "delivered", "acknowledged"], "Delivery state."),
    status: out(["string", "null"], `Resolution status: ${MESSAGE_STATUSES.join(", ")}; null for an fyi message.`),
    resolution: out(["object", "null"], "{kind: reply|decline|done, by, at, late, replyMessageId}, or null."),
    reminders: out(["object", "null"], "{count, limit, lastAt, nextDueAt} for a reply/action message; null for fyi.")
  },
  annotations: { readOnlyHint: true }
};

/**
 * @param {{
 *   host?: string,
 *   resolveCurrentSession?: (() => any) | null,
 *   mailboxOpener?: () => any,
 *   now?: () => number,
 *   reminderSettings?: () => import("../delivery/message-status.js").ReminderSettings
 * }} [deps]
 */
export function makeMessageStatusHandler({
  host,
  resolveCurrentSession = null,
  mailboxOpener,
  now = () => Date.now(),
  reminderSettings: settingsFn = () => reminderSettings()
} = {}) {
  const openMb = typeof mailboxOpener === "function" ? mailboxOpener : () => openMailbox();
  /**
   * @param {Record<string, any>} args
   * @param {{runtimeCallerContext?: unknown}} [toolContext]
   */
  return async function getMessageStatus(args = {}, toolContext = {}) {
    const { messageId } = args;
    if (typeof messageId !== "string" || !messageId.trim()) {
      throw new AgentLinkError("invalid_arguments", "`messageId` must be a non-empty string.", {
        details: { errors: [{ path: "messageId", rule: "required", expected: "non-empty string" }] }
      });
    }
    const caller = resolveCallerIdentity({
      host,
      runtimeCallerContext: toolContext.runtimeCallerContext ?? null,
      currentSession: resolveCurrentSession
    });
    const mb = openMb();
    try {
      const row = mb.getMessage({ messageId });
      if (!row) {
        throw new AgentLinkError("not_found", `No Agent Link message has id ${JSON.stringify(messageId).slice(0, 80)}.`, {
          details: { id: messageId, candidates: [] },
          hint: "Use the messageId returned by the send tool."
        });
      }
      const { fromAddress, toAddress } = mailboxRowAddresses(row);
      if (!isParticipant(caller, row, { fromAddress, toAddress })) {
        throw new AgentLinkError("permission_denied", "Only the sender or the recipient of a message can read its status.", {
          details: { reason: "not_participant", messageId },
          hint: "Ask the sender or the recipient."
        });
      }
      const at = now();
      const settings = settingsFn();
      // Read-only: an older-style reply is reflected without being recorded
      // (waits record it), and status receipts are written elsewhere.
      const settled = settleImplicitReply(mb, row, {
        fromIds: [row.to_session_id, ...addressAliases(toAddress)],
        toIds: [row.from_session_id, ...addressAliases(fromAddress)],
        now: at,
        settings,
        write: false
      });
      const labels = labelFields(settled, { now: at, settings });
      return {
        messageId: row.id,
        from: fromAddress,
        to: toAddress,
        anticipation: labels.anticipation,
        replyBy: labels.replyBy,
        inReplyTo: labels.inReplyTo,
        delivery: deliveryState(settled),
        status: labels.status,
        resolution: labels.resolution,
        reminders: labels.reminders
      };
    } finally {
      mb.close();
    }
  };
}

/**
 * The caller sent or received the message, by any id form. `external` is
 * never a participant: it is not an identity.
 * @param {{id: string, kind: string, aliases: string[]}} caller
 * @param {Record<string, any>} row
 * @param {{fromAddress: string, toAddress: string}} addresses
 */
function isParticipant(caller, row, { fromAddress, toAddress }) {
  if (caller.id === "external") return false;
  const ids = new Set(caller.aliases);
  if (ids.has(row.from_session_id) || ids.has(row.to_session_id)) return true;
  const callerAddress = storedAddress(caller.id, caller.kind);
  return callerAddress.includes(":") && (callerAddress === fromAddress || callerAddress === toAddress);
}

/**
 * @param {Parameters<typeof makeMessageStatusHandler>[0]} deps
 * @returns {import("../server/registry.js").ToolEntry[]}
 */
export function messageStatusEntries(deps) {
  const handler = makeMessageStatusHandler(deps);
  return [{
    definition: messageStatusTool,
    handler: (args, ctx) => handler(args, { runtimeCallerContext: ctx.callerContext })
  }];
}
