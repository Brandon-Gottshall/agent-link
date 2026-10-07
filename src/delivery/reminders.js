// src/delivery/reminders.js
//
// Re-surfacing open messages (design doc section 7.5). An anticipating
// message that has been delivered and is still `pending` is shown to its
// recipient again at most once per interval (AGENT_LINK_REMINDER_INTERVAL_MS,
// default and minimum 30 s), only at turn boundaries, up to the cap
// (AGENT_LINK_REMINDER_LIMIT, default 3). After that it reads `unresolved`.
//
// Paths:
//   - Claude UserPromptSubmit hook: the reminder notice as hidden context.
//   - Claude Stop hook: decision "block" with the notice as the reason, at
//     most once per interval per recipient.
//   - Codex: a reminder turn (turn/start, turnTrigger "agent-link-reminder")
//     on an idle thread. Behind AGENT_LINK_CODEX_REMINDERS (default off)
//     until the B7 spike confirms the turn-completion signal (B7b).
//
// No reminder ever uses a channel push or turn/steer (R7.14). Every reminder
// is claimed before it is shown (claim-before-notify), so when several
// processes could show the same reminder exactly one does (R7.17).
import { envFlag } from "../shared/env.js";
import { renderReminderNotice } from "../shared/envelope.js";
import { messageStatus, reminderSettings } from "./message-status.js";

export const REMINDER_VIA = Object.freeze({
  prompt: "claude-prompt-hook",
  stop: "claude-stop-hook",
  codex: "codex-turn"
});

export const CODEX_REMINDER_TURN_TRIGGER = "agent-link-reminder";

/**
 * Open anticipating messages whose reminder is due at `now`, oldest first.
 * @param {Array<Record<string, any>>} rows  mailbox view rows for one recipient
 * @param {{now?: number, settings?: import("./message-status.js").ReminderSettings}} [options]
 */
export function dueReminders(rows, { now = Date.now(), settings = reminderSettings() } = {}) {
  return rows
    .filter((row) => messageStatus(row, { now, settings }).due)
    .sort((a, b) => a.sent_at - b.sent_at);
}

/**
 * Claims and records one reminder for each due row. Returns the rows this
 * caller claimed, with their reminder number. A row another process claimed
 * first is skipped, so its reminder is shown once.
 * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
 * @param {Array<Record<string, any>>} rows  due rows (dueReminders)
 * @param {{via: string, now?: number, settings?: import("./message-status.js").ReminderSettings}} options
 * @returns {{row: Record<string, any>, n: number}[]}
 */
export function claimReminders(mb, rows, { via, now = Date.now(), settings = reminderSettings() }) {
  /** @type {{row: Record<string, any>, n: number}[]} */
  const claimed = [];
  for (const row of rows) {
    const view = messageStatus(row, { now, settings });
    if (!view.due) continue;
    const n = view.reminders.count + 1;
    if (!mb.claim(`reminder-${row.id}-${n}`)) continue;
    mb.recordReminder({ messageId: row.id, n, via, at: now });
    claimed.push({ row, n });
  }
  return claimed;
}

/**
 * The reminder notice for claimed reminders, or null when there are none.
 * @param {{row: Record<string, any>, n: number}[]} claimed
 * @param {{settings?: import("./message-status.js").ReminderSettings}} [options]
 */
export function reminderNoticeFor(claimed, { settings = reminderSettings() } = {}) {
  if (!claimed.length) return null;
  const reminder = claimed.reduce((max, c) => Math.max(max, c.n), 0);
  return renderReminderNotice(claimed.map((c) => c.row), { reminder, limit: settings.limit });
}

/**
 * The last time the Stop hook blocked for this recipient (a stop-hook
 * reminder on any of its messages), in epoch ms, or null.
 * @param {Array<Record<string, any>>} rows  every message addressed to the recipient
 */
export function lastStopBlockAt(rows) {
  let last = null;
  for (const row of rows) {
    for (const reminder of Array.isArray(row.reminders) ? row.reminders : []) {
      if (reminder?.via === REMINDER_VIA.stop && Number.isFinite(reminder.at)) {
        last = last === null ? reminder.at : Math.max(last, reminder.at);
      }
    }
  }
  return last;
}

/** Codex reminder turns are off until the B7 spike (B7b). */
export function codexRemindersEnabled(source = process.env) {
  return envFlag("AGENT_LINK_CODEX_REMINDERS", false, source);
}

