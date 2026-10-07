// src/claude/mailbox.js
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  legacyMailboxPaths,
  mailboxPath as defaultMailboxPath,
  stateDir
} from "../shared/paths.js";
import { ensureStateDir, tightenMode } from "../shared/state.js";

// The mailbox lives in the Agent Link state dir (~/.agent-link/mailbox.jsonl,
// see src/shared/paths.js). With no override, reads also merge the 0.4.x
// mailbox under ~/.claude/agent-link (and <CLAUDE_CONFIG_DIR>/agent-link);
// writes only ever go to the new file and the legacy files are never changed.

// Every hook, poll and listing re-reads the whole mailbox, so one huge body
// would stall every session. Bodies are capped at 64 KiB (UTF-8 bytes).
export const MAX_MESSAGE_BODY_BYTES = 64 * 1024;

// Hard cap on one serialized mailbox event (one JSONL line), whatever its
// source: metadata, ids, or a body that JSON escaping expands. JSON escaping
// can grow a body up to 6x (control characters become \uXXXX), so 512 KiB
// never rejects a body within MAX_MESSAGE_BODY_BYTES plus bounded metadata.
export const MAX_EVENT_LINE_BYTES = 512 * 1024;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Returns a tool error object when `body` exceeds the cap, otherwise null.
export function messageBodyTooLarge(body) {
  const bytes = Buffer.byteLength(String(body ?? ""), "utf8");
  if (bytes <= MAX_MESSAGE_BODY_BYTES) return null;
  return {
    error: "invalid_arguments",
    message: `\`body\` is ${bytes} bytes; Agent Link message bodies are limited to ${MAX_MESSAGE_BODY_BYTES} bytes (64 KiB). Send a shorter message, or point the receiver at a file.`,
    bodyBytes: bytes,
    maxBodyBytes: MAX_MESSAGE_BODY_BYTES
  };
}

// Precedence: an explicit mailboxPath option always wins over the
// environment, so a caller that names a mailbox gets that mailbox. A relative
// AGENT_LINK_MAILBOX_PATH value throws a PathConfigError (src/shared/paths.js)
// naming the variable.
/** @typedef {{mailboxPath?: string}} MailboxLocation */

/** @param {MailboxLocation} [location] */
export function resolveMailboxPath(location = {}) {
  // The legacy `dbPath` option (deprecated since 0.2.1) was removed in 0.6.0.
  // Fail loudly rather than silently falling back to the default mailbox.
  if (Object.hasOwn(location, "dbPath")) {
    throw new TypeError("The mailbox dbPath option was removed in 0.6.0; pass mailboxPath (the .jsonl file) instead.");
  }
  if (location.mailboxPath) return location.mailboxPath;
  return defaultMailboxPath();
}

// Every file the mailbox view is built from: the legacy mailboxes first, then
// the file new events go to. An explicit path (option or environment) is a
// complete choice and is read alone.
/** @param {MailboxLocation} [options] */
export function mailboxReadPaths(options = {}) {
  const writePath = resolveMailboxPath(options);
  if (options.mailboxPath) return [writePath];
  return [...legacyMailboxPaths(), writePath];
}

function isDefaultMailbox(mailboxPath) {
  return path.resolve(mailboxPath) === path.resolve(stateDir(), "mailbox.jsonl");
}

// The mailbox directory is created 0700 and the mailbox file 0600. An
// existing mailbox file this user owns is tightened to 0600. The directory is
// only tightened when it is the Agent Link state dir: a custom path may live
// in a shared directory that is not ours to change.
function ensurePrivateMailbox(mailboxPath) {
  if (isDefaultMailbox(mailboxPath)) {
    ensureStateDir();
  } else {
    fs.mkdirSync(path.dirname(mailboxPath), { recursive: true, mode: DIR_MODE });
  }
  tightenMode(mailboxPath, FILE_MODE);
}

// Read-only status for health checks: never creates the state directory or
// the mailbox file (a health call on a Codex-only machine must not create
// ~/.agent-link).
export function mailboxStatus(options = {}) {
  const mailboxPath = resolveMailboxPath(options);
  const readPaths = mailboxReadPaths(options);
  const exists = fs.existsSync(mailboxPath);
  const legacyReadPaths = readPaths.filter((p) => p !== mailboxPath && fs.existsSync(p));
  let pendingMessagesCount = 0;
  let readable = true;
  if (exists || legacyReadPaths.length) {
    try {
      pendingMessagesCount = mergedView(readPaths).filter((m) => !m.delivered_at).length;
    } catch {
      readable = false;
      pendingMessagesCount = null;
    }
  }
  return {
    path: mailboxPath,
    exists,
    readable,
    writable: canWrite(exists ? mailboxPath : path.dirname(mailboxPath)),
    pendingMessagesCount,
    legacyReadPaths
  };
}

