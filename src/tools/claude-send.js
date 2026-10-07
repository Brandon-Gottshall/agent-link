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
import { isAnticipating, isLateResolution, messageStatus, reminderSettings, resolveLabels } from "../delivery/message-status.js";
import { checkMessageWait, recordStatusTransition } from "../delivery/message-wait.js";
import { claimResolution } from "../delivery/resolution.js";
import { claudeAddress, hostIdentity, parseAddress } from "../shared/identity.js";
import { looksLikeRoleAddress, procedureProblemWarning } from "../registry/roles.js";
import { checkRoleAddressing } from "../delivery/role-policy.js";
import { mailboxRowResult } from "../registry/addresses.js";
import { buildReceipt, normalizeReceiptInput, safeAppendReceipt } from "../shared/receipt-index.js";
import { AgentLinkError } from "../shared/errors.js";
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
    "process, otherwise 'queued-offline'. Label the message with anticipation: 'reply' (a reply is expected), 'action' (do it and " +
    "mark it done), or 'fyi' (default; no reply needed), plus an optional replyBy deadline. The recipient resolves a 'reply' or " +
    "'action' message explicitly with reply_agent_link_message; it is reminded between its turns until then, up to a cap. " +
    "Set waitForReply=true (implies anticipation 'reply') to block until the target resolves this message or timeoutMs elapses; " +
    "the result is in `wait` ({outcome: 'reply' | 'declined' | 'done' | 'unresolved' | 'expired' | 'timeout', messageStatus, waitedMs, " +
    "target, reply?}). Only an explicit reply is returned. get_agent_link_message_status reports the status later.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: str("Exact target session: sessionId (local_<uuid>), cliSessionId, local_<cli>, a claude:<id> address, or role:<name> (the Claude session currently holding the role). Archived sessions are reachable by exact id."),
      query: str("Fuzzy target lookup over title, cwd, and partial id. Archived sessions are skipped. Ambiguous matches fail with ambiguous."),
      message: str("Message text to deliver (at most 64 KiB)."),
      surface: enumOf(["desktop", "code"], "Optional target surface filter. Defaults to either Desktop or Code."),
      deliveryPreference: enumOf(["auto", "channel", "mailbox"], "Delivery preference. Defaults to auto: channel for loaded Claude Code sessions, mailbox otherwise."),
      replyToMessageId: str("If this send is itself a reply to a prior inbound message addressed to the caller, set the original messageId. An open reply/action message is resolved as replied."),
      anticipation: enumOf(["reply", "action", "fyi"], "What the sender expects: reply (a reply is expected), action (do the requested thing and mark it done), or fyi (no reply needed). Defaults to fyi, or reply with waitForReply=true; fyi with waitForReply=true is rejected."),
      replyBy: str("Optional deadline for a reply or action message, ISO 8601 with a time zone, at least 30 s ahead. After it passes the message status is expired. Not allowed with fyi."),
      waitForReply: bool("Block until the target resolves this message (reply, decline, done) or it becomes unresolved or expired, or timeoutMs elapses. Implies anticipation reply."),
      timeoutMs: timeoutMsSchema("Maximum wait when waitForReply=true, in milliseconds."),
      receipt: receiptInput
    },
    required: ["message"],
    additionalProperties: false
  },
  removedArguments: [
    { name: "body", replacement: "message" },
    { name: "to", replacement: "sessionId (exact id; archived sessions included) or query (fuzzy; archived sessions skipped)" }
  ],
  output: {
    messageId: out("string", "Id of the queued message."),
    delivery: out("string", "queued-channel, queued-online, queued-offline, or queued-mailbox."),
    target: out("object", "{address, sessionId, title, loaded, surface} of the target session."),
    resolution: out("object", "How the target was found: {via: exact|fuzzy|role:<name>, query, matchReasons, candidates?}."),
    receipt: commonOut.receipt,
    anticipation: enumOf(["reply", "action", "fyi"], "The message's anticipation label."),
    replyBy: out(["string", "null"], "The message's deadline (ISO 8601), or null."),
    messageStatus: out(["string", "null"], "pending for a reply/action message, null for fyi."),
    wait: out("object", "With waitForReply: {outcome: reply|declined|done|unresolved|expired|timeout, messageStatus, waitedMs, target: {sessionId, address}, reply?} (sections 3.4, 7.6). reply is the explicit reply, decline reason, or done note, enveloped."),
    via: out("string", "role:<name> when the target was addressed by role; the message went to the role's current holder."),
    roleProcedure: out(["object", "null"], "With a role target: {name, version, textIncluded} of the role's procedure, or null when the role has none.")
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
};

