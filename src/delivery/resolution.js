// src/delivery/resolution.js
//
// Exactly-once resolution (design doc R7.10). Every writer of a `resolved`
// event first takes the `resolve-<messageId>` claim, an exclusive create
// beside the mailbox, so two concurrent resolvers (two sessions' servers, or
// a reply racing a wait that settles an older-style reply) cannot both
// succeed. The loser re-reads the message and reports already_resolved.
//
// A claim whose holder crashed before appending its event would block the
// message forever, so a claim older than STALE_RESOLUTION_CLAIM_MS with no
// resolution behind it is superseded by the next generation
// (`resolve-<id>.1`, `.2`, ...). Ages use the wall clock, never an injected
// test clock, because the claim file's mtime is wall-clock time.

import { isAnticipating, isLateResolution, messageStatus } from "./message-status.js";
export const STALE_RESOLUTION_CLAIM_MS = 10_000;
const MAX_GENERATIONS = 5;

/**
 * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
 * @param {string} messageId
 * @param {{staleMs?: number}} [options]
 * @returns {{ok: boolean, row: Record<string, any> | null}}  row: the message as re-read when ok is false
 */
export function claimResolution(mb, messageId, { staleMs = STALE_RESOLUTION_CLAIM_MS } = {}) {
  for (let gen = 0; gen < MAX_GENERATIONS; gen++) {
    const key = gen === 0 ? `resolve-${messageId}` : `resolve-${messageId}.${gen}`;
    if (mb.claim(key, String(Date.now()))) {
      // A claim collected after an earlier resolution can be retaken, so
      // check again under the claim.
      const row = mb.getMessage({ messageId });
      return row?.resolution ? { ok: false, row } : { ok: true, row: null };
    }
    const row = mb.getMessage({ messageId });
    if (row?.resolution) return { ok: false, row };
    const takenAt = mb.claimTakenAt(key);
    // Held by a resolver still writing: it wins.
    if (takenAt === null || Date.now() - takenAt < staleMs) return { ok: false, row };
  }
  return { ok: false, row: mb.getMessage({ messageId }) };
}

/**
 * Resolves an open reply/action message because its recipient answered it
 * with a send (R7.5, R7.7): a send with replyToMessageId resolves it as
 * "reply", and return_project_work_result with replyToMessageId as "done".
 * Exactly once (R7.10): the resolve claim first; a lost claim, a resolved
 * message, or an fyi message leaves it as it was.
 * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
 * @param {Record<string, any>} original  the answered message
 * @param {{kind?: "reply" | "done", byAddress: string | null, replyMessageId: string | null, now: number, settings: import("./message-status.js").ReminderSettings}} options
 * @returns {{ok: true, kind: string, late: boolean} | {ok: false, reason: "fyi" | "already_resolved" | "claimed_elsewhere"}}
 */
export function resolveByAnswer(mb, original, { kind = "reply", byAddress, replyMessageId, now, settings }) {
  if (!isAnticipating(original)) return { ok: false, reason: "fyi" };
  if (original.resolution) return { ok: false, reason: "already_resolved" };
  if (!claimResolution(mb, original.id).ok) return { ok: false, reason: "claimed_elsewhere" };
  const late = isLateResolution(messageStatus(original, { now, settings }));
  mb.markAcknowledged({ messageId: original.id });
  mb.recordResolution({
    messageId: original.id,
    kind,
    // The stored recipient id (the view trusts only the recipient); the
    // authenticated resolver goes in byAddress (a role's new holder, R7.20).
    by: original.to_session_id,
    byAddress,
    late,
    replyMessageId,
    at: now
  });
  return { ok: true, kind, late };
}