// Writable if the target exists and is writable, or its nearest existing
// ancestor is (so it could be created).
function canWrite(target) {
  let current = path.resolve(target);
  while (true) {
    if (fs.existsSync(current)) {
      try {
        fs.accessSync(current, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function openMailbox(options = {}) {
  const mailboxPath = resolveMailboxPath(options);
  const readPaths = mailboxReadPaths(options);
  ensurePrivateMailbox(mailboxPath);
  const view = () => mergedView(readPaths);

  function appendEvent(event) {
    const line = JSON.stringify(event) + "\n";
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_EVENT_LINE_BYTES) {
      throw new Error(`Agent Link mailbox event is ${bytes} bytes; one event is limited to ${MAX_EVENT_LINE_BYTES} bytes (512 KiB). Shorten the message or its metadata.`);
    }
    fs.appendFileSync(mailboxPath, line, { encoding: "utf8", mode: FILE_MODE });
  }

  /**
   * @param {{
   *   fromSessionId: string,
   *   fromSessionKind: string,
   *   toSessionId: string,
   *   toSessionKind: string,
   *   body: string,
   *   metadata?: object | null,
   *   replyToMessageId?: string | null
   * }} message
   */
  function insertMessage({
    fromSessionId,
    fromSessionKind,
    toSessionId,
    toSessionKind,
    body,
    metadata,
    replyToMessageId = null
  }) {
    const tooLarge = messageBodyTooLarge(body);
    if (tooLarge) throw new Error(tooLarge.message);
    const id = ulid();
    const now = Date.now();
    appendEvent({
      type: "message",
      at: now,
      message: {
        id,
        from_session_id: fromSessionId,
        from_session_kind: fromSessionKind,
        to_session_id: toSessionId,
        to_session_kind: toSessionKind,
        body,
        metadata_json: metadata ? JSON.stringify(metadata) : null,
        sent_at: now,
        delivered_at: null,
        acknowledged_at: null,
        reply_to_message_id: replyToMessageId
      }
    });
    return id;
  }

  function markDelivered({ messageId, deliveredAt = Date.now() }) {
    appendEvent({ type: "delivered", at: deliveredAt, messageId });
  }

  function markAcknowledged({ messageId, acknowledgedAt = Date.now() }) {
    appendEvent({ type: "acknowledged", at: acknowledgedAt, messageId });
  }

  // Undo a delivery claim whose notification failed, so the message is
  // pending again for the next poll or the inbox tool.
  function releaseDelivery({ messageId, releasedAt = Date.now() }) {
    appendEvent({ type: "released", at: releasedAt, messageId });
  }

  // `toSessionIds` matches any of several ids for one recipient (see
  // claudeSessionAliases()).
  /** @param {{toSessionId?: string, toSessionIds?: string[]}} [query] */
  function listPendingFor({ toSessionId, toSessionIds } = {}) {
    const recipients = idSet(toSessionId, toSessionIds);
    return view()
      .filter((m) => recipients.has(m.to_session_id) && !m.delivered_at)
      .sort((a, b) => a.sent_at - b.sent_at);
  }

  return {
    insertMessage,
    markDelivered,
    markAcknowledged,
    releaseDelivery,
    listPendingFor,
    // Marks delivered only what it returns: with `limit`, the rest stays
    // pending for the next read.
    /** @param {{toSessionId?: string, toSessionIds?: string[], limit?: number}} [query] */
    drainFor({ toSessionId, toSessionIds, limit } = {}) {
      let rows = listPendingFor({ toSessionId, toSessionIds });
      if (Number.isFinite(limit)) rows = rows.slice(0, Math.max(0, Math.floor(limit)));
      for (const row of rows) markDelivered({ messageId: row.id });
      return rows;
    },
    // Returns the reply message id, or null when no reply was written.
    ackMessage({ messageId, body }) {
      const original = view().find((m) => m.id === messageId);
      markAcknowledged({ messageId });
      if (body && original) {
        return insertMessage({
          fromSessionId: original.to_session_id,
          fromSessionKind: original.to_session_kind,
          toSessionId: original.from_session_id,
          toSessionKind: original.from_session_kind,
          body,
          replyToMessageId: messageId
        });
      }
      return null;
    },
    getMessage({ messageId }) {
      return view().find((m) => m.id === messageId) ?? null;
    },
    inspect(filters = {}) {
      let rows = view();
      if (filters.fromSessionId) rows = rows.filter((m) => m.from_session_id === filters.fromSessionId);
      if (filters.toSessionId) rows = rows.filter((m) => m.to_session_id === filters.toSessionId);
      if (Array.isArray(filters.fromSessionIds)) {
        const from = idSet(null, filters.fromSessionIds);
        rows = rows.filter((m) => from.has(m.from_session_id));
      }
      if (Array.isArray(filters.toSessionIds)) {
        const to = idSet(null, filters.toSessionIds);
        rows = rows.filter((m) => to.has(m.to_session_id));
      }
      // Messages sent or received by any of these ids (per-caller scoping).
      if (Array.isArray(filters.involvingSessionIds)) {
        const involved = idSet(null, filters.involvingSessionIds);
        rows = rows.filter((m) => involved.has(m.from_session_id) || involved.has(m.to_session_id));
      }
      if (filters.replyToMessageId) rows = rows.filter((m) => m.reply_to_message_id === filters.replyToMessageId);
      if (filters.undelivered) rows = rows.filter((m) => !m.delivered_at);
      if (filters.pendingAck) rows = rows.filter((m) => !m.acknowledged_at);
      if (filters.since) rows = rows.filter((m) => m.sent_at >= filters.since);
      const limit = Number.isFinite(filters.limit) ? Math.max(0, Math.floor(filters.limit)) : 200;
      return rows.sort((a, b) => b.sent_at - a.sent_at).slice(0, limit);
    },
    close() {}
  };
}

function idSet(single, many) {
  const out = new Set();
  if (typeof single === "string" && single) out.add(single);
  for (const id of Array.isArray(many) ? many : []) {
    if (typeof id === "string" && id) out.add(id);
  }
  return out;
}

// Builds the message view from one or more mailbox files (R4.5): legacy files
// first, then the file new events go to. Message events are deduped by id
// (the first file listed wins). Delivery-state events are applied after every
// message is known, so a delivery recorded in the new file for a message that
// only exists in a legacy file still counts. They are applied file by file,
// each in its own order, and never re-sorted by `at` across files: clock skew
// between writers must not change how one file reads after an unrelated write
// to another.
function mergedView(paths) {
  const messages = new Map();
  const stateEvents = [];
  for (const file of paths) {
    for (const event of readEvents(file)) {
      if (event?.type === "message" && event.message?.id) {
        const id = String(event.message.id);
        if (!messages.has(id)) messages.set(id, normalizeMessage(event.message, event.at));
      } else if (event && typeof event === "object") {
        stateEvents.push(event);
      }
    }
  }
  for (const event of stateEvents) {
    if (event.type === "delivered" && event.messageId && messages.has(event.messageId)) {
      const message = messages.get(event.messageId);
      message.delivered_at = event.at ?? Date.now();
    } else if (event.type === "acknowledged" && event.messageId && messages.has(event.messageId)) {
      const message = messages.get(event.messageId);
      message.acknowledged_at = event.at ?? Date.now();
    } else if (event.type === "released" && event.messageId && messages.has(event.messageId)) {
      messages.get(event.messageId).delivered_at = null;
    }
  }
  return [...messages.values()];
}

function readEvents(mailboxPath) {
  if (!fs.existsSync(mailboxPath)) return [];
  const raw = fs.readFileSync(mailboxPath, "utf8");
  if (!raw.trim()) return [];
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore corrupt trailing or historical lines; the mailbox is append-only
      // and should remain readable even after an interrupted write.
    }
  }
  return events;
}

// `sent_at` falls back to the event time, then 0 — never to "now", which made
// the same historical record sort differently on every read.
function normalizeTimestamp(...candidates) {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const n = Number(candidate);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function normalizeMessage(message, eventAt) {
  return {
    id: String(message.id),
    from_session_id: String(message.from_session_id),
    from_session_kind: String(message.from_session_kind),
    to_session_id: String(message.to_session_id),
    to_session_kind: String(message.to_session_kind),
    body: String(message.body ?? ""),
    metadata_json: message.metadata_json ?? null,
    sent_at: normalizeTimestamp(message.sent_at, eventAt),
    delivered_at: message.delivered_at ?? null,
    acknowledged_at: message.acknowledged_at ?? null,
    reply_to_message_id: message.reply_to_message_id ?? null
  };
}

function ulid() {
  const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const time = Date.now();
  let timePart = "";
  let t = time;
  for (let i = 0; i < 10; i++) {
    timePart = ENC[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  let randPart = "";
  const rb = crypto.randomBytes(16);
  for (const b of rb) randPart += ENC[b % 32];
  return timePart + randPart;
}