/**
 * The target argument: sessionId (exact) or query (fuzzy).
 * @param {Record<string, any>} args
 * @returns {{value: string, mode: "exact" | "fuzzy"}}
 */
function targetArgument(args) {
  const given = ["sessionId", "query"].filter((key) => typeof args[key] === "string" && args[key].trim());
  if (given.length === 0) {
    throw new AgentLinkError("invalid_arguments", "Pass sessionId (exact id) or query (fuzzy lookup).", {
      details: { errors: [{ path: "sessionId", rule: "required", expected: "sessionId or query" }] }
    });
  }
  if (given.length > 1) {
    throw new AgentLinkError("invalid_arguments", "Pass only one of sessionId, query.", {
      details: { errors: [{ path: "query", rule: "conflict", expected: "only sessionId" }] }
    });
  }
  const key = given[0];
  return { value: args[key], mode: key === "sessionId" ? "exact" : "fuzzy" };
}

/**
 * @typedef {object} ClaudeSendDeps
 * @property {string} [host]                         this server's host, recorded in receipts
 * @property {(args?: {surface?: string}) => any[]} [listSessions]   session listing (tests inject one)
 * @property {Record<string, unknown>} [listOptions]  options for the default listing
 * @property {() => any} [mailboxOpener]             opens the mailbox (tests inject one)
 * @property {(() => any) | null} [resolveCurrentSession]
 * @property {(receipt: any) => Promise<any>} [appendReceipt]
 * @property {() => number} [now]                    clock (tests inject one)
 * @property {() => import("../delivery/message-status.js").ReminderSettings} [reminderSettings]
 * @property {import("../registry/roles.js").RoleStore | null} [roles]   role table (role:<name> targets, enforcement)
 */

