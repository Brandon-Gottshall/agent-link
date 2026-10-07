#!/usr/bin/env node
// src/claude/notify-hook.js
//
// Invoked by Claude Code's UserPromptSubmit and SessionStart hooks. Reads the
// hook stdin payload, looks up the local Claude session whose cliSessionId
// matches, COUNTS pending mailbox messages addressed to that
// session (does not drain), and emits the wrapped hookSpecificOutput
// notification on stdout if any are pending. The actual messages are returned
// by the read_agent_link_inbox MCP tool which the model is told to call.
//
// Phase 0 verified that:
//   - Stop does NOT accept additionalContext (hence this pivot).
//   - UserPromptSubmit + SessionStart DO accept additionalContext.
//   - The wrapped form `{hookSpecificOutput: {hookEventName, additionalContext}}`
//     is the form Claude Code actually injects into the model prompt.
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
import { createLogger } from "../shared/log.js";

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
export function runNotifyHook(payload, {
  resolveSession = resolveHookSession,
  findSidecarById = (id) => findSidecarSessionById(id),
  mailboxOpener = () => openMailbox(),
  log = logHookFailure
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

  let pending;
  try {
    const mb = mailboxOpener();
    try {
      pending = pendingForSession(mb, session, { cliSessionId, findSidecarById });
    } finally {
      mb.close();
    }
  } catch (err) {
    log(`notify-hook: mailbox error: ${err.message}\n`);
    return {};
  }
  if (!pending.length) return {};

  return {
    hookSpecificOutput: {
      hookEventName: hookEvent,
      additionalContext: renderNotice(pending)
    }
  };
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

// Pending mail for every id form of this session. A session resolved from
// its transcript alone does not know its Desktop sidecar id, so pending mail
// addressed to some other `local_` id is checked against that one sidecar
// file directly (no walk over every sidecar).
function pendingForSession(mb, session, { cliSessionId, findSidecarById }) {
  const aliases = new Set(claudeSessionAliases(session));
  const all = mb.inspect({ undelivered: true, limit: Number.MAX_SAFE_INTEGER });
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
  return all.filter((m) => isOurs(m.to_session_id)).sort((a, b) => a.sent_at - b.sent_at);
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
