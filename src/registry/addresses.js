// src/registry/addresses.js
//
// Read-time id migration (design doc R1.6). Mailbox rows and receipts written
// before addresses existed name sessions by legacy ids (`local_<uuid>`, raw
// CLI ids, bare thread ids). Readers call these helpers to show the canonical
// address beside the stored id; the stored lines are never rewritten.

import { findSidecarSessionById } from "../claude/session-index.js";
import { peerMessageFromMailbox, peerMessageResult } from "../shared/envelope.js";
import { codexAddress, makeAddressCache } from "../shared/identity.js";

// One cache per process: a `local_<x>` sidecar lookup is a few stats, and the
// same senders recur on every inbox read.
const cachedAddress = makeAddressCache({
  lookupSidecar: (sidecarId) => findSidecarSessionById(sidecarId)
});

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

/**
 * fromAddress / toAddress for a mailbox row (snake_case store shape).
 * @param {Record<string, any>} row
 * @returns {{fromAddress: string, toAddress: string}}
 */
export function mailboxRowAddresses(row = {}) {
  return {
    fromAddress: storedAddress(row.from_session_id, row.from_session_kind),
    toAddress: storedAddress(row.to_session_id, row.to_session_kind ?? "claude")
  };
}

/**
 * The address of a receipt's target: the one recorded at write time, else
 * derived from the legacy target fields. Null when the receipt names no
 * session.
 * @param {Record<string, any> | null | undefined} target
 * @returns {string | null}
 */
export function receiptTargetAddress(target) {
  if (!target || typeof target !== "object") return null;
  if (typeof target.address === "string" && target.address) return target.address;
  if (typeof target.threadId === "string" && target.threadId && target.kind !== "claude") {
    return codexAddress(target.threadId);
  }
  if (typeof target.sessionId === "string" && target.sessionId) {
    const address = storedAddress(target.sessionId, "claude");
    return address.startsWith("claude:") ? address : null;
  }
  return null;
}

/**
 * A mailbox row as a tool result: the validated envelope fields
 * (peerMessageResult) plus fromAddress / toAddress.
 * @param {Record<string, any>} row
 * @param {{includeEnvelope?: boolean}} [options]
 */
export function mailboxRowResult(row, options = {}) {
  return { ...peerMessageResult(peerMessageFromMailbox(row), options), ...mailboxRowAddresses(row) };
}
