// src/tools/claude-send.js
import { openMailbox } from "../claude/mailbox.js";
import { listClaudeSessions } from "../claude/session-index.js";
import { resolveSession } from "../claude/session-resolver.js";
import {
  canonicalClaudeSessionId,
  claudeSessionAliases,
  claudeSessionMatches,
  resolveCallerIdentity
} from "../claude/identity.js";
import { registerActiveWait } from "../claude/active-waits.js";
import { assertPeerBodyWithinLimit } from "../shared/envelope.js";
import { claudeAddress } from "../shared/identity.js";
import { mailboxRowResult } from "../registry/addresses.js";
import { buildReceipt, normalizeReceiptInput, safeAppendReceipt } from "../shared/receipt-index.js";
import { AgentLinkError } from "../shared/errors.js";
import { applyAliases, deprecationWarning } from "../server/registry.js";
import { LIMITS, bool, commonOut, enumOf, out, receiptInput, str, timeoutMs as timeoutMsSchema } from "../server/schemas.js";

const DEFAULT_WAIT_TIMEOUT_MS = LIMITS.timeoutMs.def;
const DEFAULT_POLL_INTERVAL_MS = 250;

/** @type {import("../server/registry.js").ToolDefinition} */
export const claudeSendTool = {
  name: "message_claude_session",
  description:
    "Deliver a message to a Claude Desktop or Claude Code session by exact sessionId or by fuzzy query (title, cwd, partial id). " +
    "Pass exactly one of sessionId or query. The message is queued in the local Agent Link JSONL mailbox. Claude Code sessions can receive through Channels when enabled; " +
    "Desktop sessions receive through the UserPromptSubmit hook and read_agent_link_inbox visible tool result. " +
    "Returns {messageId, delivery, target, resolution, receipt}. An unmatched target is a not_found error and a query matching several " +
    "sessions is an ambiguous error (details.candidates). delivery is 'queued-online' when the target session is currently loaded as a `claude --resume` " +
    "process, otherwise 'queued-offline'. Set waitForReply=true to block until the target replies to this message (from the target, " +
    "addressed to the caller) or timeoutMs elapses; the result is in `wait` ({outcome: 'reply' | 'timeout', waitedMs, target, reply?}).",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: str("Exact target session: sessionId (local_<uuid>), cliSessionId, or local_<cli>. Archived sessions are reachable by exact id."),
      query: str("Fuzzy target lookup over title, cwd, and partial id. Archived sessions are skipped. Ambiguous matches fail with ambiguous."),
      to: {
        type: "string",
        description: "Deprecated (removed in 0.6.0): an exact id or a fuzzy query. Use sessionId or query.",
        deprecated: true
      },
      message: str("Message text to deliver (at most 64 KiB)."),
      surface: enumOf(["desktop", "code"], "Optional target surface filter. Defaults to either Desktop or Code."),
      deliveryPreference: enumOf(["auto", "channel", "mailbox"], "Delivery preference. Defaults to auto: channel for loaded Claude Code sessions, mailbox otherwise."),
      replyToMessageId: str("If this send is itself a reply to a prior inbound message addressed to the caller, set the original messageId."),
      waitForReply: bool("Block until the target replies to this message or timeoutMs elapses."),
      timeoutMs: timeoutMsSchema("Maximum wait when waitForReply=true, in milliseconds."),
      receipt: receiptInput
    },
    additionalProperties: false
  },
  aliases: [{ canonical: "message", aliases: ["body"], required: true }],
  output: {
    messageId: out("string", "Id of the queued message."),
    delivery: out("string", "queued-channel, queued-online, queued-offline, or queued-mailbox."),
    target: out("object", "{address, sessionId, title, loaded, surface} of the target session."),
    resolution: out("object", "How the target was found: {via: exact|fuzzy, query, matchReasons, candidates?}."),
    receipt: commonOut.receipt,
    wait: out("object", "With waitForReply: {outcome: reply|timeout, waitedMs, target: {sessionId, address}, reply?} (section 3.4)."),
    replyConfirmation: out("object", "Deprecated duplicate of wait in the 0.4 shape ({received, replyMessageId?, reply?, error?}); removed in 0.6.0.")
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
};

