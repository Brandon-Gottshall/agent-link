#!/usr/bin/env node
// src/claude/notify-hook.js
//
// Invoked by Claude Code's UserPromptSubmit and SessionStart hooks. Reads the
// hook stdin payload, looks up the local Claude session whose cliSessionId
// matches, COUNTS pending mailbox messages addressed to that
// session (does not drain), and emits the wrapped hookSpecificOutput
// notification on stdout if any are pending. The actual messages are returned
// by the read_agent_link_inbox MCP tool which the model is instructed to call.
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
// surface via the read_agent_link_inbox tool result.
//
// The script always exits 0 (Claude Code treats a non-zero exit from a
// blocking hook as a fatal error). Any failure is logged to stderr.
import fs from "node:fs";
import { openMailbox } from "./mailbox.js";
import { findSidecar } from "./desktop-registry.js";
import { findTranscriptSessionByCliId } from "./session-index.js";

async function main() {
  let payload;
  try {
    const stdin = await readAll(process.stdin);
    if (!stdin.trim()) {
      // No stdin payload — nothing to do.
      process.stdout.write("{}\n");
      return;
    }
    payload = JSON.parse(stdin);
  } catch (err) {
    process.stderr.write(`notify-hook: invalid JSON stdin: ${err.message}\n`);
    process.stdout.write("{}\n");
    return;
  }

  const cliSessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const hookEvent = typeof payload.hook_event_name === "string" ? payload.hook_event_name : null;
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : null;
  if (!cliSessionId || !hookEvent) {
    process.stderr.write("notify-hook: payload missing session_id or hook_event_name\n");
    process.stdout.write("{}\n");
    return;
  }

  let session;
  try {
    session = resolveSessionByCliId(cliSessionId, { transcriptPath });
  } catch (err) {
    process.stderr.write(`notify-hook: failed to load session registry: ${err.message}\n`);
    process.stdout.write("{}\n");
    return;
  }

  if (!session) {
    // Receiver has no sidecar yet (or this is a foreign session). No injection.
    process.stdout.write("{}\n");
    return;
  }

  let pending;
  try {
    const mb = openMailbox();
    try {
      pending = mb.listPendingFor({ toSessionId: session.sessionId });
    } finally {
      mb.close();
    }
  } catch (err) {
    process.stderr.write(`notify-hook: mailbox error: ${err.message}\n`);
    process.stdout.write("{}\n");
    return;
  }

  if (!pending || pending.length === 0) {
    process.stdout.write("{}\n");
    return;
  }

  const fromIds = [...new Set(pending.map((p) => p.from_session_id))];
  const fromList = fromIds.join(", ");
  const count = pending.length;
  const noun = count === 1 ? "message" : "messages";
  const ctx =
    `You have ${count} pending agent-link ${noun} from ${fromList}. ` +
    `Call the read_agent_link_inbox MCP tool now to view and process them. ` +
    `The tool result will appear in the visible transcript so the user can see the inbound messages. ` +
    `Do this BEFORE answering the user's prompt.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hookEvent,
        additionalContext: ctx
      }
    }) + "\n"
  );
}

// Find the session whose cliSessionId matches the live process. The notify
// hook fires on every UserPromptSubmit, so we short-circuit at the first
// match instead of materializing the full sidecar list.
function resolveSessionByCliId(cliSessionId, { transcriptPath } = {}) {
  const testRegistryPath = process.env.AGENT_LINK_TEST_REGISTRY;
  if (testRegistryPath) {
    // Test fixtures are small, expected to be array-shaped, and may include
    // entries unrelated to the host filesystem. Honor the array verbatim.
    const raw = fs.readFileSync(testRegistryPath, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [];
    return list.find((s) => s && s.cliSessionId === cliSessionId) ?? null;
  }
  const sidecar = findSidecar((s) => s.cliSessionId === cliSessionId);
  if (sidecar) return sidecar;
  // Transcript-only sessions (Claude Code inside Claude Desktop) have no
  // sidecar; resolve them from the hook's transcript_path so they still get
  // the pending-mail nudge. Returns null when no transcript proves the session
  // exists, preserving the no-injection-for-foreign-sessions behavior.
  return findTranscriptSessionByCliId(cliSessionId, { transcriptPath });
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

main().catch((err) => {
  process.stderr.write(`notify-hook: unhandled error: ${err.message}\n`);
  // Always succeed — non-zero exit would be treated as a fatal hook failure.
  try {
    process.stdout.write("{}\n");
  } catch {
    // ignore
  }
  process.exit(0);
});
