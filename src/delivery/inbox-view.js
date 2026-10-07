// src/delivery/inbox-view.js
//
// Which mailbox rows a recipient sees, shared by read_agent_link_inbox and
// the Codex prompt hook (design R1.14) so the hook announces exactly what
// the inbox will show. Pure: rows in, rows out. No mailbox access.

import { isAnticipating, messageStatus } from "./message-status.js";

/** @typedef {ReturnType<typeof import("./role-handover.js").recipientView>} RecipientView */

/**
 * Open for the inbox: pending, or (handed over to this holder and still
 * unresolved) unresolved or expired too, so a message that reached the cap
 * under the previous holder is not lost (R7.20).
 * @param {Record<string, any>} row
 * @param {RecipientView} inbox
 * @param {number} at
 * @param {import("./message-status.js").ReminderSettings} settings
 */
export function isOpenFor(row, inbox, at, settings) {
  const status = messageStatus(row, { now: at, settings }).status;
  return status === "pending" || (inbox.handedOver(row) && !row.resolution && (status === "unresolved" || status === "expired"));
}

/**
 * A delivered reply/action row that this recipient still has to resolve
 * (design 7.5): the inbox's includeOpen set, before its limit.
 * @param {Record<string, any>} row
 * @param {RecipientView} inbox
 * @param {number} at
 * @param {import("./message-status.js").ReminderSettings} settings
 */
export function isOpenMailFor(row, inbox, at, settings) {
  return inbox.isRecipient(row) && Boolean(row.delivered_at) && !inbox.isPending(row) &&
    isAnticipating(row) && isOpenFor(row, inbox, at, settings);
}
