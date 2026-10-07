// src/registry/addresses.js
//
// Read-time id migration (design doc R1.6). Mailbox rows and receipts name
// sessions by whatever id was current when they were written: `local_<uuid>`
// sidecar ids, raw CLI ids, bare thread ids, or `claude:` addresses built
// from a CLI id that Claude Desktop has since rotated. Readers call these
// helpers to show each session's CURRENT canonical address beside the stored
// id; the stored lines are never rewritten.
//
// Claude ids resolve through the prior-id-aware session index
// (findClaudeSessionById: sidecar ids, current and prior CLI ids,
// transcripts), so `claude:<prior id>` and `claude:<current id>` name the
// same session.

import { claudeSessionAliases } from "../claude/identity.js";
import { findClaudeSessionById } from "../claude/session-index.js";
import { peerMessageFromMailbox, peerMessageResult } from "../shared/envelope.js";
import { codexAddress, isHarness, makeAddressCache, parseAddress } from "../shared/identity.js";
import { labelFields } from "../delivery/message-status.js";

/** @typedef {import("../shared/receipt-index.js").ReceiptAddressResolver} ReceiptAddressResolver */

// One cache per process: a lookup is a few stats (and, for a bare id, a walk
// over cached sidecar parses), and the same senders recur on every read.
const cachedAddress = makeAddressCache({
  lookupSession: (id) => findClaudeSessionById(id)
});

const SESSION_TTL_MS = 30_000;
/** @type {Map<string, {session: any, at: number}>} */
const sessionCache = new Map();

/**
 * The Claude session an id or address names (prior ids included), cached.
 * @param {string} id
 */
function claudeSessionFor(id) {
  const key = id.replace(/^claude:/, "");
  const hit = sessionCache.get(key);
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.session;
  let session = null;
  try {
    session = findClaudeSessionById(key);
  } catch {
    session = null;
  }
  if (sessionCache.size >= 2_000) sessionCache.delete(/** @type {string} */ (sessionCache.keys().next().value));
  sessionCache.set(key, { session, at: Date.now() });
  return session;
}

/**
 * The canonical address of a stored id and kind (the section 1.3 migration
 * table): an address, `external`, or `invalid`.
 * @param {unknown} storedId
 * @param {unknown} storedKind
 * @returns {string}
 */
export function storedAddress(storedId, storedKind) {
  return cachedAddress(storedId, storedKind);
}

// Mailbox rows written before kinds were recorded came from the Claude-only
// mailbox (through 0.3), so a missing or unrecognized kind is `claude`, the
// documented default, rather than a stringified "undefined".
const MAILBOX_KINDS = new Set(["claude", "codex", "external"]);
/**
 * @param {unknown} kind
 */
function mailboxKind(kind) {
  return typeof kind === "string" && MAILBOX_KINDS.has(kind) ? kind : "claude";
}

/**
 * fromAddress / toAddress for a mailbox row (snake_case store shape).
 * @param {Record<string, any>} row
 * @returns {{fromAddress: string, toAddress: string}}
 */
export function mailboxRowAddresses(row = {}) {
  return {
    fromAddress: storedAddress(row.from_session_id, mailboxKind(row.from_session_kind)),
    toAddress: storedAddress(row.to_session_id, mailboxKind(row.to_session_kind))
  };
}

/**
 * The session-index-aware address resolver for envelopes (installed by the
 * server at startup; see setEnvelopeAddressResolver).
 * @param {string} storedId
 * @param {string} harness
 * @returns {string}
 */
export function envelopeAddressResolver(storedId, harness) {
  return storedAddress(storedId, harness);
}

/**
 * A mailbox row as a tool result: the validated envelope fields
 * (peerMessageResult), fromAddress / toAddress, and the label and status
 * fields (design R7.4: anticipation, replyBy, inReplyTo, status,
 * resolution, reminders).
 * @param {Record<string, any>} row
 * @param {{includeEnvelope?: boolean, now?: number}} [options]
 */
export function mailboxRowResult(row, { now, ...options } = {}) {
  return {
    ...peerMessageResult(peerMessageFromMailbox(row), options),
    ...mailboxRowAddresses(row),
    ...labelFields(row, now === undefined ? {} : { now })
  };
}

/**
 * The current address of a receipt's target: the address recorded at write
 * time (canonicalized again, since a Claude CLI id may have rotated since),
 * else derived from the legacy target fields. Null when the receipt names no
 * session.
 * @param {Record<string, any> | null | undefined} target
 * @returns {string | null}
 */
export function receiptTargetAddress(target) {
  if (!target || typeof target !== "object") return null;
  if (typeof target.address === "string" && target.address) {
    const address = storedAddress(target.address, null);
    return address.includes(":") ? address : null;
  }
  if (typeof target.threadId === "string" && target.threadId && target.kind !== "claude") {
    return codexAddress(target.threadId);
  }
  if (typeof target.sessionId === "string" && target.sessionId) {
    const address = storedAddress(target.sessionId, isHarness(target.kind) ? target.kind : "claude");
    return address.includes(":") ? address : null;
  }
  return null;
}

/**
 * Every stored id that names the same session as `address`: for Claude, the
 * session's sidecar id, current and prior CLI ids, and their `local_` forms;
 * for Codex, the thread id.
 * @param {string} address
 * @returns {string[]}
 */
export function addressAliases(address) {
  const parsed = parseAddress(address);
  if (!parsed) return [];
  if (parsed.harness === "codex") return [parsed.id, parsed.address];
  const session = claudeSessionFor(parsed.id);
  const ids = session ? claudeSessionAliases(session) : claudeSessionAliases(parsed.id);
  return [...new Set([...ids, ...ids.map((id) => `claude:${id}`), parsed.address])];
}

/**
 * The resolver the receipt index uses to read addresses (injected by the
 * server at startup; see setReceiptAddressResolver).
 * @type {ReceiptAddressResolver}
 */
export const receiptAddressResolver = {
  targetAddress: receiptTargetAddress,
  canonical: (address) => {
    const value = storedAddress(address, null);
    return value.includes(":") ? value : null;
  },
  aliases: addressAliases
};
