// src/claude/mailbox.js
import path from "node:path";
import fs from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const DEFAULT_DIR = path.join(homedir(), ".claude/agent-link");
const DEFAULT_MAILBOX_PATH = path.join(DEFAULT_DIR, "mailbox.jsonl");
const DEFAULT_LEGACY_DB_PATH = path.join(DEFAULT_DIR, "mailbox.sqlite");

export function resolveMailboxPath({ mailboxPath, dbPath } = {}) {
  if (mailboxPath) return mailboxPath;
  if (process.env.AGENT_LINK_MAILBOX_PATH) return process.env.AGENT_LINK_MAILBOX_PATH;
  const legacy = dbPath ?? process.env.AGENT_LINK_MAILBOX_DB;
  if (legacy) {
    return legacy.endsWith(".sqlite")
      ? legacy.slice(0, -".sqlite".length) + ".jsonl"
      : legacy;
  }
  return DEFAULT_MAILBOX_PATH;
}

function resolveLegacyDbPath({ dbPath } = {}) {
  return dbPath ?? process.env.AGENT_LINK_MAILBOX_DB ?? null;
}

export function openMailbox(options = {}) {
  const mailboxPath = resolveMailboxPath(options);
  fs.mkdirSync(path.dirname(mailboxPath), { recursive: true });
  importLegacySqliteIfNeeded({
    mailboxPath,
    legacyDbPath: resolveLegacyDbPath(options) ?? (mailboxPath === DEFAULT_MAILBOX_PATH ? DEFAULT_LEGACY_DB_PATH : null)
  });

  function appendEvent(event) {
    fs.appendFileSync(mailboxPath, JSON.stringify(event) + "\n", "utf8");
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
    const id = ulid();
    appendEvent({
      type: "message",
      at: Date.now(),
      message: {
        id,
        from_session_id: fromSessionId,
        from_session_kind: fromSessionKind,
        to_session_id: toSessionId,
        to_session_kind: toSessionKind,
        body,
        metadata_json: metadata ? JSON.stringify(metadata) : null,
        sent_at: Date.now(),
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

  return {
    insertMessage,
    markDelivered,
    markAcknowledged,
    listPendingFor({ toSessionId }) {
      return view(mailboxPath)
        .filter((m) => m.to_session_id === toSessionId && !m.delivered_at)
        .sort((a, b) => a.sent_at - b.sent_at);
    },
    drainFor({ toSessionId }) {
      const rows = this.listPendingFor({ toSessionId });
      for (const row of rows) markDelivered({ messageId: row.id });
      return rows;
    },
    ackMessage({ messageId, body }) {
      const original = view(mailboxPath).find((m) => m.id === messageId);
      markAcknowledged({ messageId });
      if (body && original) {
        insertMessage({
          fromSessionId: original.to_session_id,
          fromSessionKind: original.to_session_kind,
          toSessionId: original.from_session_id,
          toSessionKind: original.from_session_kind,
          body,
          replyToMessageId: messageId
        });
      }
    },
    getMessage({ messageId }) {
      return view(mailboxPath).find((m) => m.id === messageId) ?? null;
    },
    inspect(filters = {}) {
      let rows = view(mailboxPath);
      if (filters.fromSessionId) rows = rows.filter((m) => m.from_session_id === filters.fromSessionId);
      if (filters.toSessionId) rows = rows.filter((m) => m.to_session_id === filters.toSessionId);
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

function view(mailboxPath) {
  const messages = new Map();
  for (const event of readEvents(mailboxPath)) {
    if (event.type === "message" && event.message?.id) {
      messages.set(event.message.id, normalizeMessage(event.message));
    } else if (event.type === "delivered" && event.messageId && messages.has(event.messageId)) {
      const message = messages.get(event.messageId);
      message.delivered_at = event.at ?? Date.now();
    } else if (event.type === "acknowledged" && event.messageId && messages.has(event.messageId)) {
      const message = messages.get(event.messageId);
      message.acknowledged_at = event.at ?? Date.now();
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

function normalizeMessage(message) {
  return {
    id: String(message.id),
    from_session_id: String(message.from_session_id),
    from_session_kind: String(message.from_session_kind),
    to_session_id: String(message.to_session_id),
    to_session_kind: String(message.to_session_kind),
    body: String(message.body ?? ""),
    metadata_json: message.metadata_json ?? null,
    sent_at: Number(message.sent_at ?? Date.now()),
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
      at: Number(row.sent_at ?? Date.now()),
      message: normalizeMessage(row)
    });
    if (row.delivered_at) events.push({ type: "delivered", at: Number(row.delivered_at), messageId: row.id });
    if (row.acknowledged_at) events.push({ type: "acknowledged", at: Number(row.acknowledged_at), messageId: row.id });
  }
  fs.appendFileSync(mailboxPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
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
