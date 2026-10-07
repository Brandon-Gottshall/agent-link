// src/delivery/message-status.js
//
// Message labels and resolution status (design doc section 7).
//
// Labels: every message carries To, From, and an Anticipation (`reply`,
// `action`, or `fyi`, default `fyi`), plus an optional `replyBy` deadline.
// Only anticipating messages (`reply`, `action`) have a status:
//
//   pending ──reply──> replied   ──decline──> declined   ──done──> done
//      ├── reminder cap reached, one interval later ──> unresolved
//      └── replyBy passed ─────────────────────────────> expired
//
// `unresolved` and `expired` are not final: a late resolution replaces them
// (and is recorded with late:true). Status is computed from the mailbox's
// stored events and the clock whenever it is read, so no timer process is
// needed (R7.17).
import { AgentLinkError } from "../shared/errors.js";
import { env as lookupEnv } from "../shared/env.js";
import { envelopeMessageId } from "../shared/envelope.js";

export const ANTICIPATIONS = Object.freeze(["reply", "action", "fyi"]);
export const RESOLUTIONS = Object.freeze(["reply", "decline", "done"]);
export const MESSAGE_STATUSES = Object.freeze(["pending", "replied", "declined", "done", "unresolved", "expired"]);

export const DEFAULT_REMINDER_LIMIT = 3;
export const MAX_REMINDER_LIMIT = 20;
// R7.13: default and minimum.
export const MIN_REMINDER_INTERVAL_MS = 30_000;
// R7.1: replyBy must leave the recipient at least this long.
export const MIN_REPLY_BY_LEAD_MS = 30_000;

const RESOLVED_STATUS = Object.freeze({ reply: "replied", decline: "declined", done: "done" });
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * @typedef {object} ReminderSettings
 * @property {number} limit        reminders per open message before `unresolved`
 * @property {number} intervalMs   minimum time between showings of an open message
 * @property {{code: string, message: string}[]} warnings  settings that were ignored
 */

/**
 * AGENT_LINK_REMINDER_LIMIT (integer 0..20, default 3) and
 * AGENT_LINK_REMINDER_INTERVAL_MS (default and minimum 30000). A value out
 * of range is ignored and reported in `warnings` (health shows them).
 * @param {Record<string, string | undefined>} [source]
 * @returns {ReminderSettings}
 */
export function reminderSettings(source = process.env) {
  /** @type {{code: string, message: string}[]} */
  const warnings = [];
  let limit = DEFAULT_REMINDER_LIMIT;
  const rawLimit = lookupEnv("AGENT_LINK_REMINDER_LIMIT", source).value;
  if (rawLimit !== undefined) {
    const n = /^\s*\d+\s*$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (Number.isInteger(n) && n >= 0 && n <= MAX_REMINDER_LIMIT) {
      limit = n;
    } else {
      warnings.push({
        code: "reminder_limit_ignored",
        message: `AGENT_LINK_REMINDER_LIMIT must be an integer 0..${MAX_REMINDER_LIMIT}; using ${DEFAULT_REMINDER_LIMIT}.`
      });
    }
  }
  let intervalMs = MIN_REMINDER_INTERVAL_MS;
  const rawInterval = lookupEnv("AGENT_LINK_REMINDER_INTERVAL_MS", source).value;
  if (rawInterval !== undefined) {
    const n = /^\s*\d+\s*$/.test(rawInterval) ? Number(rawInterval) : NaN;
    if (Number.isSafeInteger(n) && n >= MIN_REMINDER_INTERVAL_MS) {
      intervalMs = n;
    } else {
      warnings.push({
        code: "reminder_interval_ignored",
        message: `AGENT_LINK_REMINDER_INTERVAL_MS must be an integer of at least ${MIN_REMINDER_INTERVAL_MS}; using ${MIN_REMINDER_INTERVAL_MS}.`
      });
    }
  }
  return { limit, intervalMs, warnings };
}

/**
 * @param {string} path
 * @param {string} rule
 * @param {string} expected
 * @param {string} message
 */
function invalid(path, rule, expected, message) {
  return new AgentLinkError("invalid_arguments", message, {
    details: { errors: [{ path, rule, expected }] }
  });
}

/**
 * Validates and defaults a send's labels (R7.1, R7.2).
 *  - `anticipation` absent: `fyi`, or `reply` when the sender waits for one.
 *  - `fyi` with waitForReply, or with replyBy: invalid_arguments.
 *  - `replyBy`: ISO 8601, at least 30 s after `now`; returned as epoch ms.
 * @param {{anticipation?: unknown, replyBy?: unknown, waitForReply?: unknown, now?: number}} input
 * @returns {{anticipation: "reply" | "action" | "fyi", replyBy: number | null}}
 */
