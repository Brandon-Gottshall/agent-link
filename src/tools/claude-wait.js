// src/tools/claude-wait.js
//
// Standalone "wait for a Claude session" tool. Phase 6's
// message_claude_session already supports inline waitForReply=true; this
// tool gives callers a way to poll later — for example, after firing off
// a message and getting back {messageId, delivery, target}, the caller can
// invoke wait_for_claude_session to block until a reply arrives or the
// target session goes idle.
//
// Resolution semantics (the result is the design doc section 3.4 shape,
// {outcome, waitedMs, target, reply?}; result/message/sessionId are the 0.4
// keys, kept until 0.6.0):
//   - "reply": A message from the target session (any of its id forms) that
//     is addressed to the caller (any of its id forms). With replyToMessageId
//     (deprecated alias latestMessageId) it must be a reply to that message
//     (and may predate the wait). Without it, only messages sent since the
//     wait started count, so an old message never resolves a new wait. The
//     returned message is marked delivered and acknowledged, so the caller's
//     inbox, hook and channel do not deliver it again.
//   - "idle": The target session was loaded (running) at the start, and a
//     later liveness check shows it is no longer loaded. Liveness is checked
//     for that one session only, at most every 2 s.
//   - "timeout": Neither within timeoutMs (default 60000). ok:true.
//   - An unknown session id (archived sessions included) is a not_found
//     error, thrown immediately with no polling.
import { openMailbox } from "../claude/mailbox.js";
import { isClaudeSessionLoaded, listClaudeSessions } from "../claude/session-index.js";
import { claudeSessionAliases, claudeSessionMatches, resolveCallerIdentity } from "../claude/identity.js";
import { registerActiveWait } from "../claude/active-waits.js";
import { peerMessageFromMailbox, peerMessageResult } from "../shared/envelope.js";
import { consumeReply } from "./claude-send.js";
import { AgentLinkError } from "../shared/errors.js";
import { applyAliases } from "../server/registry.js";
import { LIMITS, enumOf, out, str, timeoutMs as timeoutMsSchema } from "../server/schemas.js";

const DEFAULT_TIMEOUT_MS = LIMITS.timeoutMs.def;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_LIVENESS_INTERVAL_MS = 2_000;

/** @type {import("../server/registry.js").ToolDefinition} */
export const claudeWaitTool = {
  name: "wait_for_claude_session",
  description:
    "Block until the target Claude Desktop or Claude Code session sends a message addressed to the caller, or goes idle " +
    "(was loaded, now isn't). With `replyToMessageId` (recommended: pass the messageId message_claude_session returned), " +
    "only a reply to that message counts, even one that arrived before the wait started. Without it, only messages sent " +
    "after the wait started count. A reply returned by this tool counts as delivered, so it is not shown again by " +
    "read_agent_link_inbox or the channel. Returns {outcome: 'reply' | 'idle' | 'timeout', waitedMs, target, reply?}; " +
    "a timeout is ok:true, not an error. An unknown session is a not_found error. Use this when message_claude_session was " +
    "called without waitForReply.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: str("Exact sessionId (local_<uuid>) or cliSessionId of the session to wait on; archived sessions are included. Use resolve_claude_session first if you only have a fuzzy reference."),
      replyToMessageId: str("Recommended. Only resolve on a reply to this message from the target addressed to the caller; a reply that arrived before the wait started also counts. If absent, resolve on any message from the target addressed to the caller and sent after the wait started."),
      timeoutMs: timeoutMsSchema("Polling timeout in milliseconds.")
    },
    required: ["sessionId"],
    additionalProperties: false
  },
  aliases: [{ canonical: "replyToMessageId", aliases: ["latestMessageId"] }],
  output: {
    outcome: enumOf(["reply", "idle", "timeout"], "How the wait ended (section 3.4)."),
    waitedMs: out("integer", "How long the wait lasted."),
    target: out("object", "{sessionId, lastLoaded?} of the session waited on."),
    reply: out("object", "outcome reply: the message's validated fields plus its envelope."),
    result: out("string", "Deprecated duplicate of outcome; removed in 0.6.0."),
    message: out("object", "Deprecated duplicate of reply; removed in 0.6.0."),
    sessionId: out("string", "Deprecated duplicate of target.sessionId; removed in 0.6.0.")
  },
  annotations: { readOnlyHint: true }
};