/**
 * The target argument: sessionId (exact), query (fuzzy), or the deprecated
 * `to` (exact first, then fuzzy, as before).
 * @param {Record<string, any>} args
 * @param {((w: any) => void) | undefined} warn
 * @returns {{value: string, mode: "exact" | "fuzzy" | "either"}}
 */
function targetArgument(args, warn) {
  const given = ["sessionId", "query", "to"].filter((key) => typeof args[key] === "string" && args[key].trim());
  if (args.to !== undefined) warn?.(deprecationWarning("to", "sessionId or query"));
  if (given.length === 0) {
    throw new AgentLinkError("invalid_arguments", "Pass sessionId (exact id) or query (fuzzy lookup).", {
      details: { errors: [{ path: "sessionId", rule: "required", expected: "sessionId or query" }] }
    });
  }
  const values = new Set(given.map((key) => args[key]));
  if (given.length > 1 && (values.size > 1 || (given.includes("sessionId") && given.includes("query")))) {
    throw new AgentLinkError("invalid_arguments", `Pass only one of ${given.join(", ")}.`, {
      details: { errors: given.slice(1).map((key) => ({ path: key, rule: "alias_conflict", expected: `only ${given[0]}` })) }
    });
  }
  const key = given[0];
  return { value: args[key], mode: key === "sessionId" ? "exact" : key === "query" ? "fuzzy" : "either" };
}

/**
 * @typedef {object} ClaudeSendDeps
 * @property {string} [host]                         this server's host, recorded in receipts
 * @property {(args?: {surface?: string}) => any[]} [listSessions]   session listing (tests inject one)
 * @property {Record<string, unknown>} [listOptions]  options for the default listing
 * @property {() => any} [mailboxOpener]             opens the mailbox (tests inject one)
 * @property {(() => any) | null} [resolveCurrentSession]
 * @property {(receipt: any) => Promise<any>} [appendReceipt]
 */