/** @param {ClaudeSendDeps} [deps] */
export function makeClaudeSendHandler({
  host,
  listSessions,
  listOptions = {},
  mailboxOpener,
  resolveCurrentSession = null,
  appendReceipt = safeAppendReceipt,
  now = () => Date.now(),
  reminderSettings: settingsFn = () => reminderSettings(),
  roles = null
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
      const args = rawArgs ?? {};
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
      const labels = resolveLabels({
        anticipation: args.anticipation,
        replyBy: args.replyBy,
        waitForReply: waitForReply === true,
        now: now()
      });

      const targetArg = targetArgument(args);
      const { mode } = targetArg;
      let to = targetArg.value;
      // role:<name> resolves to the role's current holder at send time (R1.19).
      let role = null;
      if (looksLikeRoleAddress(to)) {
        if (!roles) {
          throw new AgentLinkError("unsupported", "Role addresses are not available on this server.", { details: { capability: "roles" } });
        }
        role = roles.resolve(to.trim());
        const holder = parseAddress(role.address);
        if (holder?.harness !== "claude") {
          throw new AgentLinkError("invalid_arguments", `Role ${role.role} is held by ${role.address}, a Codex thread; message_claude_session only reaches Claude sessions.`, {
            details: { errors: [{ path: "sessionId", rule: "harness", expected: "a role held by a claude: session" }], role: role.role, address: role.address },
            hint: `Call message_codex_thread with threadId="role:${role.role}".`
          });
        }
        to = holder.id;
      }
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
      const exact = mode === "fuzzy" && !role ? null : sessions.find((s) => claudeSessionMatches(s, to));
      if (exact) {
        target = exact;
        resolution = {
          via: "exact",
          query: to,
          matchReasons: ["sessionId-exact"]
        };
      } else if (mode === "exact" || role) {
        throw new AgentLinkError("not_found", role
          ? `Role ${role.role} is held by ${role.address}, but no Claude session with that id was found.`
          : `No Claude session has id ${JSON.stringify(to).slice(0, 120)}.`, {
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
        let answered = null;
        if (replyToMessageId !== undefined && replyToMessageId !== null) {
          const original = typeof replyToMessageId === "string" ? mb.getMessage({ messageId: replyToMessageId }) : null;
          if (!original || !caller.aliases.includes(original.to_session_id)) {
            throw new AgentLinkError("invalid_arguments", "`replyToMessageId` must reference an Agent Link message addressed to the caller.", {
              details: { errors: [{ path: "replyToMessageId", rule: "reference", expected: "a message addressed to the caller" }] }
            });
          }
          answered = original;
        }

        // Role addressing between persistent agents (R1.23): checked before
        // the mailbox write, so `enforce` writes nothing.
        const targetAddress = claudeAddress(target);
        const senderAddress = hostIdentity({ host, callerContext: /** @type {any} */ (runtimeCallerContext), currentSession: resolveCurrentSession }).address;
        const tableRead = roles ? roles.read() : null;
        const enforcement = roles && tableRead ? roles.enforcement(tableRead) : { mode: "off" };
        const addressing = checkRoleAddressing({
          mode: enforcement.mode,
          senderAddress,
          targetAddress,
          via: role?.via ?? null,
          isReply: replyToMessageId !== undefined && replyToMessageId !== null,
          rolesOf: (address) => (roles && tableRead && !tableRead.error ? roles.rolesOf(address, tableRead.table) : [])
        });
        if (addressing.warning) toolContext.warn?.(addressing.warning);
        // A procedure file that was refused (symlink, FIFO, over 64 KiB) is reported, not silently skipped.
        const procedureWarning = procedureProblemWarning(role);
        if (procedureWarning) toolContext.warn?.(procedureWarning);

        // R1.20: the procedure text rides along with the first delivery of
        // each version to the holder.
        const procedure = role?.procedure ?? null;
        const procedureClaim = procedure && targetAddress ? { role: procedure.name, sha256: procedure.sha256, address: targetAddress } : null;
        const withText = procedureClaim && roles ? roles.claimProcedureDelivery(procedureClaim) : false;
        const roleMetadata = role
          ? {
              via: role.via,
              procedure: procedure ? { name: procedure.name, version: procedure.version } : null,
              ...(withText && procedure ? { procedureText: procedure.text } : {})
            }
          : null;

        try {
          messageId = mb.insertMessage({
            fromSessionId: caller.id,
            fromSessionKind: caller.kind,
            toSessionId: canonicalClaudeSessionId(target),
            toSessionKind: "claude",
            body,
            metadata: { ...mailboxMetadata({ receipt, resolution, senderSource: caller.source }), ...(roleMetadata ? { role: roleMetadata } : {}) },
            replyToMessageId: replyToMessageId ?? null,
            anticipation: labels.anticipation,
            replyBy: labels.replyBy
          });
        } catch (error) {
          if (withText && procedureClaim && roles) roles.releaseProcedureDelivery(procedureClaim);
          throw error;
        }
        // An explicit reply sent back to the original sender resolves an
        // open reply/action message as replied (R7.5); fyi mail has no
        // status, and a resolved message stays as it was.
        // Exactly once (R7.10): the resolve claim first; a lost claim means
        // another resolver got there, and this send stays a plain message.
        if (answered && isAnticipating(answered) && !answered.resolution &&
            claudeSessionAliases(target).includes(answered.from_session_id) &&
            claimResolution(mb, answered.id).ok) {
          const view = messageStatus(answered, { now: now(), settings: settingsFn() });
          mb.markAcknowledged({ messageId: answered.id });
          mb.recordResolution({
            messageId: answered.id,
            kind: "reply",
            by: answered.to_session_id,
            byAddress: claudeAddress(resolveCurrentSessionSafe(resolveCurrentSession)) ?? null,
            late: isLateResolution(view),
            replyMessageId: messageId
          });
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
          const stored = {
            ...built,
            ...(role ? { via: role.via, roleProcedure: procedure ? { name: procedure.name, version: procedure.version } : null } : {}),
            ...(procedureWarning ? { roleProcedureWarning: procedureWarning.details } : {}),
            ...(addressing.tag ? { tags: [...new Set([...(built.tags ?? []), addressing.tag])] } : {})
          };
          receiptResult = { recorded: true, ...await appendReceipt(stored) };
        }

        /** @type {Record<string, any>} */
        const result = {
          messageId,
          delivery,
          target: targetSummary,
          resolution: role ? { ...resolution, via: role.via } : resolution,
          anticipation: labels.anticipation,
          replyBy: labels.replyBy === null ? null : new Date(labels.replyBy).toISOString(),
          messageStatus: labels.anticipation === "fyi" ? null : "pending",
          ...(role ? { via: role.via, roleProcedure: procedure ? { name: procedure.name, version: procedure.version, textIncluded: withText } : null } : {}),
          receipt: receiptResult
        };

        // 4. Optionally wait for the message to be resolved
        if (waitForReply) {
          const startedAt = now();
          const confirmation = await pollForResolution(mb, {
            messageId,
            fromIds: claudeSessionAliases(target),
            toIds: caller.aliases,
            timeoutMs: typeof timeoutMs === "number" && timeoutMs >= 0 ? timeoutMs : DEFAULT_WAIT_TIMEOUT_MS,
            now,
            settings: settingsFn(),
            host,
            appendReceipt
          });
          result.wait = {
            outcome: confirmation.outcome,
            messageStatus: confirmation.messageStatus,
            waitedMs: now() - startedAt,
            target: { sessionId: target.sessionId, address: claudeAddress(target) },
            ...(confirmation.reply ? { reply: confirmation.reply } : {})
          };
          result.messageStatus = confirmation.messageStatus;
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

// Polls until the message leaves `pending` (design R7.19) or the timeout.
// Only an explicit reply from the target session (any of its id forms)
// addressed to this caller is returned: anyone can append to the mailbox, so
// a reply_to_message_id match alone would let a third party forge the answer
// the caller is blocked on. A turn's final response never ends the wait.
async function pollForResolution(mb, { messageId, fromIds, toIds, timeoutMs, now, settings, host, appendReceipt }) {
  const deadline = now() + timeoutMs;
  // First check immediately in case a reply arrived synchronously.
  while (true) {
    const done = checkMessageWait(mb, { messageId, fromIds, toIds, now: now(), settings });
    if (done) {
      if (done.messageStatus === "unresolved" || done.messageStatus === "expired") {
        await recordStatusTransition(mb, mb.getMessage({ messageId }), { now: now(), settings, host, appendReceipt });
      }
      if (done.replyRow) {
        // The wait consumed this reply: it counts as delivered (and
        // acknowledged), so the sender's channel, hook and inbox do not
        // deliver it a second time.
        consumeReply(mb, done.replyRow);
      }
      return {
        received: Boolean(done.replyRow),
        outcome: done.outcome,
        messageStatus: done.messageStatus,
        // The reply is another agent's text: it reaches the caller only
        // inside the peer envelope, never as a raw body.
        reply: done.replyRow ? mailboxRowResult(done.replyRow) : null
      };
    }
    if (now() >= deadline) {
      return { received: false, outcome: "timeout", messageStatus: messageStatusOf(mb, messageId, now(), settings), reply: null };
    }
    const remaining = deadline - now();
    await sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, Math.max(remaining, 10)));
  }
}

/** @param {(() => any) | null} resolve */
function resolveCurrentSessionSafe(resolve) {
  try {
    return typeof resolve === "function" ? resolve() : null;
  } catch {
    return null;
  }
}

function messageStatusOf(mb, messageId, at, settings) {
  const row = mb.getMessage({ messageId });
  return row ? messageStatus(row, { now: at, settings }).status : null;
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
