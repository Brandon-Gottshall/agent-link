// src/claude/mailbox.js
import path from "node:path";
import fs from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

// The mailbox stays at ~/.claude/agent-link even when CLAUDE_CONFIG_DIR is
// set; relocating the state dir is a separate, owner-approved change.
const DEFAULT_DIR = path.join(homedir(), ".claude/agent-link");
const DEFAULT_MAILBOX_PATH = path.join(DEFAULT_DIR, "mailbox.jsonl");
const DEFAULT_LEGACY_DB_PATH = path.join(DEFAULT_DIR, "mailbox.sqlite");

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

// Precedence: explicit options (mailboxPath, then dbPath) always win over the
// environment, so a caller that names a mailbox gets that mailbox.
export function resolveMailboxPath({ mailboxPath, dbPath } = {}) {
  if (mailboxPath) return mailboxPath;
  if (dbPath) return legacyToJsonl(dbPath);
  if (process.env.AGENT_LINK_MAILBOX_PATH) return process.env.AGENT_LINK_MAILBOX_PATH;
  if (process.env.AGENT_LINK_MAILBOX_DB) return legacyToJsonl(process.env.AGENT_LINK_MAILBOX_DB);
  return DEFAULT_MAILBOX_PATH;
}

function legacyToJsonl(legacy) {
  return legacy.endsWith(".sqlite")
    ? legacy.slice(0, -".sqlite".length) + ".jsonl"
    : legacy;
}

function resolveLegacyDbPath({ mailboxPath, dbPath } = {}) {
  if (dbPath) return dbPath;
  // An explicit mailboxPath is a complete choice; never import a legacy
  // database named only by the environment into it.
  if (mailboxPath) return null;
  return process.env.AGENT_LINK_MAILBOX_DB ?? null;
}

// The mailbox directory is created 0700 and the mailbox file 0600. An
// existing mailbox file this user owns is tightened to 0600. The directory is
// only tightened when it is the default Agent Link state dir: a custom path
// may live in a shared directory that is not ours to change.
function ensurePrivateMailbox(mailboxPath) {
  const dir = path.dirname(mailboxPath);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (path.resolve(dir) === path.resolve(DEFAULT_DIR)) tightenMode(dir, DIR_MODE);
  tightenMode(mailboxPath, FILE_MODE);
}

function tightenMode(target, mode) {
  try {
    const stat = fs.statSync(target);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && stat.uid !== uid) return;
    if ((stat.mode & 0o777 & ~mode) !== 0) fs.chmodSync(target, mode);
  } catch {
    // missing or not ours: leave it alone
  }
}

// Read-only status for health checks: never creates the mailbox directory or
// file (a health call on a Codex-only machine must not create
// ~/.claude/agent-link).
export function mailboxStatus(options = {}) {
  const mailboxPath = resolveMailboxPath(options);
  const exists = fs.existsSync(mailboxPath);
  let pendingMessagesCount = 0;
  let readable = true;
  if (exists) {
    try {
      pendingMessagesCount = view(mailboxPath).filter((m) => !m.delivered_at).length;
    } catch {
      readable = false;
      pendingMessagesCount = null;
    }
  }
  return { path: mailboxPath, exists, readable, writable: canWrite(exists ? mailboxPath : path.dirname(mailboxPath)), pendingMessagesCount };
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
  ensurePrivateMailbox(mailboxPath);
  importLegacySqliteIfNeeded({
    mailboxPath,
    legacyDbPath: resolveLegacyDbPath(options) ?? (mailboxPath === DEFAULT_MAILBOX_PATH ? DEFAULT_LEGACY_DB_PATH : null)
  });

  function appendEvent(event) {
    const line = JSON.stringify(event) + "\n";
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_EVENT_LINE_BYTES) {
      throw new Error(`Agent Link mailbox event is ${bytes} bytes; one event is limited to ${MAX_EVENT_LINE_BYTES} bytes (512 KiB). Shorten the message or its metadata.`);
    }
    fs.appendFileSync(mailboxPath, line, { encoding: "utf8", mode: FILE_MODE });
  }

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
  function listPendingFor({ toSessionId, toSessionIds } = {}) {
    const recipients = idSet(toSessionId, toSessionIds);
    return view(mailboxPath)
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
    drainFor({ toSessionId, toSessionIds, limit } = {}) {
      let rows = listPendingFor({ toSessionId, toSessionIds });
      if (Number.isFinite(limit)) rows = rows.slice(0, Math.max(0, Math.floor(limit)));
      for (const row of rows) markDelivered({ messageId: row.id });
      return rows;
    },
    // Returns the reply message id, or null when no reply was written.
    ackMessage({ messageId, body }) {
      const original = view(mailboxPath).find((m) => m.id === messageId);
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
      return view(mailboxPath).find((m) => m.id === messageId) ?? null;
    },
    inspect(filters = {}) {
      let rows = view(mailboxPath);
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

function view(mailboxPath) {
  const messages = new Map();
  for (const event of readEvents(mailboxPath)) {
    if (event.type === "message" && event.message?.id) {
      messages.set(event.message.id, normalizeMessage(event.message, event.at));
    } else if (event.type === "delivered" && event.messageId && messages.has(event.messageId)) {
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

function importLegacySqliteIfNeeded({ mailboxPath, legacyDbPath }) {
  if (fs.existsSync(mailboxPath) && fs.statSync(mailboxPath).size > 0) return;
  if (!legacyDbPath || !legacyDbPath.endsWith(".sqlite") || !fs.existsSync(legacyDbPath)) return;

  const result = spawnSync("sqlite3", [
    "-json",
    legacyDbPath,
    "SELECT id, from_session_id, from_session_kind, to_session_id, to_session_kind, body, metadata_json, sent_at, delivered_at, acknowledged_at, reply_to_message_id FROM messages ORDER BY sent_at"
  ], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return;

  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return;
  }
  if (!Array.isArray(rows) || rows.length === 0) return;

  const events = [];
  for (const row of rows) {
    events.push({
      type: "message",
      at: normalizeTimestamp(row.sent_at),
      message: normalizeMessage(row)
    });
    if (row.delivered_at) events.push({ type: "delivered", at: Number(row.delivered_at), messageId: row.id });
    if (row.acknowledged_at) events.push({ type: "acknowledged", at: Number(row.acknowledged_at), messageId: row.id });
  }
  fs.appendFileSync(mailboxPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", { encoding: "utf8", mode: FILE_MODE });
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
