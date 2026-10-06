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
//   - "reply": A message from the target session (any of its id forms) that
//     is addressed to the caller (any of its id forms). If latestMessageId
//     was provided, it must also have reply_to_message_id == latestMessageId
//     (and may predate the wait). Without latestMessageId, only messages sent
//     since the wait started count, so an old message never resolves a new
//     wait. The returned message is marked delivered and acknowledged, so
//     the caller's inbox, hook and channel do not deliver it again.
//     Returns {result: "reply", message, sessionId}.
//   - "idle": The target session was loaded (running) at the start, and a
//     later liveness check shows it is no longer loaded. Liveness is checked
//     for that one session only, at most every 2 s. Returns
//     {result: "idle", target: {sessionId, lastLoaded: false}}.
//   - "timeout": Neither (reply) nor (idle) within timeoutMs (default
//     60000). Returns {result: "timeout", sessionId}.
//   - "not_found": Session id does not match any indexed session, archived
//     sessions included. Returns {error: "not_found", sessionId} immediately,
//     no polling.
import { openMailbox } from "../claude/mailbox.js";
import { isClaudeSessionLoaded, listClaudeSessions } from "../claude/session-index.js";
import { claudeSessionAliases, claudeSessionMatches, resolveCallerIdentity } from "../claude/identity.js";
import { consumeReply } from "./claude-send.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_LIVENESS_INTERVAL_MS = 2_000;

export const claudeWaitTool = {
  name: "wait_for_claude_session",
  description:
    "Block until the target Claude Desktop or Claude Code session sends a message addressed to the caller, or goes idle " +
    "(was loaded, now isn't). With `latestMessageId` (recommended: pass the messageId message_claude_session returned), " +
    "only a reply to that message counts, even one that arrived before the wait started. Without it, only messages sent " +
    "after the wait started count. A reply returned by this tool counts as delivered, so it is not shown again by " +
    "read_agent_link_inbox or the channel. Returns one of {result: 'reply', message} | {result: 'idle', target} | " +
    "{result: 'timeout'} | {error: 'not_found'}. Default timeout 60s. Use this when message_claude_session was " +
    "called without waitForReply.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Exact sessionId (local_<uuid>) or cliSessionId of the session to wait on; archived sessions are included. Use resolve_claude_session first if you only have a fuzzy reference."
      },
      latestMessageId: {
        type: "string",
        description: "Recommended. Only resolve on a reply (reply_to_message_id == latestMessageId) from the target addressed to the caller; a reply that arrived before the wait started also counts. If absent, resolve on any message from the target addressed to the caller and sent after the wait started."
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

export function makeWaitHandler({
  host,
  listSessions,
  listOptions = {},
  mailboxOpener,
  resolveCurrentSession = null,
  isSessionLoaded,
  livenessIntervalMs = DEFAULT_LIVENESS_INTERVAL_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  now = () => Date.now()
} = {}) {
  const sessionsFn = typeof listSessions === "function"
    ? listSessions
    : () => listClaudeSessions({ ...listOptions, includeArchived: true });
  const openMb = typeof mailboxOpener === "function"
    ? mailboxOpener
    : () => openMailbox();
  const loadedFn = typeof isSessionLoaded === "function"
    ? isSessionLoaded
    : (session) => isClaudeSessionLoaded(session.cliSessionId);

  return {
    wait_for_claude_session: async (args = {}, toolContext = {}) => {
      const { sessionId, latestMessageId } = args;
      const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs >= 0
        ? args.timeoutMs
        : DEFAULT_TIMEOUT_MS;

      if (typeof sessionId !== "string" || !sessionId.trim()) {
        return { error: "invalid_arguments", message: "`sessionId` must be a non-empty string" };
      }

      const waitStartedAt = now();
      // One listing to find the target and its starting loaded state.
      const sessions0 = sessionsFn() ?? [];
      const target0 = sessions0.find((s) => claudeSessionMatches(s, sessionId));
      if (!target0) {
        return { error: "not_found", sessionId };
      }

      const fromIds = claudeSessionAliases(target0);
      const caller = resolveCallerIdentity({
        host,
        runtimeCallerContext: toolContext.runtimeCallerContext ?? null,
        currentSession: resolveCurrentSession
      });
      const wasLoaded = !!target0.loaded;
      const deadline = waitStartedAt + timeoutMs;
      let nextLivenessCheckAt = waitStartedAt + livenessIntervalMs;

      while (true) {
        // 1. Check the mailbox for an inbound message matching our criteria.
        //    Open/close per iteration so waits observe fresh append-only state
        //    and never hold a mailbox object across an await boundary.
        const mb = openMb();
        try {
          const filters = {
            fromSessionIds: fromIds,
            toSessionIds: caller.aliases,
            limit: Number.MAX_SAFE_INTEGER
          };
          if (latestMessageId) {
            filters.replyToMessageId = latestMessageId;
          } else {
            filters.since = waitStartedAt;
          }
          const messages = mb.inspect(filters).sort((a, b) => a.sent_at - b.sent_at);
          if (messages.length > 0) {
            // A reply consumed by a wait counts as delivered (and
            // acknowledged); the caller's inbox and channel skip it.
            consumeReply(mb, messages[0]);
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
        //    loaded when the wait started. Check that one session's process,
        //    and no more often than livenessIntervalMs.
        if (wasLoaded && now() >= nextLivenessCheckAt) {
          nextLivenessCheckAt = now() + livenessIntervalMs;
          if (!loadedFn(target0)) {
            return {
              result: "idle",
              target: { sessionId, lastLoaded: false }
            };
          }
        }

        // 3. Sleep until the next poll, or break out on timeout.
        if (now() >= deadline) {
          return { result: "timeout", sessionId };
        }
        const remaining = deadline - now();
        await sleep(Math.min(pollIntervalMs, Math.max(remaining, 10)));
      }
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
