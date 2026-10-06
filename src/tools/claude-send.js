// src/tools/claude-send.js
import { openMailbox } from "../claude/mailbox.js";
import { listClaudeSessions } from "../claude/session-index.js";
import { resolveSession } from "../claude/session-resolver.js";
import { buildReceipt, safeAppendReceipt } from "../shared/receipt-index.js";
import { currentClaudeSessionId } from "../shared/host-detect.js";

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

export function makeClaudeSendHandler({ host, listSessions, mailboxOpener } = {}) {
  const sessionsFn = typeof listSessions === "function"
    ? listSessions
    : (args = {}) => listClaudeSessions({ surface: args.surface ?? "all" });
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

      const sessions = (sessionsFn({ surface: surface ?? "all" }) ?? [])
        .filter((s) => !surface || s.surface === surface);

      // 1. Resolve target
      let target = null;
      let resolution = null;
      const exact = sessions.find((s) => s.sessionId === to || s.cliSessionId === to);
      if (exact) {
        target = exact;
        resolution = {
          via: "exact",
          query: to,
          matchReasons: ["sessionId-exact"]
        };
      } else {
        const r = resolveSession({ query: to }, sessions);
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
      const mb = openMb();
      let messageId;
      try {
        const fromSessionKind = host === "claude" || host === "codex" ? host : "external";
        const fromSessionId = pickFromSessionId(host, runtimeCallerContext);

        messageId = mb.insertMessage({
          fromSessionId,
          fromSessionKind,
          toSessionId: target.sessionId,
          toSessionKind: "claude",
          body,
          metadata: { receipt: receipt ?? null, resolution },
          replyToMessageId: replyToMessageId ?? null
        });

        const delivery = classifyDelivery({ target, deliveryPreference });
        const targetSummary = {
          sessionId: target.sessionId,
          title: target.title,
          loaded: !!target.loaded,
          surface: target.surface ?? null
        };

        // 3. Write receipt (unless caller opted out)
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
          // Fire-and-forget; failures are logged inside safeAppendReceipt.
          await safeAppendReceipt(built);
        }

        const result = {
          messageId,
          delivery,
          target: targetSummary,
          resolution
        };

        // 4. Optionally wait for a reply
        if (waitForReply) {
          result.replyConfirmation = await pollForReply(
            mb,
            messageId,
            typeof timeoutMs === "number" && timeoutMs >= 0 ? timeoutMs : DEFAULT_WAIT_TIMEOUT_MS
          );
        }

        return result;
      } finally {
        mb.close();
      }
    }
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

// Precedence: MCP runtime caller context > host env var > "external".
// `extractRuntimeCallerContext` (see src/shared/caller-context.js) returns
// {available, threadId, turnId, toolCallId, ...}, classifying both
// `callerThreadId` and `originThreadId` _meta keys onto `threadId`. This
// matches the precedence the receipt origin chain already uses, so a Codex
// caller's threadId reaches both `from_session_id` and `origin.threadId`
// even when CODEX_THREAD_ID isn't set in the server's environment.
function pickFromSessionId(host, runtimeCallerContext) {
  const runtimeId = runtimeCallerContext?.threadId ?? null;
  if (host === "claude") {
    return runtimeId ?? currentClaudeSessionId() ?? "external";
  }
  if (host === "codex") {
    return runtimeId ?? process.env.CODEX_THREAD_ID ?? "external";
  }
  return "external";
}

async function pollForReply(mb, messageId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // First check immediately in case a reply arrived synchronously.
  while (true) {
    const replies = mb.inspect({ replyToMessageId: messageId, limit: 1 });
    if (replies.length) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