/** @param {ClaudeSendDeps} [deps] */
export function makeClaudeSendHandler({
  host,
  listSessions,
  listOptions = {},
  mailboxOpener,
  resolveCurrentSession = null,
  appendReceipt = safeAppendReceipt
} = {}) {
  // Archived sessions are listed so an exact id can still address them;
  // fuzzy matching below skips them.
  const sessionsFn = typeof listSessions === "function"
    ? listSessions
    : (args = {}) => listClaudeSessions({ ...listOptions, surface: args.surface ?? "all", includeArchived: true });
  const openMb = typeof mailboxOpener === "function"
    ? mailboxOpener
    : () => openMailbox();

  return {
    /**
     * @param {Record<string, any>} [rawArgs]
     * @param {{runtimeCallerContext?: unknown, warn?: (w: any) => void}} [toolContext]
     */
    message_claude_session: async (rawArgs = {}, toolContext = {}) => {
      /** @type {any[]} */
      const aliasWarnings = [];
      const args = applyAliases(claudeSendTool, rawArgs, aliasWarnings);
      for (const warning of aliasWarnings) toolContext.warn?.(warning);
      const {
        message: body,
        replyToMessageId,
        waitForReply,
        timeoutMs,
        surface,
        deliveryPreference = "auto",
        receipt
      } = args;
      const runtimeCallerContext = toolContext.runtimeCallerContext ?? null;

      const { value: to, mode } = targetArgument(args, toolContext.warn);
      if (typeof body !== "string" || !body.length) {
        throw new AgentLinkError("invalid_arguments", "`message` must be a non-empty string.", {
          details: { errors: [{ path: "message", rule: "required", expected: "non-empty string" }] }
        });
      }
      assertPeerBodyWithinLimit(body);

      const sessions = (sessionsFn({ surface: surface ?? "all" }) ?? [])
        .filter((s) => !surface || s.surface === surface);

      // 1. Resolve target
      let target = null;
      let resolution = null;
      // Exact ids (sidecar id, CLI id, or local_<cli>) also reach archived
      // sessions; fuzzy queries only consider active ones.
      const exact = mode === "fuzzy" ? null : sessions.find((s) => claudeSessionMatches(s, to));
      if (exact) {
        target = exact;
        resolution = {
          via: "exact",
          query: to,
          matchReasons: ["sessionId-exact"]
        };
      } else if (mode === "exact") {
        throw new AgentLinkError("not_found", `No Claude session has id ${JSON.stringify(to).slice(0, 120)}.`, {
          details: { query: to, candidates: [] },
          hint: "Pass query for a fuzzy lookup, or call list_claude_sessions."
        });
      } else {
        const r = resolveSession({ query: to }, sessions.filter((s) => !s.isArchived));
        if (!r.best) {
          throw new AgentLinkError("not_found", `No Claude session matches ${JSON.stringify(to).slice(0, 120)}.`, {
            details: { query: to, candidates: [] },
            hint: "Call list_claude_sessions to see addressable sessions."
          });
        }
        if (r.selection.ambiguous) {
          throw new AgentLinkError("ambiguous", `Several Claude sessions match ${JSON.stringify(to).slice(0, 120)}.`, {
            details: { query: to, candidates: r.candidates.slice(0, 5).map(candidateSummary) },
            hint: "Pass the exact sessionId of one candidate."
          });
        }
        target = r.best;
        resolution = {
          via: "fuzzy",
          query: to,
          matchReasons: r.selection.matchReasons,
          candidates: r.candidates
        };
      }

      // 2. Insert into mailbox
      const caller = resolveCallerIdentity({
        host,
        runtimeCallerContext,
        currentSession: resolveCurrentSession
      });
      const mb = openMb();
      let messageId;
      let releaseWait = null;
      try {
        if (replyToMessageId !== undefined && replyToMessageId !== null) {
          const original = typeof replyToMessageId === "string" ? mb.getMessage({ messageId: replyToMessageId }) : null;
          if (!original || !caller.aliases.includes(original.to_session_id)) {
            throw new AgentLinkError("invalid_arguments", "`replyToMessageId` must reference an Agent Link message addressed to the caller.", {
              details: { errors: [{ path: "replyToMessageId", rule: "reference", expected: "a message addressed to the caller" }] }
            });
          }
        }

        messageId = mb.insertMessage({
          fromSessionId: caller.id,
          fromSessionKind: caller.kind,
          toSessionId: canonicalClaudeSessionId(target),
          toSessionKind: "claude",
          body,
          metadata: mailboxMetadata({ receipt, resolution, senderSource: caller.source }),
          replyToMessageId: replyToMessageId ?? null
        });
        // Register the reply wait before the receipt write yields, so this
        // process's channel bridge never pushes the reply pollForReply will
        // return. Released in the finally below however the call ends.
        if (waitForReply) {
          releaseWait = registerActiveWait({
            replyToMessageId: messageId,
            fromIds: claudeSessionAliases(target),
            toIds: caller.aliases
          });
        }

        const delivery = classifyDelivery({ target, deliveryPreference });
        const targetSummary = {
          address: claudeAddress(target),
          sessionId: target.sessionId,
          title: target.title,
          loaded: !!target.loaded,
          surface: target.surface ?? null
        };

        // 3. Write receipt (unless caller opted out). The write result is
        // returned to the caller as `receipt`, including failures.
        let receiptResult = { ok: true, recorded: false, reason: "receipt.record was false" };
        if (!receipt || receipt.record !== false) {
          const built = buildReceipt({
            action: "message_claude_session",
            receipt,
            host,
            target: {
              // Map Claude session fields onto the existing receipt target shape.
              // `name` carries the human-readable title; `sessionId`, `loaded`,
              // and `kind` are additive fields the receipt index passes through.
              address: claudeAddress(target),
              name: target.title,
              cwd: target.cwd,
              sessionId: target.sessionId,
              loaded: !!target.loaded,
              kind: "claude"
            },
            message: body,
            delivery,
            runtimeCallerContext
          });
          receiptResult = { recorded: true, ...await appendReceipt(built) };
        }

        const result = {
          messageId,
          delivery,
          target: targetSummary,
          resolution,
          receipt: receiptResult
        };

        // 4. Optionally wait for a reply
        if (waitForReply) {
          const startedAt = Date.now();
          const confirmation = await pollForReply(mb, {
            messageId,
            fromIds: claudeSessionAliases(target),
            toIds: caller.aliases,
            timeoutMs: typeof timeoutMs === "number" && timeoutMs >= 0 ? timeoutMs : DEFAULT_WAIT_TIMEOUT_MS
          });
          result.wait = {
            outcome: confirmation.received ? "reply" : "timeout",
            waitedMs: Date.now() - startedAt,
            target: { sessionId: target.sessionId, address: claudeAddress(target) },
            ...(confirmation.received ? { reply: confirmation.reply } : {})
          };
          result.replyConfirmation = confirmation;
        }

        return result;
      } finally {
        releaseWait?.();
        mb.close();
      }
    }
  };
}

