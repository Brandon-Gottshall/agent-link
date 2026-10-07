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
