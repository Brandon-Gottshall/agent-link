#!/usr/bin/env node
// src/codex/prompt-hook.js
//
// Codex UserPromptSubmit hook (design R1.14). Threads the Codex desktop app
// holds get mail by inbox only (R1.12a): Agent Link never pushes a turn into
// them. When the user types a prompt in such a thread, this hook adds a short
// hidden notice so the model calls read_agent_link_inbox:
//
//   - new mail for codex:<threadId>: the section 2.4 notice, on every prompt
//     until the inbox is read (nothing is marked delivered here);
//   - delivered reply/action mail still open: the R7.15 reminder notice,
//     under the same rule as the Claude hooks (section 7.5): at most once
//     per interval, up to the cap, recorded as a claimed `reminded` event
//     (via codex-prompt-hook, to codex:<threadId>). After the cap the
//     message turns `unresolved` for the sender and the notice stops.
//
// Mail is selected as read_agent_link_inbox selects it, role handover
// included (R7.20), from one read of the mailbox. The hook cannot see an
// in-process wait in an MCP server, so it may count a reply that a running
// wait is holding (the inbox would not show it).
//
// Codex hook contract (verified against codex-cli 0.159.2, see
// docs/design/host-neutral-agent-link.md R1.14a): stdin is
//   {session_id: <threadId>, turn_id, transcript_path, cwd,
//    hook_event_name: "UserPromptSubmit", model, permission_mode, prompt}
// and stdout `{hookSpecificOutput: {hookEventName: "UserPromptSubmit",
// additionalContext}}` reaches the model as context. Empty stdout adds
// nothing. Exit 2 would block the prompt, so this hook never uses it.
//
// Rules:
//   - It writes only reminder claims and events, and only when a reminder
//     is due (so a mailbox already exists): with no mail it creates nothing.
//   - It never talks to the app-server.
//   - It never includes a message body; senders are validated addresses.
//   - Any failure prints nothing and exits 0, so a broken install never
//     breaks the user's prompt. The hooks file also maps every exit to 0.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openMailbox, readMailboxRows } from "../claude/mailbox.js";
import { reminderSettings } from "../delivery/message-status.js";
import { REMINDER_VIA, claimReminders, dueUnanswered, reminderNoticeFor } from "../delivery/reminders.js";
import { handedOverTo, readRoleTable, recipientView } from "../delivery/role-handover.js";
import { createRoleStore } from "../registry/roles.js";
import { renderHookNotice } from "../shared/envelope.js";
import { parseAddress } from "../shared/identity.js";

export const PROMPT_EVENT = "UserPromptSubmit";

/**
 * The Codex thread a hook payload belongs to, or null. `session_id` is the
 * thread id (verified live: it equals the app-server threadId).
 * @param {any} payload
 * @returns {{threadId: string, address: string} | null}
 */
export function threadFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.hook_event_name !== PROMPT_EVENT) return null;
  const raw = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  if (!raw || raw.includes(":")) return null;
  const parsed = parseAddress(`codex:${raw}`);
  if (!parsed || parsed.harness !== "codex") return null;
  return { threadId: parsed.id, address: parsed.address };
}

/**
 * Entry point: payload in, hook output object (or null for no output).
 * Writes only through `mailboxOpener`, and only to claim due reminders.
 * @param {any} payload
 * @param {{
 *   readRows?: () => Array<Record<string, any>>,
 *   mailboxOpener?: () => ReturnType<typeof openMailbox>,
 *   roleTable?: () => import("../registry/roles.js").RoleTable | null,
 *   now?: () => number,
 *   settings?: import("../delivery/message-status.js").ReminderSettings
 * }} [options]
 * @returns {{hookSpecificOutput: {hookEventName: string, additionalContext: string}} | null}
 */
export function runCodexPromptHook(payload, {
  readRows = () => readMailboxRows(),
  mailboxOpener = () => openMailbox(),
  roleTable = () => readRoleTable(createRoleStore()),
  now = () => Date.now(),
  settings = undefined
} = {}) {
  const thread = threadFromPayload(payload);
  if (!thread) return null;
  // One mailbox read: every later step filters this list.
  const all = readRows();
  if (!all.length) return null;
  const table = roleTable();
  const inbox = recipientView({ aliases: [thread.threadId], address: thread.address, table });
  // Only Codex mail: a row stored for a Claude session counts only when a
  // role handed it over to this thread (a payload naming a Claude session id
  // must not surface or remind that session's mail).
  const isCodexMail = (/** @type {Record<string, any>} */ row) =>
    row.to_session_kind !== "claude" || handedOverTo(row, table) === thread.address;
  const mine = all.filter((row) => inbox.isRecipient(row) && isCodexMail(row)).sort((a, b) => a.sent_at - b.sent_at);
  if (!mine.length) return null;
  const pending = mine.filter((row) => inbox.isPending(row));
  const at = now();
  const config = settings ?? reminderSettings();
  // Reminders (section 7.5), as the Claude UserPromptSubmit hook does them.
  // Only due rows are claimed; the writable mailbox is opened only then.
  const due = dueUnanswered(all, mine, { recipientIds: [thread.threadId, thread.address], now: at, settings: config });
  let reminder = null;
  if (due.length) {
    const mb = mailboxOpener();
    try {
      const claimed = claimReminders(mb, due, { via: REMINDER_VIA.codexPrompt, to: thread.address, now: at, settings: config });
      reminder = reminderNoticeFor(claimed, { settings: config });
    } finally {
      mb.close();
    }
  }
  const parts = [];
  if (pending.length) parts.push(renderHookNotice(pending));
  if (reminder) parts.push(reminder);
  if (!parts.length) return null;
  return { hookSpecificOutput: { hookEventName: PROMPT_EVENT, additionalContext: parts.join("\n") } };
}

/**
 * Hook process body: stdin text in, stdout text out ("" for nothing). Never
 * throws.
 * @param {string} stdin
 * @param {Parameters<typeof runCodexPromptHook>[1]} [options]
 */
export function promptHookOutput(stdin, options) {
  try {
    if (!stdin.trim()) return "";
    const out = runCodexPromptHook(JSON.parse(stdin), options);
    return out ? `${JSON.stringify(out)}\n` : "";
  } catch {
    return "";
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
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
  readStdin()
    .then((stdin) => {
      const text = promptHookOutput(stdin);
      if (text) process.stdout.write(text);
    })
    .catch(() => {})
    .finally(() => {
      process.exitCode = 0;
    });
}
