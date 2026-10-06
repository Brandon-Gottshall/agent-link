// src/tools/claude-send.js
import { openMailbox, messageBodyTooLarge } from "../claude/mailbox.js";
import { listClaudeSessions } from "../claude/session-index.js";
import { resolveSession } from "../claude/session-resolver.js";
import {
  canonicalClaudeSessionId,
  claudeSessionAliases,
  claudeSessionMatches,
  resolveCallerIdentity
} from "../claude/identity.js";
import { registerActiveWait } from "../claude/active-waits.js";
import { buildReceipt, normalizeReceiptInput, safeAppendReceipt } from "../shared/receipt-index.js";

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

const receiptInputSchema = {
  type: "object",
  description:
    "Optional provenance metadata for the local Agent Link receipt index. Receipts are recorded by default; set record=false to opt out.",
  properties: {
    record: { type: "boolean" },
    purpose: { type: "string" },
    originThreadId: { type: "string" },
    originTurnId: { type: "string" },
    originToolCallId: { type: "string" },
    cleanupRecommendation: { type: "string" },
    note: { type: "string" },
    tags: { type: "array", items: { type: "string" } }
  },
  additionalProperties: false
};

export const claudeSendTool = {
  name: "message_claude_session",
  description:
    "Deliver a message to a Claude Desktop or Claude Code session by exact sessionId or fuzzy query (title, cwd, partial id). " +
    "The message is queued in the local Agent Link JSONL mailbox. Claude Code sessions can receive through Channels when enabled; " +
    "Desktop sessions receive through the UserPromptSubmit hook and read_agent_link_inbox visible tool result. " +
    "Returns {messageId, delivery, target} on success, or {error: 'ambiguous'|'not_found', candidates} on failed " +
    "resolution. delivery is 'queued-online' when the target session is currently loaded as a `claude --resume` " +
    "process, otherwise 'queued-offline'. Set waitForReply=true to block until the receiver acks with a reply " +
    "body, or timeoutMs elapses.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Exact local_<uuid> sessionId, or a fuzzy query (title, cwd, partial id)."
      },
      body: { type: "string", description: "Message body to deliver." },
      surface: {
        type: "string",
        enum: ["desktop", "code"],
        description: "Optional target surface filter. Defaults to either Desktop or Code."
      },
      deliveryPreference: {
        type: "string",
        enum: ["auto", "channel", "mailbox"],
        description: "Delivery preference. Defaults to auto: channel for loaded Claude Code sessions, mailbox otherwise."
      },
      replyToMessageId: {
        type: "string",
        description: "If this send is itself a reply to a prior inbound message, set the original messageId."
      },
      waitForReply: {
        type: "boolean",
        description: "Block until the receiver acks with a reply body or timeoutMs elapses."
      },
      timeoutMs: {
        type: "number",
        description: "Maximum wait when waitForReply=true. Defaults to 60000."
      },
      receipt: receiptInputSchema
    },
    required: ["to", "body"]
  }
};

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
    message_claude_session: async (args = {}, toolContext = {}) => {
      const {
        to,
        body,
        replyToMessageId,
        waitForReply,
        timeoutMs,
        surface,
        deliveryPreference = "auto",
        receipt
      } = args;
      const runtimeCallerContext = toolContext.runtimeCallerContext ?? null;

      if (typeof to !== "string" || !to.trim()) {
        return { error: "invalid_arguments", message: "`to` must be a non-empty string" };
      }
      if (typeof body !== "string" || !body.length) {
        return { error: "invalid_arguments", message: "`body` must be a non-empty string" };
      }
      const tooLarge = messageBodyTooLarge(body);
      if (tooLarge) return tooLarge;

      const sessions = (sessionsFn({ surface: surface ?? "all" }) ?? [])
        .filter((s) => !surface || s.surface === surface);

      // 1. Resolve target
      let target = null;
      let resolution = null;
      // Exact ids (sidecar id, CLI id, or local_<cli>) also reach archived
      // sessions; fuzzy queries only consider active ones.
      const exact = sessions.find((s) => claudeSessionMatches(s, to));
      if (exact) {
        target = exact;
        resolution = {
          via: "exact",
          query: to,
          matchReasons: ["sessionId-exact"]
        };
      } else {
        const r = resolveSession({ query: to }, sessions.filter((s) => !s.isArchived));
        if (!r.best) {
          return { error: "not_found", candidates: [], query: to };
        }
        if (r.selection.ambiguous) {
          return {
            error: "ambiguous",
            candidates: r.candidates,
            query: to
          };
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
            return {
              error: "invalid_arguments",
              message: "`replyToMessageId` must reference an Agent Link message addressed to the caller.",
              replyToMessageId
            };
          }
        }

        try {
          messageId = mb.insertMessage({
            fromSessionId: caller.id,
            fromSessionKind: caller.kind,
            toSessionId: canonicalClaudeSessionId(target),
            toSessionKind: "claude",
            body,
            metadata: mailboxMetadata({ receipt, resolution, senderSource: caller.source }),
            replyToMessageId: replyToMessageId ?? null
          });
        } catch (error) {
          if (/limited to \d+ bytes/.test(error.message)) {
            return { error: "invalid_arguments", message: error.message };
          }
          throw error;
        }
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
          result.replyConfirmation = await pollForReply(mb, {
            messageId,
            fromIds: claudeSessionAliases(target),
            toIds: caller.aliases,
            timeoutMs: typeof timeoutMs === "number" && timeoutMs >= 0 ? timeoutMs : DEFAULT_WAIT_TIMEOUT_MS
          });
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
      return {
        received: true,
        body: replies[0].body,
        replyMessageId: replies[0].id
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
