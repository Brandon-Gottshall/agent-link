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
//     on an idle thread (R7.14). On by default since B7b
//     (AGENT_LINK_CODEX_REMINDERS=0 turns it off). A thread held by the Codex
//     desktop app (R1.12a, src/delivery/codex-push.js) never gets one.
//
// No reminder ever uses a channel push or turn/steer (R7.14). Every reminder
// is claimed before it is shown (claim-before-notify), so when several
// processes could show the same reminder exactly one does (R7.17).
import { envFlag } from "../shared/env.js";
import { renderReminderNotice } from "../shared/envelope.js";
import { isAnticipating, messageStatus, reminderSettings } from "./message-status.js";
import { addressNames, handedOverTo } from "./role-handover.js";
import { desktopPushPolicy, statusType } from "./codex-push.js";

export const REMINDER_VIA = Object.freeze({
  prompt: "claude-prompt-hook",
  stop: "claude-stop-hook",
  codex: "codex-turn",
  // The Codex UserPromptSubmit hook (R1.14), for threads the desktop app holds.
  codexPrompt: "codex-prompt-hook"
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
 * The recipient's open messages whose reminder is due now, minus any it
 * already answered the older way (a reply row without a resolution event).
 * Shared by the Claude prompt/Stop hook and the Codex prompt hook, so both
 * follow one reminder rule (section 7.5). Pure: rows in, rows out.
 * @param {Array<Record<string, any>>} all   every mailbox row (one read)
 * @param {Array<Record<string, any>>} mine  the rows the recipient receives now
 * @param {{recipientIds: Iterable<string>, now?: number, settings?: import("./message-status.js").ReminderSettings}} options
 */
export function dueUnanswered(all, mine, { recipientIds, now = Date.now(), settings = reminderSettings() }) {
  const open = mine.filter((m) => isAnticipating(m));
  if (!open.length) return [];
  const due0 = dueReminders(open, { now, settings });
  if (!due0.length) return [];
  // The replies are indexed once from the rows already read (one pass, not
  // one mailbox read per due message).
  const recipient = new Set(recipientIds);
  const repliedTo = new Map();
  for (const row of all) {
    if (!row.reply_to_message_id || !recipient.has(row.from_session_id)) continue;
    if (!repliedTo.has(row.reply_to_message_id)) repliedTo.set(row.reply_to_message_id, new Set());
    repliedTo.get(row.reply_to_message_id).add(row.to_session_id);
  }
  return due0.filter((m) => !repliedTo.get(m.id)?.has(m.from_session_id));
}

/**
 * Claims and records one reminder for each due row. Returns the rows this
 * caller claimed, with their reminder number. A row another process claimed
 * first is skipped, so its reminder is shown once.
 * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
 * @param {Array<Record<string, any>>} rows  due rows (dueReminders)
 * `to` names the recipient being reminded (recorded on the event; after a
 * role handover it is the role's new holder, R7.20).
 * @param {{via: string, to?: string | null, now?: number, settings?: import("./message-status.js").ReminderSettings}} options
 * @returns {{row: Record<string, any>, n: number}[]}
 */
export function claimReminders(mb, rows, { via, to = null, now = Date.now(), settings = reminderSettings() }) {
  /** @type {{row: Record<string, any>, n: number}[]} */
  const claimed = [];
  for (const row of rows) {
    const view = messageStatus(row, { now, settings });
    if (!view.due) continue;
    const n = view.reminders.count + 1;
    if (!mb.claim(`reminder-${row.id}-${n}`)) continue;
    mb.recordReminder({ messageId: row.id, n, via, to, at: now });
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
 * reminder on any of its messages), in epoch ms, or null. With
 * `recipientIds`, a reminder recorded for another recipient (`to`, before a
 * role handover moved the message) is not this recipient's block.
 * @param {Array<Record<string, any>>} rows  every message addressed to the recipient
 * @param {Iterable<string> | null} [recipientIds]
 */
export function lastStopBlockAt(rows, recipientIds = null) {
  const ids = recipientIds ? new Set(recipientIds) : null;
  let last = null;
  for (const row of rows) {
    for (const reminder of Array.isArray(row.reminders) ? row.reminders : []) {
      if (ids && typeof reminder?.to === "string" && !addressNames(reminder.to, ids)) continue;
      if (reminder?.via === REMINDER_VIA.stop && Number.isFinite(reminder.at)) {
        last = last === null ? reminder.at : Math.max(last, reminder.at);
      }
    }
  }
  return last;
}

/** Codex reminder turns (R7.14): on by default since B7b. */
export function codexRemindersEnabled(source = process.env) {
  return envFlag("AGENT_LINK_CODEX_REMINDERS", true, source);
}

/**
 * One pass of Codex reminder delivery (R7.14, Codex path). For each Codex
 * thread with due reminders: read the thread; only an idle thread gets a
 * reminder turn (an active turn is never steered; the reminder waits for the
 * turn to complete). A thread held by the Codex desktop app (R1.12a: in
 * mailbox-only mode, one not loaded in Agent Link's app-server) gets none and
 * relies on inbox pull; outside mailbox-only mode a thread that is not loaded
 * is resumed first. The turn's text is exactly the reminder notice.
 * @param {{
 *   appServer: {request: (method: string, params?: any) => Promise<any>},
 *   mailbox: ReturnType<import("../claude/mailbox.js").openMailbox>,
 *   now?: number,
 *   settings?: import("./message-status.js").ReminderSettings,
 *   roleTable?: import("../registry/roles.js").RoleTable | null,
 *   policy?: import("./codex-push.js").DesktopPushPolicy,
 *   preflight?: ReturnType<typeof import("./codex-push.js").makeBackgroundPreflight> | null
 * }} options
 *   preflight: the server's background check (src/delivery/codex-push.js
 *   makeBackgroundPreflight). With it, a thread gets a reminder turn only
 *   when the tracker last saw it idle in this endpoint AND a fresh
 *   thread/read shows it idle and not held AND its transcript is not open in
 *   another process, and at most one background turn goes to a thread per
 *   pass. Without it (one-off passes in tests) the status comes from
 *   thread/read alone.
 * @returns {Promise<{threadId: string, outcome: "sent" | "busy" | "held" | "not_known_idle" | "turn_sent_this_pass" | "claimed_elsewhere" | "failed", reminders?: number, error?: string}[]>}
 */
export async function deliverCodexReminders({ appServer, mailbox, now = Date.now(), settings = reminderSettings(), roleTable = null, policy = desktopPushPolicy(), preflight = null }) {
  /** @param {Record<string, any>} row */
  const codexRecipient = (row) => {
    const holder = handedOverTo(row, roleTable);
    if (holder) return holder.startsWith("codex:") ? holder.slice("codex:".length) : null;
    return row.to_session_kind === "codex" ? String(row.to_session_id).replace(/^codex:/, "") : null;
  };
  const open = mailbox.inspect({ limit: Number.MAX_SAFE_INTEGER })
    .filter((row) => codexRecipient(row) !== null);
  /** @type {Map<string, Record<string, any>[]>} */
  const byThread = new Map();
  for (const row of dueReminders(open, { now, settings })) {
    const threadId = /** @type {string} */ (codexRecipient(row));
    if (!byThread.has(threadId)) byThread.set(threadId, []);
    byThread.get(threadId)?.push(row);
  }
  /** @type {{threadId: string, outcome: "sent" | "busy" | "held" | "not_known_idle" | "turn_sent_this_pass" | "claimed_elsewhere" | "failed", reminders?: number, error?: string}[]} */
  const results = [];
  for (const [threadId, rows] of byThread) {
    let type;
    if (preflight) {
      const ready = /** @type {{ok: boolean, outcome?: any, error?: string}} */ (await preflight.check(threadId));
      if (!ready.ok) {
        results.push({ threadId, outcome: ready.outcome ?? "failed", ...(ready.error ? { error: ready.error } : {}) });
        continue;
      }
      type = "idle";
    } else {
      let status;
      try {
        status = (await appServer.request("thread/read", { threadId, includeTurns: false }))?.thread?.status ?? null;
      } catch (error) {
        results.push({ threadId, outcome: "failed", error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      // R1.12a: a held thread gets no turn at all, reminder turns included.
      if (policy.isHeld(status)) {
        results.push({ threadId, outcome: "held" });
        continue;
      }
      type = statusType(status);
      if (type !== "idle" && type !== "notLoaded") {
        results.push({ threadId, outcome: "busy" });
        continue;
      }
    }
    const claimed = claimReminders(mailbox, rows, { via: REMINDER_VIA.codex, to: `codex:${threadId}`, now, settings });
    const notice = reminderNoticeFor(claimed, { settings });
    if (!notice) {
      results.push({ threadId, outcome: "claimed_elsewhere" });
      continue;
    }
    try {
      if (type === "notLoaded") {
        await appServer.request("thread/resume", { threadId, excludeTurns: true, persistExtendedHistory: true });
      }
      const response = await appServer.request("turn/start", {
        threadId,
        // Same shape as asUserTextInput (src/codex/app-server-client.js), not
        // imported so the hooks that load this module stay light.
        input: [{ type: "text", text: notice, text_elements: [] }],
        turnTrigger: CODEX_REMINDER_TURN_TRIGGER
      });
      // The thread is busy now: nothing else starts a turn there this pass.
      preflight?.markSent(threadId, response?.turn?.id ?? null);
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
 * earlier block (a slot claim or a stop-hook `reminded` event) is within
 * one interval; two hooks that both claim neighbouring buckets resolve the
 * tie in favour of the lower bucket.
 *
 * `stop_hook_active` means this turn is already a continuation forced by a
 * Stop hook. It is the second guard: such a turn is never blocked when the
 * forcing block cannot be found (a slot claim lost or collected, or another
 * hook's block), so a forced continuation is blocked again only when this
 * recipient's last recorded block is a full interval old.
 * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
 * @param {{recipientKey: string, recipientIds?: Iterable<string> | null, open: Array<Record<string, any>>, now: number, settings: import("./message-status.js").ReminderSettings, stopHookActive?: boolean}} options
 * @returns {boolean} true when this hook may block now
 */
export function takeStopSlot(mb, { recipientKey, recipientIds = null, open, now, settings, stopHookActive = false }) {
  const prefix = `stop-${String(recipientKey).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120)}-`;
  /** @param {string} name */
  const blockTime = (name) => Number(mb.claimContent(name));
  const others = () => mb.listClaims()
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, bucket: Number(name.slice(prefix.length)), at: blockTime(name) }))
    .filter((c) => Number.isFinite(c.at) && Number.isFinite(c.bucket));
  const times = [...others().map((c) => c.at), lastStopBlockAt(open, recipientIds)].filter((t) => t !== null && Number.isFinite(t));
  const last = times.length ? Math.max(.../** @type {number[]} */ (times)) : null;
  if (last !== null && Math.abs(now - last) < settings.intervalMs) return false;
  if (stopHookActive && last === null) return false;
  const bucket = Math.floor(now / settings.intervalMs);
  const mine = `${prefix}${bucket}`;
  if (!mb.claim(mine, String(now))) return false;
  // A concurrent hook in a neighbouring bucket: the lower bucket blocks.
  return !others().some((c) => c.name !== mine && Math.abs(now - c.at) < settings.intervalMs && c.bucket < bucket);
}
