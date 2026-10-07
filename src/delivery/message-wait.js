// src/delivery/message-wait.js
//
// Waiting on one message (design doc R7.19). A wait on an anticipating
// message ends when its status leaves `pending`: outcome `reply`,
// `declined`, `done`, `unresolved`, or `expired`. Only an explicit reply
// (reply_agent_link_message) is returned, never a turn's final response
// (R7.5). A wait on an fyi message (or one written before labels existed)
// has no status and ends on an explicit reply from the target, as before.
//
// The first process that observes a message's transition to `unresolved`
// or `expired` writes one receipt for it (R7.17).
import { buildReceipt, safeAppendReceipt } from "../shared/receipt-index.js";
import { isAnticipating, isLateResolution, messageStatus, reminderSettings } from "./message-status.js";

const OUTCOME_FOR_STATUS = Object.freeze({
  replied: "reply",
  declined: "declined",
  done: "done",
  unresolved: "unresolved",
  expired: "expired"
});

/**
 * @typedef {object} MessageWaitResult
 * @property {"reply" | "declined" | "done" | "unresolved" | "expired"} outcome
 * @property {string | null} messageStatus  null for an fyi message
 * @property {Record<string, any> | null} replyRow  the explicit reply, decline reason or done note
 */

/**
 * One check of a message wait. Null while the wait should continue.
 * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
 * @param {{
 *   messageId: string,
 *   fromIds: string[],
 *   toIds: string[],
 *   now?: number,
 *   settings?: import("./message-status.js").ReminderSettings
 * }} options  fromIds: the target's id forms; toIds: the caller's
 * @returns {MessageWaitResult | null}
 */
export function checkMessageWait(mb, { messageId, fromIds, toIds, now = Date.now(), settings = reminderSettings() }) {
  const from = new Set(fromIds);
  const to = new Set(toIds);
  const original = mb.getMessage({ messageId });
  // Status is only reported to the message's sender (the caller).
  if (original && isAnticipating(original) && to.has(original.from_session_id)) {
    const view = messageStatus(settleImplicitReply(mb, original, { fromIds, toIds, now, settings }), { now, settings });
    if (view.status === "pending" || view.status === null) return null;
    let replyRow = null;
    const replyId = view.resolution?.replyMessageId;
    if (replyId) {
      const row = mb.getMessage({ messageId: replyId });
      // Defense in depth: only a message from the target to the caller.
      if (row && from.has(row.from_session_id) && to.has(row.to_session_id)) replyRow = row;
    }
    return {
      outcome: /** @type {MessageWaitResult["outcome"]} */ (OUTCOME_FOR_STATUS[/** @type {keyof typeof OUTCOME_FOR_STATUS} */ (view.status)]),
      messageStatus: view.status,
      replyRow
    };
  }
  // fyi or unlabeled: an explicit reply from the target to the caller. A
  // reply_to_message_id match alone is not enough: anyone can append to the
  // mailbox, so a third party could otherwise forge the answer.
  const replies = explicitReplies(mb, messageId, from, to);
  if (!replies.length) return null;
  const ownStatus = original && to.has(original.from_session_id) ? messageStatus(original, { now, settings }).status : null;
  return { outcome: "reply", messageStatus: ownStatus, replyRow: replies[0] };
}

/**
 * An open reply/action message with a reply row from its recipient but no
 * resolution event (a 0.5.x reply_agent_link_message, or a send with
 * replyToMessageId) is resolved as replied here, once, so every reader
 * agrees. Such a row is still an explicit reply, never a turn's output.
 * Returns the row as it now reads.
 * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
 * @param {Record<string, any>} row
 * @param {{fromIds: string[], toIds: string[], now?: number, settings?: import("./message-status.js").ReminderSettings}} options
 *   fromIds: the recipient's id forms; toIds: the sender's
 */
export function settleImplicitReply(mb, row, { fromIds, toIds, now = Date.now(), settings = reminderSettings() }) {
  if (!row || !isAnticipating(row) || row.resolution) return row;
  const reply = explicitReplies(mb, row.id, new Set(fromIds), new Set(toIds))[0];
  if (!reply) return row;
  mb.recordResolution({
    messageId: row.id,
    kind: "reply",
    by: reply.from_session_id,
    late: isLateResolution(messageStatus(row, { now, settings })),
    replyMessageId: reply.id,
    at: now
  });
  return mb.getMessage({ messageId: row.id }) ?? row;
}

/**
 * Replies to `messageId` from the target (`from`) addressed to the caller
 * (`to`), oldest first.
 * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
 * @param {string} messageId
 * @param {Set<string>} from
 * @param {Set<string>} to
 */
function explicitReplies(mb, messageId, from, to) {
  return mb.inspect({ replyToMessageId: messageId, limit: Number.MAX_SAFE_INTEGER })
    .filter((m) => from.has(m.from_session_id) && to.has(m.to_session_id))
    .sort((a, b) => a.sent_at - b.sent_at);
}

/**
 * Writes the receipt for an observed transition to unresolved or expired,
 * once across processes (a claim beside the mailbox). Never throws.
 * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
 * @param {Record<string, any> | null} row
 * @param {{
 *   now?: number,
 *   settings?: import("./message-status.js").ReminderSettings,
 *   host?: string,
 *   appendReceipt?: (receipt: any) => Promise<any>
 * }} [options]
 */
export async function recordStatusTransition(mb, row, { now = Date.now(), settings = reminderSettings(), host, appendReceipt = safeAppendReceipt } = {}) {
  try {
    if (!row || !isAnticipating(row)) return false;
    const view = messageStatus(row, { now, settings });
    if (view.status !== "unresolved" && view.status !== "expired") return false;
    if (!mb.claim(`status-${row.id}-${view.status}`)) return false;
    const built = buildReceipt({
      action: "message_status",
      receipt: { purpose: `message ${view.status}` },
      host,
      target: { sessionId: row.to_session_id, kind: row.to_session_kind },
      message: null,
      delivery: null,
      runtimeCallerContext: null,
      resolution: {
        kind: "status",
        messageId: row.id,
        status: view.status,
        at: new Date(view.transitionAt ?? now).toISOString()
      }
    });
    await appendReceipt(built);
    return true;
  } catch {
    // A status receipt is evidence only; the status itself is computed from
    // the mailbox and never depends on it.
    return false;
  }
}
