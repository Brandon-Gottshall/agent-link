#!/usr/bin/env node
// src/codex/prompt-hook.js
//
// Codex UserPromptSubmit hook (design R1.14). Threads the Codex desktop app
// holds get mail by inbox only (R1.12a): Agent Link never pushes a turn into
// them. When the user types a prompt in such a thread, this hook adds a short
// hidden notice (section 2.4) so the model calls read_agent_link_inbox:
//
//   - new mail for codex:<threadId> (the section 2.4 pending notice), and
//   - delivered reply/action mail it still has to resolve (the open notice).
//
// It selects rows exactly as read_agent_link_inbox does, role handover
// included (R7.20), from one read of the mailbox.
//
// Codex hook contract (verified against codex-cli 0.159.2, see
// docs/design/host-neutral-agent-link.md R1.14): stdin is
//   {session_id: <threadId>, turn_id, transcript_path, cwd,
//    hook_event_name: "UserPromptSubmit", model, permission_mode, prompt}
// and stdout `{hookSpecificOutput: {hookEventName: "UserPromptSubmit",
// additionalContext}}` reaches the model as context. Empty stdout adds
// nothing. Exit 2 would block the prompt, so this hook never uses it.
//
// Rules:
//   - It never writes: no delivery mark (the notice repeats until the inbox
//     is read, like the Claude hook), no reminder claim, no state directory.
//   - It never talks to the app-server.
//   - It never includes a message body; senders are validated addresses.
//   - Any failure prints nothing and exits 0, so a broken install never
//     breaks the user's prompt. The hooks file also maps every exit to 0.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readMailboxRows } from "../claude/mailbox.js";
import { isOpenMailFor } from "../delivery/inbox-view.js";
import { reminderSettings } from "../delivery/message-status.js";
import { readRoleTable, recipientView } from "../delivery/role-handover.js";
import { createRoleStore } from "../registry/roles.js";
import { renderHookNotice, renderOpenNotice } from "../shared/envelope.js";
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
 * Pure entry point: payload in, hook output object (or null for no output).
 * @param {any} payload
 * @param {{
 *   readRows?: () => Array<Record<string, any>>,
 *   roleTable?: () => import("../registry/roles.js").RoleTable | null,
 *   now?: () => number,
 *   settings?: import("../delivery/message-status.js").ReminderSettings
 * }} [options]
 * @returns {{hookSpecificOutput: {hookEventName: string, additionalContext: string}} | null}
 */
export function runCodexPromptHook(payload, {
  readRows = () => readMailboxRows(),
  roleTable = () => readRoleTable(createRoleStore()),
  now = () => Date.now(),
  settings = undefined
} = {}) {
  const thread = threadFromPayload(payload);
  if (!thread) return null;
  // One mailbox read: every later step filters this list.
  const all = readRows();
  if (!all.length) return null;
  const inbox = recipientView({ aliases: [thread.threadId], address: thread.address, table: roleTable() });
  const at = now();
  const config = settings ?? reminderSettings();
  const pending = [];
  const open = [];
  for (const row of all) {
    if (!inbox.isRecipient(row)) continue;
    if (inbox.isPending(row)) pending.push(row);
    else if (isOpenMailFor(row, inbox, at, config)) open.push(row);
  }
  const parts = [];
  if (pending.length) parts.push(renderHookNotice(pending.sort((a, b) => a.sent_at - b.sent_at)));
  if (open.length) parts.push(renderOpenNotice(open.sort((a, b) => a.sent_at - b.sent_at)));
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