// Only bounded, sanitized fields go into the mailbox: the raw `receipt`
// argument (e.g. an unbounded `note`) and full candidate session objects
// would bypass the body cap and bloat every mailbox read.
const MAX_METADATA_QUERY = 200;
const MAX_METADATA_CANDIDATES = 10;
function mailboxMetadata({ receipt, resolution, senderSource = null }) {
  const normalized = receipt ? normalizeReceiptInput(receipt) : null;
  return {
    // How this server identified the sender (resolveCallerIdentity source).
    // The envelope shows fromVerified="true" only for a runtime source.
    sender: { source: typeof senderSource === "string" ? senderSource : null },
    receipt: normalized
      ? {
          record: normalized.record,
          purpose: normalized.purpose,
          cleanupRecommendation: normalized.cleanupRecommendation,
          tags: normalized.tags
        }
      : null,
    resolution: resolution
      ? {
          via: resolution.via,
          query: String(resolution.query ?? "").slice(0, MAX_METADATA_QUERY),
          matchReasons: Array.isArray(resolution.matchReasons) ? resolution.matchReasons.slice(0, 20) : [],
          ...(Array.isArray(resolution.candidates)
            ? {
                candidates: resolution.candidates.slice(0, MAX_METADATA_CANDIDATES).map((c) => ({
                  sessionId: c.sessionId,
                  score: c.score,
                  matchReasons: c.matchReasons
                }))
              }
            : {})
        }
      : null
  };
}

/** @param {any} candidate */
function candidateSummary(candidate) {
  return {
    address: claudeAddress(candidate),
    sessionId: candidate.sessionId,
    title: candidate.title ?? null,
    surface: candidate.surface ?? null,
    score: candidate.score,
    matchReasons: candidate.matchReasons
  };
}

function classifyDelivery({ target, deliveryPreference }) {
  if (deliveryPreference === "channel") {
    return target.surface === "code" && target.loaded ? "queued-channel" : "queued-mailbox";
  }
  if (deliveryPreference === "mailbox") return target.loaded ? "queued-online" : "queued-offline";
  if (target.surface === "code" && target.loaded && target.supportsChannel !== false) return "queued-channel";
  return target.loaded ? "queued-online" : "queued-offline";
}

// A reply only counts when it comes from the target session (any of its id
// forms) and is addressed to this caller. Anyone can append to the mailbox,
// so a reply_to_message_id match alone would let a third party forge the
// answer the caller is blocked on.
async function pollForReply(mb, { messageId, fromIds, toIds, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const from = new Set(fromIds);
  const to = new Set(toIds);
  // First check immediately in case a reply arrived synchronously.
  while (true) {
    const replies = mb.inspect({ replyToMessageId: messageId, limit: Number.MAX_SAFE_INTEGER })
      .filter((m) => from.has(m.from_session_id) && to.has(m.to_session_id))
      .sort((a, b) => a.sent_at - b.sent_at);
    if (replies.length) {
      // The wait consumed this reply: it counts as delivered (and
      // acknowledged), so the sender's channel, hook and inbox do not
      // deliver it a second time.
      consumeReply(mb, replies[0]);
      // The reply is another agent's text: it reaches the caller only inside
      // the peer envelope, never as a raw body.
      return {
        received: true,
        replyMessageId: replies[0].id,
        reply: mailboxRowResult(replies[0])
      };
    }
    if (Date.now() >= deadline) {
      return { received: false, error: "timeout" };
    }
    const remaining = deadline - Date.now();
    await sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, Math.max(remaining, 10)));
  }
}

export function consumeReply(mb, message) {
  if (!message.delivered_at) mb.markDelivered({ messageId: message.id });
  if (!message.acknowledged_at) mb.markAcknowledged({ messageId: message.id });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Parameters<typeof makeClaudeSendHandler>[0]} deps
 * @returns {import("../server/registry.js").ToolEntry[]}
 */
export function claudeSendEntries(deps) {
  const handlers = makeClaudeSendHandler(deps);
  return [{
    definition: claudeSendTool,
    handler: (args, ctx) => handlers.message_claude_session(args, { runtimeCallerContext: ctx.callerContext, warn: ctx.warn })
  }];
}