export function resolveLabels({ anticipation, replyBy, waitForReply = false, now = Date.now() } = {}) {
  let label = anticipation;
  if (label === undefined || label === null) {
    label = waitForReply === true ? "reply" : "fyi";
  } else if (typeof label !== "string" || !ANTICIPATIONS.includes(label)) {
    throw invalid("anticipation", "enum", "reply | action | fyi", "`anticipation` must be reply, action, or fyi.");
  }
  if (label === "fyi" && waitForReply === true) {
    throw invalid("anticipation", "conflict", "reply or action with waitForReply",
      "anticipation \"fyi\" means no reply is expected, so it cannot be combined with waitForReply=true.");
  }
  let replyByMs = null;
  if (replyBy !== undefined && replyBy !== null) {
    if (label === "fyi") {
      throw invalid("replyBy", "conflict", "omitted for fyi", "`replyBy` needs anticipation \"reply\" or \"action\"; an fyi message has no deadline.");
    }
    const parsed = typeof replyBy === "string" && ISO_8601.test(replyBy) ? Date.parse(replyBy) : NaN;
    if (!Number.isFinite(parsed)) {
      throw invalid("replyBy", "format", "ISO 8601 date-time, e.g. 2026-10-07T15:00:00Z", "`replyBy` must be an ISO 8601 date-time with a time zone.");
    }
    if (parsed - now < MIN_REPLY_BY_LEAD_MS) {
      throw invalid("replyBy", "range", "at least 30 s after the send", "`replyBy` must be at least 30 seconds in the future.");
    }
    replyByMs = parsed;
  }
  return { anticipation: /** @type {"reply" | "action" | "fyi"} */ (label), replyBy: replyByMs };
}

/** @param {Record<string, any> | null | undefined} row */
export function isAnticipating(row) {
  return row?.anticipation === "reply" || row?.anticipation === "action";
}

/**
 * @typedef {object} StatusView
 * @property {string | null} status       null for fyi
 * @property {{kind: string, by: string | null, at: string | null, late: boolean, replyMessageId: string | null} | null} resolution
 * @property {{count: number, limit: number, lastAt: string | null, nextDueAt: string | null}} reminders
 * @property {boolean} due                a reminder may be shown now
 * @property {number | null} transitionAt epoch ms of the unresolved/expired transition
 */

const iso = (/** @type {number | null | undefined} */ ms) => (Number.isFinite(ms) ? new Date(/** @type {number} */ (ms)).toISOString() : null);

/**
 * The status of one mailbox row (mailbox view shape) at `now`.
 * @param {Record<string, any>} row
 * @param {{now?: number, settings?: ReminderSettings}} [options]
 * @returns {StatusView}
 */
export function messageStatus(row, { now = Date.now(), settings = reminderSettings() } = {}) {
  const reminders = Array.isArray(row?.reminders) ? row.reminders : [];
  const count = reminders.reduce((max, r) => Math.max(max, Number(r?.n) || 0), 0);
  const lastReminderAt = reminders.reduce((max, r) => Math.max(max, Number(r?.at) || 0), 0) || null;
  const firstShownAt = Number.isFinite(row?.first_delivered_at) ? row.first_delivered_at : null;
  const lastShownAt = firstShownAt === null && lastReminderAt === null
    ? null
    : Math.max(firstShownAt ?? 0, lastReminderAt ?? 0);
  const base = {
    resolution: null,
    reminders: { count, limit: settings.limit, lastAt: iso(lastReminderAt), nextDueAt: null },
    due: false,
    transitionAt: null
  };
  if (!isAnticipating(row)) return { status: null, ...base };
  if (row.resolution && RESOLVED_STATUS[row.resolution.kind]) {
    return {
      status: RESOLVED_STATUS[row.resolution.kind],
      ...base,
      resolution: {
        kind: row.resolution.kind,
        by: row.resolution.by ?? null,
        at: iso(row.resolution.at),
        late: row.resolution.late === true,
        replyMessageId: row.resolution.replyMessageId ?? null
      }
    };
  }
  const expiredAt = Number.isFinite(row.reply_by) ? row.reply_by : null;
  // R7.16: one interval after the last allowed showing (with limit 0, one
  // interval after first delivery). Never before the message was shown.
  const unresolvedAt = lastShownAt !== null && count >= settings.limit ? lastShownAt + settings.intervalMs : null;
  const transitions = [
    ...(expiredAt !== null && now >= expiredAt ? [{ status: "expired", at: expiredAt }] : []),
    ...(unresolvedAt !== null && now >= unresolvedAt ? [{ status: "unresolved", at: unresolvedAt }] : [])
  ].sort((a, b) => a.at - b.at);
  if (transitions.length) {
    return { status: transitions[0].status, ...base, transitionAt: transitions[0].at };
  }
  const nextDueAt = lastShownAt !== null && count < settings.limit ? lastShownAt + settings.intervalMs : null;
  return {
    status: "pending",
    ...base,
    reminders: { ...base.reminders, nextDueAt: iso(nextDueAt) },
    due: nextDueAt !== null && now >= nextDueAt
  };
}

/**
 * Delivery state of a row (section 1.5): queued, delivered, or acknowledged.
 * @param {Record<string, any>} row
 */
export function deliveryState(row) {
  if (row?.acknowledged_at) return "acknowledged";
  if (row?.delivered_at || row?.first_delivered_at) return "delivered";
  return "queued";
}

/**
 * The structured label/status fields for a mailbox row in a tool result
 * (R7.4).
 * @param {Record<string, any>} row
 * @param {{now?: number, settings?: ReminderSettings}} [options]
 */
export function labelFields(row, options = {}) {
  const view = messageStatus(row, options);
  return {
    anticipation: ANTICIPATIONS.includes(row?.anticipation) ? row.anticipation : "fyi",
    replyBy: iso(row?.reply_by),
    // Validated like the envelope (R2.8): a ULID, or "invalid".
    inReplyTo: row?.reply_to_message_id ? envelopeMessageId(row.reply_to_message_id) : null,
    status: view.status,
    resolution: view.resolution,
    reminders: view.status === null ? null : view.reminders
  };
}

/**
 * Whether a resolution now is late: after `unresolved` or `expired`.
 * @param {StatusView} view
 */
export function isLateResolution(view) {
  return view.status === "unresolved" || view.status === "expired";
}
