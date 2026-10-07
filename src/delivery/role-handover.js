// src/delivery/role-handover.js
//
// Role handover (design doc R7.20, T-7.9). A message sent through
// `role:<name>` is stored with the holder it resolved to at send time (the
// stored recipient) and, in its metadata, `role.via` plus `role.address`, the
// holder's address then. When the role later moves to another session while
// the message is still open (an anticipating message with no resolution),
// the role's current holder becomes the message's recipient:
//
//   - its inbox (new mail and includeOpen), hook notices, and the channel
//     bridge show the message; the previous holder's no longer do;
//   - reminders go to the new holder only, and the count carries over,
//     because reminders are recorded per message (the cap still applies);
//   - the new holder may resolve it; the previous holder gets
//     wrong_recipient.
//
// Nothing is rewritten: the recipient is derived at read time from the
// stored `via` and the current role table. A role that is cleared, held by
// several addresses (a hand edit), or unreadable leaves the message with its
// stored recipient, and so does a message sent before this rule existed
// (no `role.address` in its metadata). An fyi message never moves. A
// resolved message stays with whoever resolved it: the holder that resolved
// it after a handover is its recipient from then on (so a second attempt is
// already_resolved, not wrong_recipient), and a later role change moves it
// no further.

/** @typedef {import("../registry/roles.js").RoleTable} RoleTable */

const ROLE_VIA = /^role:([a-z0-9-]{1,40})$/;
const HARNESS_PREFIX = /^(?:claude|codex):/;

/**
 * The role route a mailbox row was sent through, or null.
 * @param {Record<string, any> | null | undefined} row
 * @returns {{name: string, via: string, sentTo: string | null} | null}
 */
export function roleRoute(row) {
  // Cheap test first: hooks scan every row, and most carry no role.
  if (!row || typeof row.metadata_json !== "string" || !row.metadata_json.includes("\"role\"")) return null;
  let meta;
  try {
    meta = JSON.parse(row.metadata_json);
  } catch {
    return null;
  }
  const role = meta && typeof meta === "object" ? meta.role : null;
  if (!role || typeof role !== "object" || typeof role.via !== "string") return null;
  const match = ROLE_VIA.exec(role.via);
  if (!match) return null;
  return { name: match[1], via: role.via, sentTo: typeof role.address === "string" && role.address ? role.address : null };
}

/**
 * The session a role-addressed row has been handed over to: while it is
 * open, the role's current holder when that is not the holder at send time;
 * once resolved, the resolver when that is not the holder at send time.
 * Null when the stored recipient is still the recipient.
 * @param {Record<string, any> | null | undefined} row
 * @param {RoleTable | null | undefined} table
 * @returns {string | null}
 */
export function handedOverTo(row, table) {
  if (!row || !table || !table.roles) return null;
  if (row.anticipation === "fyi" || row.anticipation === undefined) return null;
  if (row.anticipation !== "reply" && row.anticipation !== "action") return null;
  const route = roleRoute(row);
  if (!route || !route.sentTo) return null;
  if (row.resolution) {
    const by = row.resolution.by;
    return typeof by === "string" && by.includes(":") && by !== route.sentTo ? by : null;
  }
  const entry = table.roles[route.name];
  const holder = entry && typeof entry.address === "string" ? entry.address : null;
  if (!holder || holder === route.sentTo) return null;
  return holder;
}

/**
 * The role table to derive handovers from, or null when there is none or it
 * cannot be read (then nothing is handed over). Never throws.
 * @param {{read: () => {table: RoleTable, error: string | null}} | null | undefined} roles
 * @returns {RoleTable | null}
 */
export function readRoleTable(roles) {
  if (!roles || typeof roles.read !== "function") return null;
  try {
    const result = roles.read();
    return result && !result.error ? result.table : null;
  } catch {
    return null;
  }
}

/**
 * True when `address` names the session whose ids are `ids` (an address or
 * any stored id form, with or without the harness prefix).
 * @param {string} address
 * @param {Set<string>} ids
 */
export function addressNames(address, ids) {
  return ids.has(address) || ids.has(address.replace(HARNESS_PREFIX, ""));
}

/**
 * True when a delivery event recorded for one of `ids` exists.
 * @param {Record<string, any>} row
 * @param {Set<string>} ids
 */
export function deliveredTo(row, ids) {
  return (Array.isArray(row.deliveries) ? row.deliveries : [])
    .some((d) => typeof d?.to === "string" && addressNames(d.to, ids));
}

/**
 * Whether a row the caller receives is still new to it. A handed-over row
 * is a fresh delivery for the role's new holder (the owner's rule: role
 * coordination is never missed), whatever the previous holder saw; any other
 * row is new until delivered.
 * @param {Record<string, any>} row
 * @param {RoleTable | null} table
 * @param {Set<string>} ids  the caller's ids and address
 */
export function isPendingFor(row, table, ids) {
  return handedOverTo(row, table) ? !deliveredTo(row, ids) : !row.delivered_at;
}

/**
 * The caller's view of the mailbox: which rows it receives now, and which
 * of those are still new to it.
 * @param {{aliases: Iterable<string>, address?: string | null, table?: RoleTable | null}} caller
 */
export function recipientView({ aliases, address = null, table = null }) {
  const ids = new Set([...aliases].filter((id) => typeof id === "string" && id));
  if (typeof address === "string" && address) ids.add(address);
  const isRecipient = recipientMatcher({ aliases: ids, table });
  return {
    isRecipient,
    /** @param {Record<string, any>} row */
    isPending: (row) => isPendingFor(row, table, ids),
    /** @param {Record<string, any>} row */
    handedOver: (row) => handedOverTo(row, table) !== null
  };
}

/**
 * A predicate for "this row is addressed to the caller now": the role's
 * current holder for a handed-over row, else the stored recipient.
 * @param {{aliases: Iterable<string>, address?: string | null, table?: RoleTable | null}} caller
 * @returns {(row: Record<string, any>) => boolean}
 */
export function recipientMatcher({ aliases, address = null, table = null }) {
  const ids = new Set([...aliases].filter((id) => typeof id === "string" && id));
  if (typeof address === "string" && address) ids.add(address);
  return (row) => {
    const holder = handedOverTo(row, table);
    return holder ? addressNames(holder, ids) : ids.has(row.to_session_id);
  };
}