/**
 * One pass of Codex reminder delivery (R7.14, Codex path). For each Codex
 * thread with due reminders: read the thread; only an idle thread gets a
 * reminder turn (an active turn is never steered; the reminder waits for the
 * turn to complete, and a thread that is not loaded is left to inbox pull
 * until B7b decides desktop push, R1.12a). The turn's text is exactly the
 * reminder notice.
 * @param {{
 *   appServer: {request: (method: string, params?: any) => Promise<any>},
 *   mailbox: ReturnType<import("../claude/mailbox.js").openMailbox>,
 *   now?: number,
 *   settings?: import("./message-status.js").ReminderSettings
 * }} options
 * @returns {Promise<{threadId: string, outcome: "sent" | "busy" | "not_loaded" | "claimed_elsewhere" | "failed", reminders?: number, error?: string}[]>}
 */
export async function deliverCodexReminders({ appServer, mailbox, now = Date.now(), settings = reminderSettings() }) {
  const open = mailbox.inspect({ limit: Number.MAX_SAFE_INTEGER })
    .filter((row) => row.to_session_kind === "codex");
  /** @type {Map<string, Record<string, any>[]>} */
  const byThread = new Map();
  for (const row of dueReminders(open, { now, settings })) {
    const threadId = String(row.to_session_id).replace(/^codex:/, "");
    if (!byThread.has(threadId)) byThread.set(threadId, []);
    byThread.get(threadId)?.push(row);
  }
  /** @type {{threadId: string, outcome: "sent" | "busy" | "not_loaded" | "claimed_elsewhere" | "failed", reminders?: number, error?: string}[]} */
  const results = [];
  for (const [threadId, rows] of byThread) {
    let status;
    try {
      const read = await appServer.request("thread/read", { threadId, includeTurns: false });
      status = read?.thread?.status?.type ?? null;
    } catch (error) {
      results.push({ threadId, outcome: "failed", error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (status === "notLoaded") {
      results.push({ threadId, outcome: "not_loaded" });
      continue;
    }
    if (status !== "idle") {
      results.push({ threadId, outcome: "busy" });
      continue;
    }
    const claimed = claimReminders(mailbox, rows, { via: REMINDER_VIA.codex, now, settings });
    const notice = reminderNoticeFor(claimed, { settings });
    if (!notice) {
      results.push({ threadId, outcome: "claimed_elsewhere" });
      continue;
    }
    try {
      await appServer.request("turn/start", {
        threadId,
        // Same shape as asUserTextInput (src/codex/app-server-client.js), not
        // imported so the hooks that load this module stay light.
        input: [{ type: "text", text: notice, text_elements: [] }],
        turnTrigger: CODEX_REMINDER_TURN_TRIGGER
      });
      results.push({ threadId, outcome: "sent", reminders: claimed.length });
    } catch (error) {
      // The reminders stay recorded (claim-before-notify): a failed push
      // counts against the cap rather than risking a duplicate.
      results.push({ threadId, outcome: "failed", reminders: claimed.length, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * The Stop hook's per-recipient gate (R7.14): at most one block per
 * interval per recipient, also across concurrent hook processes.
 *
 * Each block takes a `stop-<recipient>-<bucket>` claim (bucket = now /
 * interval) holding the clock reading. A block is allowed only when no
 * earlier block (claim or stop-hook `reminded` event) is within one
 * interval; two hooks that both claim neighbouring buckets resolve the tie
 * in favour of the lower bucket. `stop_hook_active` (the turn is already a
 * continuation forced by a Stop hook) is checked as a second guard.
 * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
 * @param {{recipientKey: string, open: Array<Record<string, any>>, now: number, settings: import("./message-status.js").ReminderSettings, stopHookActive?: boolean}} options
 * @returns {boolean} true when this hook may block now
 */
export function takeStopSlot(mb, { recipientKey, open, now, settings, stopHookActive = false }) {
  const prefix = `stop-${String(recipientKey).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120)}-`;
  /** @param {string} name */
  const blockTime = (name) => Number(mb.claimContent(name));
  const others = () => mb.listClaims()
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, bucket: Number(name.slice(prefix.length)), at: blockTime(name) }))
    .filter((c) => Number.isFinite(c.at) && Number.isFinite(c.bucket));
  const times = [...others().map((c) => c.at), lastStopBlockAt(open)].filter((t) => t !== null && Number.isFinite(t));
  const last = times.length ? Math.max(.../** @type {number[]} */ (times)) : null;
  const recent = last !== null && Math.abs(now - last) < settings.intervalMs;
  if (stopHookActive && recent) return false;
  if (recent) return false;
  const bucket = Math.floor(now / settings.intervalMs);
  const mine = `${prefix}${bucket}`;
  if (!mb.claim(mine, String(now))) return false;
  // A concurrent hook in a neighbouring bucket: the lower bucket blocks.
  return !others().some((c) => c.name !== mine && Math.abs(now - c.at) < settings.intervalMs && c.bucket < bucket);
}
