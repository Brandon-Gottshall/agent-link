// src/codex/thread-messaging.js
//
// message_codex_thread and what it shares with the other Codex write tools:
// the peer-envelope input point, action receipts, reply confirmation and its
// envelope, and the existing-thread override check (moved from src/server.js
// in PR B5, unchanged). Built by a factory taking the app-server client and
// the host; nothing runs at import time.

import { realpathSync } from "node:fs";
import path from "node:path";
import { asUserTextInput } from "./app-server-client.js";
import { codexThreadDeepLink } from "./desktop-routing.js";
import { recentItemWindow, summarizeTurn } from "./thread-summary.js";
import {
  activeTurnWarning,
  buildStateContract,
  extractFinalResponse,
  inferArchiveState,
  isRiskyParallelStatus
} from "./thread-utils.js";
import { resolveCallerIdentity } from "../claude/identity.js";
import { clampInt as clamp, optionalString, requiredString } from "../shared/args.js";
import {
  assertPeerBodyWithinLimit,
  isRuntimeIdentitySource,
  newPeerMessageId,
  normalizePeerMessage,
  peerMessageResult,
  renderPeerEnvelope
} from "../shared/envelope.js";
import { codexAddress, hostIdentity, isAddress, parseAddress } from "../shared/identity.js";
import { AgentLinkError } from "../shared/errors.js";
import { buildReceipt, listReceipts as defaultListReceipts, normalizeReceiptInput, safeAppendReceipt } from "../shared/receipt-index.js";
import { LIMITS } from "../server/schemas.js";
import { looksLikeRoleAddress, procedureProblemWarning } from "../registry/roles.js";
import { assertNoClaudeOverrides, decideTargetOverrides, overrideDeniedError } from "../delivery/override-policy.js";
import { checkRoleAddressing } from "../delivery/role-policy.js";

/** @typedef {import("./thread-queries.js").AppServerLike} AppServerLike */
/** @typedef {import("./thread-queries.js").WaitReadArgs} WaitReadArgs */
/** @typedef {import("./thread-queries.js").WaitReadResult} WaitReadResult */

/**
 * What a tool handler receives besides its arguments (src/server/registry.js).
 * @typedef {{callerContext?: any}} ToolContext
 */

/**
 * The outcome of tryWaitForReply: a wait result, or why it failed.
 * @typedef {(WaitReadResult & {ok: true}) | {
 *   ok: false,
 *   waitedMs: null,
 *   timedOut: null,
 *   thread: null,
 *   error: string,
 *   details: any,
 *   unsupported: boolean,
 *   hint: string | null
 * }} ReplyWait
 */

/**
 * @typedef {{
 *   action: string,
 *   receipt?: any,
 *   target?: Record<string, any> | null,
 *   message?: string | null,
 *   finalResponse?: string | null,
 *   delivery?: Record<string, any> | null,
 *   replyConfirmation?: Record<string, any> | null,
 *   evidence?: Record<string, any> | null,
 *   runtimeCallerContext?: any,
 *   appServer?: any,
 *   extra?: Record<string, any> | null,
 *   tags?: string[]
 * }} ActionReceiptInput
 */

/**
 * @typedef {{
 *   appServer: AppServerLike,
 *   host: string,
 *   resolveCurrentSession: () => any,
 *   roles?: import("../registry/roles.js").RoleStore | null,
 *   listReceipts?: (options: Record<string, any>) => Promise<{data: any[]}>,
 *   queries: {
 *     waitForThreadRead: (args: WaitReadArgs) => Promise<WaitReadResult>,
 *     enrichThreadLookupError: (error: any, threadId: string) => Promise<any>,
 *     inferActiveTurnId: (threadId: string) => Promise<string | null>
 *   }
 * }} ThreadMessagingDeps
 */

/**
 * @param {any} status
 * @param {string} mode
 */
export function warningsForMessageTarget(status, mode) {
  if (!isRiskyParallelStatus(status)) {
    return [];
  }
  return [activeTurnWarning(status, mode)];
}

/**
 * @param {ReplyWait | null} wait
 * @param {string} targetTurnId
 * @param {number} [recentItemsLimit]
 */
