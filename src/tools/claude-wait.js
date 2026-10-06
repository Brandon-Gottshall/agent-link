// src/tools/claude-wait.js
//
// Standalone "wait for a Claude session" tool. Phase 6's
// message_claude_session already supports inline waitForReply=true; this
// tool gives callers a way to poll later — for example, after firing off
// a message and getting back {messageId, delivery, target}, the caller can
// invoke wait_for_claude_session to block until a reply arrives or the
// target session goes idle.
//
// Resolution semantics:
//   - "reply": A message with from_session_id == sessionId arrived. If
//     latestMessageId was provided, it must also have reply_to_message_id
//     == latestMessageId. Returns {result: "reply", message, sessionId}.
//   - "idle": The target session was loaded (running) at the start, and
//     a subsequent listSessions call shows it is no longer loaded. Useful
//     for "Claude finished its turn and the session is free." Returns
//     {result: "idle", target: {sessionId, lastLoaded: false}}.
//   - "timeout": Neither (reply) nor (idle) within timeoutMs (default
//     60000). Returns {result: "timeout", sessionId}.
//   - "not_found": Session id does not match any indexed session. Returns
//     {error: "not_found", sessionId} immediately, no polling.
import { openMailbox } from "../claude/mailbox.js";
import { listClaudeSessions } from "../claude/session-index.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export const claudeWaitTool = {
  name: "wait_for_claude_session",
  description:
    "Block until the target Claude Desktop or Claude Code session sends a reply (matching `latestMessageId` if provided) or " +
    "goes idle (was loaded, now isn't). Returns one of {result: 'reply', message} | {result: 'idle', target} | " +
    "{result: 'timeout'} | {error: 'not_found'}. Default timeout 60s. Use this when message_claude_session was " +
    "called without waitForReply, or to wait for any inbound message from a particular session.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Exact local_<uuid> sessionId of the session to wait on. Use resolve_claude_session first if you only have a fuzzy reference."
      },
      latestMessageId: {
        type: "string",
        description: "If set, only resolve when a message with reply_to_message_id == latestMessageId arrives. If absent, resolve on any message from the target session."
      },
      timeoutMs: {
        type: "number",
        description: "Polling timeout in milliseconds. Defaults to 60000."
      }
    },
    required: ["sessionId"],
    additionalProperties: false
  }
};

export function makeWaitHandler({ listSessions, mailboxOpener } = {}) {
  const sessionsFn = typeof listSessions === "function"
    ? listSessions
    : () => listClaudeSessions();
  const openMb = typeof mailboxOpener === "function"
    ? mailboxOpener
    : () => openMailbox();

  return {
    wait_for_claude_session: async (args = {}) => {
      const { sessionId, latestMessageId } = args;
      const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs >= 0
        ? args.timeoutMs
        : DEFAULT_TIMEOUT_MS;

      if (typeof sessionId !== "string" || !sessionId.trim()) {
        return { error: "invalid_arguments", message: "`sessionId` must be a non-empty string" };
      }

      const sessions0 = sessionsFn() ?? [];
      const target0 = sessions0.find((s) => s.sessionId === sessionId || s.cliSessionId === sessionId);
      if (!target0) {
        return { error: "not_found", sessionId };
      }

      const wasLoaded = !!target0.loaded;
      const deadline = Date.now() + timeoutMs;

      while (true) {
        // 1. Check the mailbox for an inbound message matching our criteria.
        //    Open/close per iteration so waits observe fresh append-only state
        //    and never hold a mailbox object across
        //    an await boundary.
        const mb = openMb();
        try {
          const filters = { fromSessionId: sessionId, limit: 5 };
          if (latestMessageId) {
            filters.replyToMessageId = latestMessageId;
          }
          const messages = mb.inspect(filters);
          if (messages.length > 0) {
            return {
              result: "reply",
              message: messages[0],
              sessionId
            };
          }
        } finally {
          mb.close();
        }

        // 2. Idle-transition check: only meaningful if the session was
        //    loaded when the wait started. If it has since dropped out of
        //    the loaded ps view, treat that as "Claude finished its turn".
        if (wasLoaded) {
          const sessionsNow = sessionsFn() ?? [];
          const targetNow = sessionsNow.find((s) => s.sessionId === sessionId || s.cliSessionId === sessionId);
          if (targetNow && !targetNow.loaded) {
            return {
              result: "idle",
              target: { sessionId, lastLoaded: false }
            };
          }
        }

        // 3. Sleep until the next poll, or break out on timeout.
        if (Date.now() >= deadline) {
          return { result: "timeout", sessionId };
        }
        const remaining = deadline - Date.now();
        await sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, Math.max(remaining, 10)));
      }
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
