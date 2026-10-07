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
import { explicitReplies, isAnticipating, isLateResolution, messageStatus, reminderSettings } from "./message-status.js";
import { claimResolution } from "./resolution.js";
import { canonicalAddress } from "../shared/identity.js";

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
  const replies = explicitReplies(mb, messageId, fromIds, toIds);
  if (!replies.length) return null;
  const ownStatus = original && to.has(original.from_session_id) ? messageStatus(original, { now, settings }).status : null;
  return { outcome: "reply", messageStatus: ownStatus, replyRow: replies[0] };
}

/**
 * An open reply/action message with a reply row from its recipient but no
 * resolution event (a 0.5.x reply_agent_link_message, or a send with
 * replyToMessageId) is resolved as replied. Such a row is still an explicit
 * reply, never a turn's output.
 *
 * With `write` (waits), the resolution is recorded once under the resolve
 * claim (R7.10), so every reader agrees. Without it (read-only callers such
 * as get_agent_link_message_status), nothing is written and the row is
 * returned as it would read once settled. Returns the row as it now reads.
 * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
 * @param {Record<string, any>} row
 * @param {{fromIds: string[], toIds: string[], now?: number, settings?: import("./message-status.js").ReminderSettings, write?: boolean}} options
 *   fromIds: the recipient's id forms; toIds: the sender's
 */
export function settleImplicitReply(mb, row, { fromIds, toIds, now = Date.now(), settings = reminderSettings(), write = true }) {
  if (!row || !isAnticipating(row) || row.resolution) return row;
  const reply = explicitReplies(mb, row.id, fromIds, toIds)[0];
  if (!reply) return row;
  const resolution = {
    kind: "reply",
    by: row.to_session_id,
    byAddress: canonicalAddress(row.to_session_id, row.to_session_kind),
    late: isLateResolution(messageStatus(row, { now, settings })),
    replyMessageId: reply.id
  };
  if (!write) {
    return { ...row, resolution: { ...resolution, by: resolution.byAddress, at: now } };
  }
  const claimed = claimResolution(mb, row.id);
  if (!claimed.ok) return claimed.row ?? mb.getMessage({ messageId: row.id }) ?? row;
  mb.recordResolution({ messageId: row.id, ...resolution, at: now });
  return mb.getMessage({ messageId: row.id }) ?? row;
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

const CLAIM_PATTERN = /^(reminder|resolve|status)-([0-9A-HJKMNP-TV-Z]{26})(?:[-.](.+))?$/;
const ORPHAN_CLAIM_MAX_AGE_MS = 7 * 86_400_000;
const STOP_CLAIM_MAX_AGE_MS = 86_400_000;

/**
 * Bounded garbage collection of claim files (run at server start and
 * periodically). It also writes the once-only receipt for messages found
 * `unresolved` or `expired` (R7.17), since the read-only status tool does
 * not. A claim is removed only when nothing can need it again:
 *   - every claim of a resolved message (claimResolution re-checks under a
 *     retaken claim, and a resolved message has no reminders or transitions);
 *   - a reminder claim whose `reminded` event exists (the event keeps the
 *     count; an orphan claim without its event is kept, it is the count);
 *   - a resolve claim older than the stale window on an unresolved message
 *     is kept (the next generation supersedes it);
 *   - claims for messages no longer in the mailbox, and Stop-hook slots,
 *     after they age out.
 * Never throws.
 * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
 *
 * Each pass scans at most `maxFiles` claims, starting at `offset` in name
 * order and wrapping around; the result's `nextOffset` is where the next
 * pass starts, so claims that cannot be removed yet never starve the rest.
 * @param {{now?: number, settings?: import("./message-status.js").ReminderSettings, maxFiles?: number, offset?: number, host?: string, appendReceipt?: (receipt: any) => Promise<any>}} [options]
 * @returns {Promise<{scanned: number, removed: number, receipts: number, nextOffset: number}>}
 */
export async function sweepClaims(mb, { now = Date.now(), settings = reminderSettings(), maxFiles = 500, offset = 0, host, appendReceipt = safeAppendReceipt } = {}) {
  const result = { scanned: 0, removed: 0, receipts: 0, nextOffset: 0 };
  try {
    const every = mb.listClaims().sort();
    const start = every.length ? Math.abs(Math.floor(offset)) % every.length : 0;
    const names = [...every.slice(start), ...every.slice(0, start)].slice(0, maxFiles);
    // Removed names leave the list, so the next pass starts after the kept ones.
    const kept = () => result.scanned - result.removed;
    const rows = new Map(mb.inspect({ limit: Number.MAX_SAFE_INTEGER }).map((row) => [row.id, row]));
    const wallNow = Date.now();
    const transitioned = new Set();
    for (const name of names) {
      result.scanned += 1;
      const takenAt = mb.claimTakenAt(name);
      const age = takenAt === null ? 0 : wallNow - takenAt;
      if (name.startsWith("stop-")) {
        if (age > STOP_CLAIM_MAX_AGE_MS && mb.removeClaim(name)) result.removed += 1;
        continue;
      }
      const match = CLAIM_PATTERN.exec(name);
      if (!match) continue;
      const [, kind, messageId, rest] = match;
      const row = rows.get(messageId);
      let remove = false;
      if (!row) {
        remove = age > ORPHAN_CLAIM_MAX_AGE_MS;
      } else if (row.resolution) {
        remove = true;
      } else if (kind === "reminder") {
        const n = Number(rest);
        remove = (row.reminders ?? []).some((r) => r.n === n && r.via !== null);
      }
      if (remove && mb.removeClaim(name)) result.removed += 1;
    }
    result.nextOffset = every.length ? start + kept() : 0;
    // Messages that became unresolved or expired since the last pass.
    let checked = 0;
    for (const row of rows.values()) {
      if (checked >= maxFiles) break;
      if (!isAnticipating(row) || row.resolution || transitioned.has(row.id)) continue;
      const status = messageStatus(row, { now, settings }).status;
      if (status !== "unresolved" && status !== "expired") continue;
      checked += 1;
      transitioned.add(row.id);
      if (await recordStatusTransition(mb, row, { now, settings, host, appendReceipt })) result.receipts += 1;
    }
  } catch {
    // Collection is housekeeping; a failure leaves claims for the next pass.
  }
  return result;
}