export function buildReplyConfirmation(wait, targetTurnId, recentItemsLimit = 10) {
  if (!wait) {
    return {
      waited: false
    };
  }
  if (wait.ok === false) {
    return {
      waited: true,
      ok: false,
      timedOut: wait.timedOut,
      turnStatus: null,
      finalResponse: null,
      finalResponseItem: null,
      error: wait.error,
      details: wait.details,
      unsupported: wait.unsupported,
      hint: wait.hint
    };
  }
  const finalResponse = extractFinalResponse(wait.thread, targetTurnId);
  const hasFinalResponse = typeof finalResponse.text === "string" && finalResponse.text.trim().length > 0;
  return {
    waited: true,
    ok: hasFinalResponse,
    timedOut: wait.timedOut,
    turnStatus: finalResponse.turnStatus,
    finalResponse: finalResponse.text,
    finalResponseItem: finalResponse,
    waitState: wait.waitState ?? null,
    warnings: wait.waitState?.warnings ?? [],
    recentItems: recentItemWindow(wait.thread?.turns ?? [], clamp(recentItemsLimit, 0, LIMITS.replyRecentItems.max)).items,
    error: hasFinalResponse ? null : "No final agent response text was found in the completed target turn.",
    hint: hasFinalResponse
      ? null
      : "Delivery/completion was observed, but this does not prove the target agent responded with text. Inspect the target turn or retry with a prompt that requires a final answer."
  };
}

// The target thread's answer is another agent's text handed back to the
// caller, so it is enveloped like any peer message (design section 2):
// `finalResponse` becomes the envelope, `finalResponseItem` and `recentItems`
// lose their text fields, and the recent items' text is returned as one
// envelope in `recentItemsEnvelope`. The sender is the target thread as the
// app-server reports it.
const RECENT_ITEM_TEXT_FIELDS = ["text", "summary", "command", "agentsStates"];

/**
 * @param {Record<string, any>} confirmation  from buildReplyConfirmation
 * @param {{threadId: string, sent?: {from?: string, messageId?: string} | null}} options
 * @returns {Record<string, any>}
 */
export function envelopeReplyConfirmation(confirmation, { threadId, sent }) {
  if (!confirmation?.waited) return confirmation;
  const base = {
    from: threadId,
    fromHarness: "codex",
    fromVerified: true,
    to: sent?.from,
    inReplyTo: sent?.messageId,
    reply: "direct"
  };
  /** @type {Record<string, any>} */
  const out = { ...confirmation, enveloped: true };
  if (typeof confirmation.finalResponse === "string" && confirmation.finalResponse) {
    const message = { ...base, id: newPeerMessageId(), sentAt: Date.now(), body: confirmation.finalResponse };
    out.finalResponse = renderPeerEnvelope(message);
    out.reply = peerMessageResult(message, { includeEnvelope: false });
  }
  if (confirmation.finalResponseItem && typeof confirmation.finalResponseItem === "object") {
    const { text: _text, ...rest } = confirmation.finalResponseItem;
    out.finalResponseItem = rest;
  }
  if (confirmation.waitState?.finalResponse && typeof confirmation.waitState.finalResponse === "object") {
    const { text: _text, ...rest } = confirmation.waitState.finalResponse;
    out.waitState = { ...confirmation.waitState, finalResponse: rest };
  }
  if (Array.isArray(confirmation.recentItems)) {
    out.recentItems = confirmation.recentItems.map((item) => {
      const kept = { ...item };
      for (const field of RECENT_ITEM_TEXT_FIELDS) delete kept[field];
      return kept;
    });
    const transcript = confirmation.recentItems.map(recentItemLine).filter(Boolean).join("\n");
    out.recentItemsEnvelope = transcript
      ? renderPeerEnvelope({ ...base, id: newPeerMessageId(), sentAt: Date.now(), body: transcript })
      : null;
  }
  return out;
}

// replyConfirmation in the section 3.4 wait shape. The 0.4 key stays beside
// it until 0.6.0.
/**
 * @param {Record<string, any>} confirmation  from envelopeReplyConfirmation
 * @param {{threadId: string, turnId: string, waitedMs?: number | null}} options
 */