/**
 * @typedef {object} ClaudeWaitDeps
 * @property {string} [host]
 * @property {() => any[]} [listSessions]
 * @property {Record<string, unknown>} [listOptions]
 * @property {() => any} [mailboxOpener]
 * @property {(() => any) | null} [resolveCurrentSession]
 * @property {(session: any) => boolean} [isSessionLoaded]
 * @property {number} [livenessIntervalMs]
 * @property {number} [pollIntervalMs]
 * @property {() => number} [now]
 */

/** @param {ClaudeWaitDeps} [deps] */
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
    /**
     * @param {Record<string, any>} [rawArgs]
     * @param {{runtimeCallerContext?: unknown, warn?: (w: any) => void}} [toolContext]
     */
    wait_for_claude_session: async (rawArgs = {}, toolContext = {}) => {
      /** @type {any[]} */
      const aliasWarnings = [];
      const args = applyAliases(claudeWaitTool, rawArgs, aliasWarnings);
      for (const warning of aliasWarnings) toolContext.warn?.(warning);
      const { sessionId, replyToMessageId: latestMessageId } = args;
      const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs >= 0
        ? args.timeoutMs
        : DEFAULT_TIMEOUT_MS;

      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new AgentLinkError("invalid_arguments", "`sessionId` must be a non-empty string.", {
          details: { errors: [{ path: "sessionId", rule: "required", expected: "non-empty string" }] }
        });
      }

      const waitStartedAt = now();
      // One listing to find the target and its starting loaded state.
      const sessions0 = sessionsFn() ?? [];
      const target0 = sessions0.find((s) => claudeSessionMatches(s, sessionId));
      if (!target0) {
        throw new AgentLinkError("not_found", `No Claude session has id ${JSON.stringify(sessionId).slice(0, 120)}.`, {
          details: { query: sessionId, candidates: [] },
          hint: "Call resolve_claude_session or list_claude_sessions to find the session id."
        });
      }
      const waited = () => Math.max(0, now() - waitStartedAt);

      const fromIds = claudeSessionAliases(target0);
      const caller = resolveCallerIdentity({
        host,
        runtimeCallerContext: toolContext.runtimeCallerContext ?? null,
        currentSession: resolveCurrentSession
      });
      const wasLoaded = !!target0.loaded;
      const deadline = waitStartedAt + timeoutMs;
      let nextLivenessCheckAt = waitStartedAt + livenessIntervalMs;

      // Keep this process's channel bridge from pushing the message this
      // wait is about to return; released however the wait ends, so the
      // bridge delivers anything left over (timeout, idle) normally.
      const releaseWait = registerActiveWait({
        replyToMessageId: latestMessageId || null,
        fromIds,
        toIds: caller.aliases,
        since: latestMessageId ? null : waitStartedAt
      });
      try {
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
              // Another agent's text: only the validated fields and the peer
              // envelope reach the caller, never the raw row.
              const reply = peerMessageResult(peerMessageFromMailbox(messages[0]));
              return {
                outcome: "reply",
                waitedMs: waited(),
                target: { sessionId },
                reply,
                result: "reply",
                message: reply,
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
                outcome: "idle",
                waitedMs: waited(),
                target: { sessionId, lastLoaded: false },
                result: "idle",
                sessionId
              };
            }
          }

          // 3. Sleep until the next poll, or break out on timeout.
          if (now() >= deadline) {
            return { outcome: "timeout", waitedMs: waited(), target: { sessionId }, result: "timeout", sessionId };
          }
          const remaining = deadline - now();
          await sleep(Math.min(pollIntervalMs, Math.max(remaining, 10)));
        }
      } finally {
        releaseWait();
      }
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Parameters<typeof makeWaitHandler>[0]} deps
 * @returns {import("../server/registry.js").ToolEntry[]}
 */
export function claudeWaitEntries(deps) {
  const handlers = makeWaitHandler(deps);
  return [{
    definition: claudeWaitTool,
    handler: (args, ctx) => handlers.wait_for_claude_session(args, { runtimeCallerContext: ctx.callerContext, warn: ctx.warn })
  }];
}
