#!/usr/bin/env node
// src/claude/notify-hook.js
//
// Invoked by Claude Code's UserPromptSubmit, SessionStart and Stop hooks.
// Reads the hook stdin payload and looks up the local Claude session whose
// cliSessionId matches.
//
// UserPromptSubmit / SessionStart: COUNTS pending mailbox messages addressed
// to that session (does not drain) and emits the wrapped hookSpecificOutput
// notification on stdout if any are pending. On UserPromptSubmit it also
// adds the reminder notice (design R7.15) for open anticipating messages
// whose reminder is due. The actual messages are returned by the
// read_agent_link_inbox MCP tool which the model is told to call.
//
// Stop (design R7.14): when a reminder is due as the turn ends, returns
// `{"decision": "block", "reason": <reminder notice>}` so the agent sees it
// before stopping. It blocks at most once per reminder interval per
// recipient, and never when nothing is due, so a turn can always end.
// Protocol (Claude Code hooks reference): Stop takes top-level `decision`
// and `reason`; exit 0 with JSON on stdout; plain-text stdout would be added
// as context, so the hook always prints a JSON object.
//
// The wrapped form `{hookSpecificOutput: {hookEventName, additionalContext}}`
// is the form Claude Code injects into the model prompt for UserPromptSubmit
// and SessionStart.
//
// IMPORTANT: this hook MUST NOT include the message body in the notification —
// additionalContext is hidden from the user, so leaking the body here would
// hide the inbound message from the visible transcript. The body must only
// surface via the read_agent_link_inbox tool result. Sender ids are
// validated before they are rendered, and the wording marks the mail as
// untrusted content from another agent, never as the user's instructions.
//
// The script always exits 0 (Claude Code treats a non-zero exit from a
// blocking hook as a fatal error). Any failure is logged to stderr.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openMailbox } from "./mailbox.js";
import {
  findClaudeSessionById,
  findSidecarSessionById,
  findTranscriptSessionByCliId
} from "./session-index.js";
import { claudeSessionAliases } from "./identity.js";
import { renderHookNotice } from "../shared/envelope.js";
import { isAnticipating, reminderSettings } from "../delivery/message-status.js";
import { REMINDER_VIA, claimReminders, dueReminders, reminderNoticeFor, takeStopSlot } from "../delivery/reminders.js";
import { createLogger } from "../shared/log.js";
import { createRoleStore } from "../registry/roles.js";
import { addressNames, handedOverTo, isPendingFor, readRoleTable } from "../delivery/role-handover.js";

// Hook failures go to stderr (Claude Code shows it in its hook log) and, when
// the Agent Link log file is on (AGENT_LINK_DEBUG or AGENT_LINK_LOG_FILE), to
// that file too. The file logger is created on first failure with stderr
// muted, so a line is never printed twice.
let hookFileLogger = null;
function logHookFailure(line) {
  try {
    process.stderr.write(line);
  } catch {
    // stderr closed
  }
  try {
    hookFileLogger ??= createLogger({ stderr: { write: () => true } });
    hookFileLogger.warn("notify_hook.failure", { message: String(line).trim() });
  } catch {
    // logging must never fail the hook
  }
}

// Pure entry point: payload in, hook output object out. Tests inject
// `resolveSession`, `findSidecarById` and `mailboxOpener` instead of the
// production code reading any test-only environment variable.
/**
 * @param {any} payload
 * @param {{
 *   resolveSession?: (cliSessionId: string, options: {transcriptPath?: string | null}) => any,
 *   findSidecarById?: (id: string) => any,
 *   mailboxOpener?: () => any,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   settings?: import("../delivery/message-status.js").ReminderSettings,
 *   roleTable?: () => import("../registry/roles.js").RoleTable | null
 * }} [options]
 */
export function runNotifyHook(payload, {
  resolveSession = resolveHookSession,
  findSidecarById = (id) => findSidecarSessionById(id),
  mailboxOpener = () => openMailbox(),
  log = logHookFailure,
  now = () => Date.now(),
  settings = undefined,
  roleTable = () => readRoleTable(createRoleStore())
} = {}) {
  const cliSessionId = typeof payload?.session_id === "string" ? payload.session_id : null;
  const hookEvent = typeof payload?.hook_event_name === "string" ? payload.hook_event_name : null;
  const transcriptPath = typeof payload?.transcript_path === "string" ? payload.transcript_path : null;
  if (!cliSessionId || !hookEvent) {
    log("notify-hook: payload missing session_id or hook_event_name\n");
    return {};
  }

  let session;
  try {
    session = resolveSession(cliSessionId, { transcriptPath });
  } catch (err) {
    log(`notify-hook: failed to load session registry: ${err.message}\n`);
    return {};
  }
  // Receiver is unknown (or this is a foreign session): no injection.
  if (!session) return {};

  const isStop = hookEvent === "Stop";
  const remind = isStop || hookEvent === "UserPromptSubmit";
  let pending = [];
  let reminder = null;
  try {
    const reminderConfig = settings ?? reminderSettings();
    const at = now();
    const mb = mailboxOpener();
    try {
      // One mailbox read per hook run: every later step filters this list.
      const all = mb.inspect({ limit: Number.MAX_SAFE_INTEGER });
      // A role-addressed message handed over to the role's new holder
      // (R7.20) is the new holder's, read from the current role table.
      const table = roleTable();
      const mine = mailForSession(all, session, { cliSessionId, findSidecarById, table });
      // A message handed over to this session is new to it (R7.20) until it
      // is delivered here, whatever the previous holder saw.
      const ids = new Set([...claudeSessionAliases(session), cliSessionId, `claude:${cliSessionId}`]);
      if (!isStop) pending = mine.filter((m) => isPendingFor(m, table, ids));
      if (remind) {
        reminder = remindersFor(mb, all, mine, {
          isStop,
          now: at,
          settings: reminderConfig,
          recipientIds: [...claudeSessionAliases(session), cliSessionId],
          recipientKey: cliSessionId,
          recipientAddress: `claude:${cliSessionId}`,
          stopHookActive: payload?.stop_hook_active === true
        });
      }
    } finally {
      mb.close();
    }
  } catch (err) {
    log(`notify-hook: mailbox error: ${err.message}\n`);
    return {};
  }

  if (isStop) {
    // Never block without something due: a turn can always end.
    return reminder ? { decision: "block", reason: reminder } : {};
  }
  const parts = [];
  if (pending.length) parts.push(renderNotice(pending));
  if (reminder) parts.push(reminder);
  if (!parts.length) return {};
  return {
    hookSpecificOutput: {
      hookEventName: hookEvent,
      additionalContext: parts.join("\n")
    }
  };
}