export function waitOutcome(confirmation, { threadId, turnId, waitedMs }) {
  if (Object.prototype.hasOwnProperty.call(confirmation, "unsupported")) {
    return {
      outcome: "unavailable",
      waitedMs: waitedMs ?? null,
      target: { threadId, address: codexAddress(threadId) },
      error: confirmation.error,
      ...(confirmation.hint ? { hint: confirmation.hint } : {})
    };
  }
  if (confirmation.timedOut === true) {
    return { outcome: "timeout", waitedMs: waitedMs ?? null, target: { threadId, address: codexAddress(threadId) } };
  }
  return {
    outcome: "turn_completed",
    waitedMs: waitedMs ?? null,
    target: { threadId, address: codexAddress(threadId) },
    turn: {
      turnId,
      status: confirmation.turnStatus ?? null,
      finalResponse: confirmation.finalResponse ?? null,
      completedAt: null
    },
    ...(confirmation.reply ? { reply: confirmation.reply } : {}),
    ...(Array.isArray(confirmation.recentItems) ? { recentItems: confirmation.recentItems } : {}),
    ...(confirmation.recentItemsEnvelope !== undefined ? { recentItemsEnvelope: confirmation.recentItemsEnvelope } : {})
  };
}

/**
 * @param {Record<string, any>} item  a summarized item
 * @returns {string}
 */
export function recentItemLine(item) {
  const text = typeof item.text === "string" ? item.text
    : Array.isArray(item.summary) ? item.summary.join(" / ")
      : typeof item.command === "string" ? `$ ${item.command}`
        : "";
  return text ? `[${item.type ?? "item"} ${item.id ?? ""}] ${text}` : "";
}

// Which caller-supplied cwd/model/effort values reach an existing thread is
// decided by src/delivery/override-policy.js (design doc section 9.2): equal
// values are forwarded, the launcher may change effort, everything else needs
// the target's override policy, and allowTargetOverride grants nothing.

// Compare directories by real path when both exist (macOS /tmp is
// /private/tmp), else lexically.
/**
 * @param {string} a
 * @param {string} b
 */
export function sameDirectory(a, b) {
  const canonical = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return canonical(a) === canonical(b);
}

/**
 * @param {ThreadMessagingDeps} deps
 */
