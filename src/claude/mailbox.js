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

const ANTICIPATION_VALUES = new Set(["reply", "action", "fyi"]);
const RESOLUTION_KINDS = new Set(["reply", "decline", "done"]);

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
  const claimsDir = `${mailboxPath}.claims`;
  const view = () => mergedView(readPaths, claimsDir);

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
   *   replyToMessageId?: string | null,
   *   anticipation?: string | null,
   *   replyBy?: number | null
   * }} message
   */
  function insertMessage({
    fromSessionId,
    fromSessionKind,
    toSessionId,
    toSessionKind,
    body,
    metadata,
    replyToMessageId = null,
    anticipation = null,
    replyBy = null
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
        reply_to_message_id: replyToMessageId,
        // Labels (design section 7.2). Messages written before 0.6.0 have
        // none and read as fyi.
        anticipation: ANTICIPATION_VALUES.has(/** @type {string} */ (anticipation)) ? anticipation : "fyi",
        reply_by: Number.isFinite(replyBy) ? replyBy : null
      }
    });
    return id;
  }

  // Resolution of an anticipating message (R7.12). `by` is the message's
  // stored recipient id (to_session_id): the view trusts only a `resolved`
  // event whose `by` names the recipient, and the first trusted one wins.
  // Writers take the `resolve-<messageId>` claim first (claimResolution in
  // src/delivery/resolution.js), so concurrent resolvers cannot both write.
  /**
   * @param {{messageId: string, kind: string, by: string, byAddress?: string | null, late?: boolean, replyMessageId?: string | null, at?: number}} event
   */
  function recordResolution({ messageId, kind, by, byAddress = null, late = false, replyMessageId = null, at = Date.now() }) {
    appendEvent({ type: "resolved", at, messageId, kind, by, byAddress, late: late === true, replyMessageId });
  }

  // One reminder showing of an open message (R7.17).
  /**
   * @param {{messageId: string, n: number, via: string, at?: number}} event
   */
  function recordReminder({ messageId, n, via, at = Date.now() }) {
    appendEvent({ type: "reminded", at, messageId, n, via });
  }

  // Exactly-once claims across processes (claim-before-notify, P4-10):
  // an exclusive create of a marker file beside the mailbox. True for the
  // one caller that created it; false if it existed or could not be made.
  // `content` (optional, small) is written into the claim file, for example
  // the clock reading the claim was taken at.
  /**
   * @param {string} key
   * @param {string} [content]
   */
  function claim(key, content = "") {
    try {
      fs.mkdirSync(claimsDir, { recursive: true, mode: DIR_MODE });
      // A directory created looser (another umask, an older copy) is
      // tightened when it is ours.
      tightenMode(claimsDir, DIR_MODE);
      const fd = fs.openSync(path.join(claimsDir, claimName(key)), "wx", FILE_MODE);
      try {
        if (content) fs.writeSync(fd, String(content).slice(0, 200));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch {
      // EEXIST: another process holds the claim. Any other failure: no claim,
      // so nothing is sent twice.
      return false;
    }
  }

  // When a claim was taken (epoch ms), or null when it does not exist.
  /** @param {string} key */
  function claimTakenAt(key) {
    try {
      return fs.statSync(path.join(claimsDir, claimName(key))).mtimeMs;
    } catch {
      return null;
    }
  }

  // A claim's content, or null when it does not exist.
  /** @param {string} key */
  function claimContent(key) {
    try {
      return fs.readFileSync(path.join(claimsDir, claimName(key)), "utf8");
    } catch {
      return null;
    }
  }

  // Every claim file name, or [] when there are none.
  function listClaims() {
    return listClaimNames(claimsDir);
  }

  // Removes one claim file (garbage collection); true when it was removed.
  /** @param {string} name */
  function removeClaim(name) {
    try {
      fs.unlinkSync(path.join(claimsDir, claimName(name)));
      return true;
    } catch {
      // Already gone (another process collected it) or not ours.
      return false;
    }
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
    recordResolution,
    recordReminder,
    claim,
    claimTakenAt,
    claimContent,
    listClaims,
    removeClaim,
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
    // Low-level explicit reply from the recipient (no identity checks; the
    // reply_agent_link_message tool is the checked path). Returns the reply
    // message id, or null when no reply was written. A reply to an open
    // anticipating message also resolves it as "reply".
    ackMessage({ messageId, body }) {
      const original = view().find((m) => m.id === messageId);
      markAcknowledged({ messageId });
      if (body && original) {
        const replyId = insertMessage({
          fromSessionId: original.to_session_id,
          fromSessionKind: original.to_session_kind,
          toSessionId: original.from_session_id,
          toSessionKind: original.from_session_kind,
          body,
          replyToMessageId: messageId
        });
        if (original.anticipation !== "fyi" && !original.resolution && claim(`resolve-${messageId}`)) {
          recordResolution({ messageId, kind: "reply", by: original.to_session_id, replyMessageId: replyId });
        }
        return replyId;
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
// Claim file names are restricted to a safe character set.
/** @param {string} key */
function claimName(key) {
  return String(key).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 200);
}

/** @param {string} dir */
function listClaimNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

const REMINDER_CLAIM = /^reminder-([0-9A-HJKMNP-TV-Z]{26})-(\d{1,3})$/;

/**
 * @param {string[]} paths
 * @param {string | null} [claimsDir]
 */
function mergedView(paths, claimsDir = null) {
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
      // First surfacing, for the reminder interval (R7.13).
      message.first_delivered_at ??= message.delivered_at;
    } else if (event.type === "acknowledged" && event.messageId && messages.has(event.messageId)) {
      const message = messages.get(event.messageId);
      message.acknowledged_at = event.at ?? Date.now();
    } else if (event.type === "released" && event.messageId && messages.has(event.messageId)) {
      const message = messages.get(event.messageId);
      message.delivered_at = null;
      // An undone claim was never surfaced (unless a reminder showed it).
      if (!message.reminders.length) message.first_delivered_at = null;
    } else if (event.type === "resolved" && event.messageId && messages.has(event.messageId)) {
      const message = messages.get(event.messageId);
      // A message resolves once (R7.10): the first trusted event wins. Only
      // the recipient may resolve (R7.7), so an event whose `by` is not the
      // stored recipient id is ignored.
      if (!message.resolution && RESOLUTION_KINDS.has(event.kind) && event.by === message.to_session_id) {
        message.resolution = {
          kind: event.kind,
          by: typeof event.byAddress === "string" && event.byAddress ? event.byAddress : event.by,
          at: normalizeTimestamp(event.at),
          late: event.late === true,
          replyMessageId: typeof event.replyMessageId === "string" ? event.replyMessageId : null
        };
      }
    } else if (event.type === "reminded" && event.messageId && messages.has(event.messageId)) {
      const n = Number(event.n);
      if (Number.isInteger(n) && n > 0) {
        messages.get(event.messageId).reminders.push({
          n,
          via: typeof event.via === "string" ? event.via : null,
          at: normalizeTimestamp(event.at)
        });
      }
    }
  }
  // A reminder claim is the source of truth for its number (R7.17): a
  // process that crashed after claiming and before appending `reminded`
  // still advances the count, so the message moves toward `unresolved`.
  if (claimsDir) {
    for (const name of listClaimNames(claimsDir)) {
      const match = REMINDER_CLAIM.exec(name);
      const message = match ? messages.get(match[1]) : null;
      if (!match || !message) continue;
      const n = Number(match[2]);
      if (n < 1 || message.reminders.some((r) => r.n === n)) continue;
      let at = null;
      try {
        at = fs.statSync(path.join(claimsDir, name)).mtimeMs;
      } catch {
        continue;
      }
      message.reminders.push({ n, via: null, at });
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
    reply_to_message_id: message.reply_to_message_id ?? null,
    anticipation: ANTICIPATION_VALUES.has(message.anticipation) ? message.anticipation : "fyi",
    reply_by: Number.isFinite(message.reply_by) ? message.reply_by : null,
    first_delivered_at: message.delivered_at ?? null,
    resolution: null,
    reminders: []
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