// The reminder notice for this session's due reminders, claimed and
// recorded, or null. The Stop hook blocks at most once per interval per
// recipient however many messages are due (R7.14).
function remindersFor(mb, all, mine, { isStop, now, settings, recipientIds, recipientKey, recipientAddress, stopHookActive }) {
  const open = mine.filter((m) => isAnticipating(m));
  if (!open.length) return null;
  const due0 = dueReminders(open, { now, settings });
  if (!due0.length) return null;
  // A message the recipient already answered the older way (a reply row
  // without a resolution event) is not open any more: no reminder. The
  // replies are indexed once from the rows already read (one pass, not one
  // mailbox read per due message).
  const recipient = new Set(recipientIds);
  const repliedTo = new Map();
  for (const row of all) {
    if (!row.reply_to_message_id || !recipient.has(row.from_session_id)) continue;
    if (!repliedTo.has(row.reply_to_message_id)) repliedTo.set(row.reply_to_message_id, new Set());
    repliedTo.get(row.reply_to_message_id).add(row.to_session_id);
  }
  const due = due0.filter((m) => !repliedTo.get(m.id)?.has(m.from_session_id));
  if (!due.length) return null;
  if (isStop && !takeStopSlot(mb, { recipientKey, recipientIds, open, now, settings, stopHookActive })) return null;
  const claimed = claimReminders(mb, due, {
    via: isStop ? REMINDER_VIA.stop : REMINDER_VIA.prompt,
    to: recipientAddress,
    now,
    settings
  });
  return reminderNoticeFor(claimed, { settings });
}

// The section 2.4 notice: count and at most 3 validated sender ids, never a
// body. Shared with every host's hook through src/shared/envelope.js.
export function renderNotice(pending) {
  return renderHookNotice(pending);
}

// Resolve the receiving session as cheaply as possible:
//   1. the payload's transcript_path, when it names this session (O(1));
//   2. a sidecar whose cliSessionId matches, then a transcript scan.
/**
 * @param {string} cliSessionId
 * @param {{transcriptPath?: string, desktopRoot?: string, codeRoot?: string, projectsRoot?: string}} [options]
 */
export function resolveHookSession(cliSessionId, { transcriptPath, ...roots } = {}) {
  if (transcriptPath && path.basename(transcriptPath, ".jsonl") === cliSessionId) {
    const session = findTranscriptSessionByCliId(cliSessionId, { transcriptPath, projectsRoot: roots.projectsRoot });
    if (session) return session;
  }
  return findClaudeSessionById(cliSessionId, roots);
}

// Mail for every id form of this session, oldest first. A session resolved
// from its transcript alone does not know its Desktop sidecar id, so mail
// addressed to some other `local_` id is checked against that one sidecar
// file directly (no walk over every sidecar). A message handed over through a
// role (R7.20) belongs to the role's current holder instead.
function mailForSession(all, session, { cliSessionId, findSidecarById, table = null }) {
  const aliases = new Set(claudeSessionAliases(session));
  const holderIds = new Set([...aliases, cliSessionId, `claude:${cliSessionId}`]);
  const checked = new Map();
  const isOurs = (toId) => {
    if (aliases.has(toId)) return true;
    if (session.sourceSidecar || !toId.startsWith("local_")) return false;
    if (!checked.has(toId)) {
      let match = false;
      try {
        const sidecar = findSidecarById(toId);
        match = Boolean(sidecar) && claudeSessionAliases(sidecar).includes(cliSessionId);
      } catch {
        match = false;
      }
      checked.set(toId, match);
    }
    return checked.get(toId);
  };
  return all.filter((m) => {
    const holder = handedOverTo(m, table);
    return holder ? addressNames(holder, holderIds) : isOurs(m.to_session_id);
  }).sort((a, b) => a.sent_at - b.sent_at);
}

async function main() {
  let payload;
  try {
    const stdin = await readAll(process.stdin);
    if (!stdin.trim()) {
      process.stdout.write("{}\n");
      return;
    }
    payload = JSON.parse(stdin);
  } catch (err) {
    logHookFailure(`notify-hook: invalid JSON stdin: ${err.message}\n`);
    process.stdout.write("{}\n");
    return;
  }
  process.stdout.write(JSON.stringify(runNotifyHook(payload)) + "\n");
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

function invokedDirectly() {
  try {
    if (!process.argv[1]) return false;
    // Compare real paths: the plugin root may be reached through a symlink.
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    logHookFailure(`notify-hook: unhandled error: ${err.message}\n`);
    // Always succeed — non-zero exit would be treated as a fatal hook failure.
    try {
      process.stdout.write("{}\n");
    } catch {
      // stdout is gone (the hook runner closed the pipe); nothing is left to
      // report to, and the exit code must stay 0.
    }
    process.exit(0);
  });
}