export function makeThreadMessaging({ appServer, host, resolveCurrentSession, queries, roles = null, listReceipts = defaultListReceipts }) {
  const { waitForThreadRead, enrichThreadLookupError, inferActiveTurnId } = queries;

  /**
   * The caller's address from runtime identity only (R1.4).
   * @param {ToolContext} [toolContext]
   */
  function callerAddress(toolContext = {}) {
    return hostIdentity({ host, callerContext: toolContext.callerContext ?? null, currentSession: resolveCurrentSession }).address;
  }

  /**
   * The session that launched a thread through Agent Link (R9.9), or null.
   * A launch receipt that has a `launchedBy` key decides alone: an address
   * is the launcher, null (an external caller) means none. Only launch
   * receipts written before launchedBy existed fall back to their origin
   * thread, and only when a Codex-host server took it from the runtime
   * caller context; caller-supplied and environment origins, and receipts
   * written by a Claude-host server, never make a launcher.
   * @param {string} threadId
   * @returns {Promise<string | null>}
   */
  async function launcherOf(threadId) {
    let data = [];
    try {
      data = (await listReceipts({ targetThreadId: threadId, action: "launch_thread", limit: 20 })).data ?? [];
    } catch {
      return null;
    }
    for (const receipt of data) {
      if (Object.prototype.hasOwnProperty.call(receipt, "launchedBy")) {
        return isAddress(receipt.launchedBy) ? receipt.launchedBy : null;
      }
      if (receipt.host === "codex" && receipt.origin?.sources?.threadId === "runtime_context") {
        const origin = codexAddress(receipt.origin?.threadId);
        if (origin) return origin;
      }
    }
    return null;
  }

  /**
   * Resolves `role:<name>` in threadId to the Codex thread holding it.
   * @param {string} rawTarget
   * @param {Record<string, any>} args
   */
  function resolveRoleTarget(rawTarget, args) {
    if (!looksLikeRoleAddress(rawTarget)) return { threadId: rawTarget, role: null };
    if (!roles) {
      throw new AgentLinkError("unsupported", "Role addresses are not available on this server.", { details: { capability: "roles" } });
    }
    const role = roles.resolve(rawTarget);
    const parsed = parseAddress(role.address);
    if (parsed?.harness !== "codex") {
      assertNoClaudeOverrides(args, role.address);
      throw new AgentLinkError("invalid_arguments", `Role ${role.role} is held by ${role.address}, a Claude session; message_codex_thread only reaches Codex threads.`, {
        details: { errors: [{ path: "threadId", rule: "harness", expected: "a role held by a codex: thread" }], role: role.role, address: role.address },
        hint: `Call message_claude_session with sessionId="role:${role.role}".`
      });
    }
    return { threadId: parsed.id, role };
  }

  /**
   * @param {Record<string, any>} args
   * @param {ToolContext} [toolContext]
   */
  async function messageThreadTool(args, toolContext = {}) {
    return await messageThread(args, toolContext);
  }

  /**
   * @param {Record<string, any>} args
   * @param {ToolContext} [toolContext]
   * @returns {Promise<Record<string, any>>}
   */
  async function messageThread(args, toolContext = {}) {
    const { threadId, role } = resolveRoleTarget(requiredString(args.threadId, "threadId").trim(), args);
    const message = requiredString(args.message, "message").trim();
    if (!message) {
      throw new AgentLinkError("invalid_arguments", "message must not be empty.", {
        details: { errors: [{ path: "message", rule: "required", expected: "non-empty string" }] }
      });
    }
    assertPeerBodyWithinLimit(message);

    const mode = args.mode ?? "auto";
    const resumeIfNeeded = args.resumeIfNeeded ?? true;
    const allowParallelTurn = args.allowParallelTurn === true;
    let read;
    try {
      read = await appServer.request("thread/read", { threadId, includeTurns: false });
    } catch (error) {
      throw await enrichThreadLookupError(error, threadId);
    }
    const initialThread = read.thread;
    const targetAddress = /** @type {string} */ (codexAddress(threadId));
    const senderAddress = callerAddress(toolContext);
    const tableRead = roles?.read() ?? null;
    const rolesOf = (/** @type {string} */ address) => (roles && tableRead && !tableRead.error ? roles.rolesOf(address, tableRead.table) : []);

    // Role addressing between persistent agents (R1.23), before anything is sent.
    const enforcement = roles && tableRead ? roles.enforcement(tableRead) : { mode: "off", source: "default" };
    const addressing = checkRoleAddressing({ mode: enforcement.mode, senderAddress, targetAddress, via: role?.via ?? null, isReply: false, rolesOf });

    // turn/steer ignores cwd/model/effort, so a mismatch there is only a warning.
    const willSteer = mode === "steer_active" || (mode === "auto" && initialThread?.status?.type === "active");
    const launcher = !willSteer && optionalString(args.effort).trim() ? await launcherOf(threadId) : null;
    const decision = decideTargetOverrides({
      thread: initialThread,
      args,
      steering: willSteer,
      parties: { senderAddress, senderRoles: rolesOf(senderAddress), targetAddress, targetRoles: rolesOf(targetAddress) },
      policy: tableRead && !tableRead.error ? tableRead.table.overridePolicy : {},
      launcher
    });
    if (decision.denied) throw overrideDeniedError(decision.denied, threadId);
    const overrides = decision.forward;
    let status = read.thread.status;
    let action = null;
    const warnings = [
      ...decision.warnings,
      ...(addressing.warning ? [addressing.warning] : []),
      ...warningsForMessageTarget(status, mode)
    ];

    if (status.type === "notLoaded") {
      if (!resumeIfNeeded) {
        throw new AgentLinkError("active_turn_conflict", `Thread ${threadId} is not loaded and resumeIfNeeded is false.`, {
          details: { status: "notLoaded", activeTurnId: null },
          hint: "Pass resumeIfNeeded=true (the default) to resume the thread before messaging it."
        });
      }
      /** @type {Record<string, any>} */
      const resumeParams = {
        threadId,
        excludeTurns: true,
        persistExtendedHistory: true
      };
      if (overrides.cwd) {
        resumeParams.cwd = overrides.cwd;
      }
      if (overrides.model) {
        resumeParams.model = overrides.model;
      }
      if (overrides.effort) {
        resumeParams.reasoningEffort = overrides.effort;
      }
      read = await appServer.request("thread/resume", resumeParams);
      status = read.thread.status;
      action = "resumed";
      warnings.push(...warningsForMessageTarget(status, mode));
    }

    const steering = mode === "steer_active" || (mode === "auto" && status.type === "active");
    // R1.20: the procedure text goes with the first delivery of each version
    // to the holder; a failed send releases the claim.
    const procedure = role?.procedure ?? null;
    const procedureClaim = procedure ? { role: procedure.name, sha256: procedure.sha256, address: targetAddress } : null;
    const withText = procedureClaim && roles ? roles.claimProcedureDelivery(procedureClaim) : false;
    const roleFields = role
      ? { via: role.via, procedure: procedure ? { name: procedure.name, version: procedure.version, ...(withText ? { text: procedure.text } : {}) } : null }
      : null;
    // turn/steer ignores cwd/model/effort, so only a new turn shows overrides.
    const peer = buildPeerTurnInput({
      toolContext,
      threadId,
      message,
      overrides: steering ? null : overrides,
      // R7.2 default label. Codex sends get anticipation/replyBy arguments
      // and mailbox records in B7b; until then the reply line stays direct.
      anticipation: args.waitForReply === true ? "reply" : "fyi",
      role: roleFields
    });
    const input = peer.input;
    const roleResult = role
      ? { via: role.via, roleProcedure: procedure ? { name: procedure.name, version: procedure.version, textIncluded: withText } : null }
      : {};
    // A procedure file that was refused (symlink, FIFO, over 64 KiB) is reported, not silently skipped.
    const procedureWarning = procedureProblemWarning(role);
    if (procedureWarning) warnings.push(procedureWarning);
    const receiptExtra = role
      ? {
          via: role.via,
          roleProcedure: procedure ? { name: procedure.name, version: procedure.version } : null,
          ...(procedureWarning ? { roleProcedureWarning: procedureWarning.details } : {})
        }
      : null;
    const receiptTags = addressing.tag ? [addressing.tag] : [];
    const releaseClaim = () => {
      if (withText && procedureClaim && roles) roles.releaseProcedureDelivery(procedureClaim);
    };
    /** @param {unknown} error */
    const releaseOnFailure = (error) => {
      releaseClaim();
      throw error;
    };
    if (steering) {
      const expectedTurnId = args.expectedTurnId || await inferActiveTurnId(threadId).catch(releaseOnFailure);
      if (!expectedTurnId) {
        releaseClaim();
        throw new AgentLinkError("active_turn_conflict", "Cannot steer the active thread without expectedTurnId or an inferable in-progress turn.", {
          details: { status: status?.type ?? null, activeTurnId: null },
          hint: "Pass expectedTurnId, or use mode=start_turn with allowParallelTurn=true."
        });
      }
      const response = await appServer.request("turn/steer", {
        threadId,
        input,
        expectedTurnId
      }).catch(releaseOnFailure);
      const wait = args.waitForReply
        ? await tryWaitForReply({
            threadId,
            targetTurnId: response.turnId,
            timeoutMs: args.timeoutMs,
            pollIntervalMs: args.pollIntervalMs
          })
        : null;
      const appServerSummary = appServer.getConnectionSummary();
      const actionName = action ? `${action}+steered_active_turn` : "steered_active_turn";
      const replyConfirmation = envelopeReplyConfirmation(buildReplyConfirmation(wait, response.turnId, args.recentItems ?? LIMITS.replyRecentItems.def), { threadId, sent: peer.summary });
      /** @type {Record<string, any>} */
      const result = {
        ok: true,
        messageId: peer.summary.messageId,
        deliveredVia: "turn/steer",
        target: { threadId, address: codexAddress(threadId) },
        turn: { id: response.turnId },
        ...roleResult,
        ...(wait ? { wait: waitOutcome(replyConfirmation, { threadId, turnId: response.turnId, waitedMs: wait.waitedMs }) } : {}),
        source: "app-server",
        action: actionName,
        previousStatus: status,
        threadId,
        turnId: response.turnId,
        peerMessage: peer.summary,
        warnings,
        ...buildStateContract({
          action: actionName,
          initialThread,
          beforeSendThread: read.thread,
          turnId: response.turnId,
          appServer: appServerSummary
        }),
        replyConfirmation,
        appServer: appServerSummary
      };
      result.receipt = await recordActionReceipt({
        action: "message_thread",
        receipt: args.receipt,
        target: {
          threadId,
          address: codexAddress(threadId),
          turnId: response.turnId,
          name: read.thread.name,
          cwd: read.thread.cwd,
          archiveState: inferArchiveState(read.thread),
          status: read.thread.status,
          deepLink: codexThreadDeepLink(threadId)
        },
        message,
        finalResponse: replyConfirmation.finalResponse,
        delivery: result.delivery,
        replyConfirmation,
        runtimeCallerContext: toolContext.callerContext,
        appServer: appServerSummary,
        extra: receiptExtra,
        tags: receiptTags
      });
      return result;
    }

    if (isRiskyParallelStatus(status) && !allowParallelTurn) {
      releaseClaim();
      throw new AgentLinkError("active_turn_conflict", "Target thread has an active or waiting turn, and this request would start another turn.", {
        details: { status: status?.type ?? null, activeTurnId: await inferActiveTurnId(threadId).catch(() => null), warnings },
        hint: "Use mode=steer_active when possible, or set allowParallelTurn=true to intentionally start a parallel turn."
      });
    }

    /** @type {Record<string, any>} */
    const startParams = { threadId, input };
    if (overrides.cwd) {
      startParams.cwd = overrides.cwd;
    }
    if (overrides.model) {
      startParams.model = overrides.model;
    }
    if (overrides.effort) {
      startParams.effort = overrides.effort;
    }

    const response = await appServer.request("turn/start", startParams).catch(releaseOnFailure);
    const summarizedTurn = summarizeTurn(response.turn);
    const wait = args.waitForReply
      ? await tryWaitForReply({
          threadId,
          targetTurnId: summarizedTurn.id,
          timeoutMs: args.timeoutMs,
          pollIntervalMs: args.pollIntervalMs
        })
      : null;
    const appServerSummary = appServer.getConnectionSummary();
    const actionName = action ? `${action}+started_turn` : "started_turn";
    const replyConfirmation = envelopeReplyConfirmation(buildReplyConfirmation(wait, summarizedTurn.id, args.recentItems ?? LIMITS.replyRecentItems.def), { threadId, sent: peer.summary });
    /** @type {Record<string, any>} */
    const result = {
      ok: true,
      messageId: peer.summary.messageId,
      deliveredVia: "turn/start",
      target: { threadId, address: codexAddress(threadId) },
      ...roleResult,
      ...(decision.switches.length ? { switches: decision.switches.map(switchResult) } : {}),
      ...(wait ? { wait: waitOutcome(replyConfirmation, { threadId, turnId: summarizedTurn.id, waitedMs: wait.waitedMs }) } : {}),
      source: "app-server",
      action: actionName,
      previousStatus: status,
      threadId,
      turn: summarizedTurn,
      peerMessage: peer.summary,
      warnings,
      ...buildStateContract({
        action: actionName,
        initialThread,
        beforeSendThread: read.thread,
        turn: summarizedTurn,
        appServer: appServerSummary
      }),
      replyConfirmation,
      appServer: appServerSummary
    };
    result.receipt = await recordActionReceipt({
      action: "message_thread",
      receipt: args.receipt,
      target: {
        threadId,
        address: codexAddress(threadId),
        turnId: summarizedTurn.id,
        name: read.thread.name,
        cwd: read.thread.cwd,
        archiveState: inferArchiveState(read.thread),
        status: read.thread.status,
        deepLink: codexThreadDeepLink(threadId)
      },
      message,
      finalResponse: replyConfirmation.finalResponse,
      delivery: result.delivery,
      replyConfirmation,
      runtimeCallerContext: toolContext.callerContext,
      appServer: appServerSummary,
      extra: receiptExtra,
      tags: receiptTags
    });
    // R9.4/R9.10: every applied switch persists (no revert is ever sent) and
    // gets its own receipt.
    if (decision.switches.length) {
      result.switchReceipts = [];
      for (const change of decision.switches) {
        result.switchReceipts.push(await recordActionReceipt({
          action: change.kind.replace("-", "_"),
          receipt: args.receipt,
          target: { threadId, address: targetAddress, turnId: summarizedTurn.id, name: read.thread.name, cwd: read.thread.cwd },
          message: null,
          runtimeCallerContext: toolContext.callerContext,
          appServer: appServerSummary,
          extra: {
            override: {
              kind: change.kind,
              address: targetAddress,
              setting: change.field,
              previous: change.previous,
              current: change.current,
              by: senderAddress,
              grantedBy: change.grantedBy,
              policy: change.policy,
              expectedCost: change.expectedCost,
              tokenUsage: { next: null }
            }
          }
        }));
      }
    }
    return result;
  }

  /**
   * The result entry for one applied switch (R9.4).
   * @param {import("../delivery/override-policy.js").OverrideSwitch} change
   */
  function switchResult(change) {
    return {
      setting: change.field,
      previous: change.previous,
      current: change.current,
      grantedBy: change.grantedBy,
      ...(change.policy ? { policy: change.policy } : {}),
      persists: true,
      expectedCost: change.expectedCost
    };
  }

  // The single Codex input point for another agent's text (design doc section
  // 2): message_codex_thread (turn/start and turn/steer), launch_codex_thread
  // with a message, and the project-orchestrator and dependency-handoff tools
  // built on those two. The text becomes a user-role turn on the target, so it
  // is always wrapped in the peer envelope. The sender comes from runtime
  // identity (caller _meta, then host env), never from tool arguments.
  /**
   * @param {{toolContext?: ToolContext, threadId: string, message: string, overrides?: Record<string, any> | null, anticipation?: string, role?: {via: string, procedure: {name: string, version: number, text?: string} | null} | null}} options
   */
  function buildPeerTurnInput({ toolContext = {}, threadId, message, overrides = null, anticipation = "fyi", role = null }) {
    const caller = resolveCallerIdentity({
      host,
      runtimeCallerContext: toolContext.callerContext ?? null,
      currentSession: resolveCurrentSession
    });
    const peer = {
      id: newPeerMessageId(),
      from: caller.id,
      fromHarness: caller.kind,
      fromVerified: isRuntimeIdentitySource(caller.source),
      to: threadId,
      toHarness: "codex",
      sentAt: Date.now(),
      anticipation,
      body: message,
      overrides,
      reply: "direct",
      ...(role ? { via: role.via, procedure: role.procedure } : {})
    };
    const fields = normalizePeerMessage(peer);
    return {
      input: asUserTextInput(renderPeerEnvelope(peer)),
      summary: {
        messageId: fields.id,
        from: fields.from,
        fromHarness: fields.fromHarness,
        fromVerified: fields.fromVerified,
        sentAt: fields.sentAt,
        enveloped: true
      }
    };
  }

  /**
   * @param {ActionReceiptInput} input
   */
  async function recordActionReceipt({ action, receipt, target, message, finalResponse, delivery, replyConfirmation, evidence, runtimeCallerContext, appServer: appServerSummary, extra = null, tags = [] }) {
    const receiptInput = normalizeReceiptInput(receipt, { runtimeCallerContext });
    if (receiptInput.record === false) {
      return {
        ok: true,
        recorded: false,
        reason: "receipt.record was false"
      };
    }

    // Codex thread tools (launch/message/archive) all target Codex sessions.
    // Stamp host so Claude-host callers' receipts identify their origin host,
    // and target.kind=codex so receipts can be queried by the kind of session
    // the action reached. Existing fields on `target` win when explicitly
    // supplied.
    const targetWithKind = { kind: "codex", ...(target ?? {}) };

    const built = buildReceipt({
      action,
      receipt: receiptInput,
      host,
      target: targetWithKind,
      message,
      finalResponse,
      delivery,
      replyConfirmation,
      evidence,
      runtimeCallerContext,
      appServer: appServerSummary
    });
    const stored = {
      ...built,
      ...(extra ?? {}),
      ...(tags.length ? { tags: [...new Set([...(built.tags ?? []), ...tags])] } : {})
    };
    return {
      recorded: true,
      ...await safeAppendReceipt(stored)
    };
  }

  /**
   * @param {WaitReadArgs} args
   * @returns {Promise<ReplyWait>}
   */
  async function tryWaitForReply(args) {
    try {
      const wait = await waitForThreadRead(args);
      return {
        ok: true,
        ...wait
      };
    } catch (error) {
      const unsupportedEphemeral = /ephemeral threads do not support includeTurns/i.test(error.message);
      return {
        ok: false,
        waitedMs: null,
        timedOut: null,
        thread: null,
        error: error.message,
        details: error.details ?? null,
        unsupported: unsupportedEphemeral,
        hint: unsupportedEphemeral
          ? "The message was delivered, but reply confirmation could not inspect this ephemeral thread. Use a non-ephemeral disposable thread when waitForReply evidence is required."
          : null
      };
    }
  }

  return { messageThread, messageThreadTool, buildPeerTurnInput, recordActionReceipt, tryWaitForReply, callerAddress, launcherOf };
}
