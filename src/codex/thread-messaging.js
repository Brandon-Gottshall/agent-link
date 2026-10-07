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
import { openMailbox } from "../claude/mailbox.js";
import { registerActiveWait } from "../claude/active-waits.js";
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
  peerMessageFromMailbox,
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
import { expectedCostFrom, lastRecordedUsage, settingsMismatchWarning, tokenUsageUnavailableWarning } from "./token-usage.js";
import { codexTurnText, desktopPushPolicy, pushCodexMessage } from "../delivery/codex-push.js";
import { messageStatus, reminderSettings, resolveLabels } from "../delivery/message-status.js";
import { pollMessageResolution } from "../delivery/message-wait.js";
import { resolveByAnswer } from "../delivery/resolution.js";
import { readRoleTable, recipientMatcher } from "../delivery/role-handover.js";
import { storedAddress } from "../registry/addresses.js";

/** @typedef {import("./thread-queries.js").AppServerLike} AppServerLike */
/** @typedef {import("./thread-queries.js").WaitReadArgs} WaitReadArgs */
/** @typedef {import("./thread-queries.js").WaitReadResult} WaitReadResult */

/**
 * What a tool handler receives besides its arguments (src/server/registry.js).
 * @typedef {{callerContext?: any, roleVia?: string, answeredKind?: "reply" | "done"}} ToolContext
 *   roleVia: set only by the orchestrator tools when the target came from
 *   the role table (R1.21), never from tool arguments
 *   answeredKind: how replyToMessageId resolves the answered message: reply
 *   (default) or done (return_project_work_result, R7.7)
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
 *   tokenUsage?: import("./token-usage.js").TokenUsageTracker | null,
 *   mailboxOpener?: () => ReturnType<typeof openMailbox>,
 *   pushPolicy?: () => import("../delivery/codex-push.js").DesktopPushPolicy,
 *   tracker?: import("../delivery/codex-push.js").ThreadStatusTracker | null,
 *   rolloutCheck?: import("../delivery/codex-push.js").RolloutCheck | null,
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

// The reply confirmation in the section 3.4 wait shape (the 0.4
// `replyConfirmation` result key was removed in 0.6.0).
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
export function makeThreadMessaging({ appServer, host, resolveCurrentSession, queries, roles = null, listReceipts = defaultListReceipts, tokenUsage = null, mailboxOpener, pushPolicy = () => desktopPushPolicy(), tracker = null, rolloutCheck = null }) {
  const { waitForThreadRead, enrichThreadLookupError, inferActiveTurnId } = queries;
  const openMb = typeof mailboxOpener === "function" ? mailboxOpener : () => openMailbox();

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
      // A fork's launcher is the caller of fork_codex_thread (R9.9).
      if (!data.length) data = (await listReceipts({ targetThreadId: threadId, action: "fork_thread", limit: 20 })).data ?? [];
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
    const holdingsOf = (/** @type {string} */ address) => (roles && tableRead && !tableRead.error ? roles.holdings(address, tableRead.table) : { roles: [], projectRoots: [] });
    const via = role?.via ?? (typeof toolContext.roleVia === "string" && toolContext.roleVia.startsWith("role:") ? toolContext.roleVia : null);
    const addressing = checkRoleAddressing({ mode: enforcement.mode, senderAddress, targetAddress, via, isReply: false, rolesOf, holdingsOf });

    // turn/steer ignores cwd/model/effort, so a mismatch there is only a warning.
    const willSteer = mode === "steer_active" || (mode === "auto" && initialThread?.status?.type === "active");
    const launcher = !willSteer && optionalString(args.effort).trim() ? await launcherOf(threadId) : null;
    // R9.3/R9.4: an in-place model or effort switch reports the last turn's
    // input tokens as its expected cost, when a receipt or notification
    // recorded them (a cwd change is cache-neutral, B7 spike).
    const switchCandidate = !willSteer && ["model", "modelProvider", "serviceTier", "effort"].some((field) => optionalString(args[field]).trim());
    const expectedCost = switchCandidate
      ? expectedCostFrom(await lastRecordedUsage({ threadId, tracker: tokenUsage, listReceipts }))
      : undefined;
    const decision = decideTargetOverrides({
      thread: initialThread,
      args,
      steering: willSteer,
      parties: { senderAddress, senderRoles: rolesOf(senderAddress), targetAddress, targetRoles: rolesOf(targetAddress) },
      policy: tableRead && !tableRead.error ? tableRead.table.overridePolicy : {},
      launcher,
      ...(expectedCost ? { expectedCost } : {})
    });
    if (decision.denied) throw overrideDeniedError(decision.denied, threadId);
    const overrides = decision.forward;
    const status = read.thread.status;
    const warnings = [
      ...decision.warnings,
      ...(addressing.warning ? [addressing.warning] : []),
      ...warningsForMessageTarget(status, mode)
    ];
    // Labels (R7.1, R7.2): validated before anything is written or sent.
    const labels = resolveLabels({ anticipation: args.anticipation, replyBy: args.replyBy, waitForReply: args.waitForReply === true, now: Date.now() });

    // The plan, decided before the mailbox write so that a conflict writes
    // nothing. A thread held by the desktop app gets no turn (R1.12a).
    const held = pushPolicy().isHeld(status);
    if (status?.type === "notLoaded" && !held && !resumeIfNeeded) {
      throw new AgentLinkError("active_turn_conflict", `Thread ${threadId} is not loaded and resumeIfNeeded is false.`, {
        details: { status: "notLoaded", activeTurnId: null },
        hint: "Pass resumeIfNeeded=true (the default) to resume the thread before messaging it."
      });
    }
    const steering = !held && (mode === "steer_active" || (mode === "auto" && status?.type === "active"));
    let expectedTurnId = null;
    if (steering) {
      expectedTurnId = args.expectedTurnId || await inferActiveTurnId(threadId);
      if (!expectedTurnId) {
        throw new AgentLinkError("active_turn_conflict", "Cannot steer the active thread without expectedTurnId or an inferable in-progress turn.", {
          details: { status: status?.type ?? null, activeTurnId: null },
          hint: "Pass expectedTurnId, or use mode=start_turn with allowParallelTurn=true."
        });
      }
    } else if (!held && isRiskyParallelStatus(status) && !allowParallelTurn) {
      throw new AgentLinkError("active_turn_conflict", "Target thread has an active or waiting turn, and this request would start another turn.", {
        details: { status: status?.type ?? null, activeTurnId: await inferActiveTurnId(threadId).catch(() => null), warnings },
        hint: "Use mode=steer_active when possible, or set allowParallelTurn=true to intentionally start a parallel turn."
      });
    }

    // R1.20: the procedure text goes with the first send of each version to
    // the holder, in the mailbox record; a failed write releases the claim.
    const procedure = role?.procedure ?? null;
    const roleResult = role
      ? { via: role.via, roleProcedure: procedure ? { name: procedure.name, version: procedure.version, textIncluded: false } : null }
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
      : {};
    const receiptTags = addressing.tag ? [addressing.tag] : [];

    // turn/steer ignores cwd/model/effort, so only a new turn carries (and
    // shows) overrides.
    const turnOverrides = steering || held ? {} : overrides;
    /** @type {Record<string, any>} */
    const startParams = {};
    for (const field of ["cwd", "model", "effort"]) {
      if (turnOverrides[field]) startParams[field] = turnOverrides[field];
    }
    /** @type {Record<string, any> | null} */
    let resume = null;
    if (status?.type === "notLoaded" && !held) {
      resume = { threadId, excludeTurns: true, persistExtendedHistory: true };
      if (turnOverrides.cwd) resume.cwd = turnOverrides.cwd;
      if (turnOverrides.model) resume.model = turnOverrides.model;
      if (turnOverrides.effort) resume.reasoningEffort = turnOverrides.effort;
    }

    // thread/settings/updated follows only a turn/start that changes settings.
    const settingsMark = tokenUsage?.mark() ?? 0;
    const sent = await sendToThread({
      toolContext,
      threadId,
      message,
      labels,
      replyToMessageId: args.replyToMessageId,
      answeredKind: toolContext.answeredKind === "done" ? "done" : "reply",
      role,
      overrides: turnOverrides,
      receipt: args.receipt,
      plan: held ? "held" : steering ? "steer" : "start",
      resume,
      startParams,
      expectedTurnId,
      rolloutPath: typeof read.thread?.path === "string" ? read.thread.path : null
    });
    if (role && procedure) roleResult.roleProcedure = { name: procedure.name, version: procedure.version, textIncluded: sent.procedureTextIncluded };
    warnings.push(...sent.push.warnings);
    if (sent.answered && !sent.answer?.ok) {
      warnings.push({
        code: "not_resolved",
        message: sent.answered.fromTarget
          ? `Message ${sent.answered.id} was not resolved by this send: ${sent.answer?.reason ?? "unknown"}.`
          : `Message ${sent.answered.id} came from another session, so this send to ${targetAddress} does not resolve it.`,
        details: { messageId: sent.answered.id, reason: sent.answered.fromTarget ? sent.answer?.reason ?? null : "different_sender" }
      });
    }
    const push = sent.push;
    const delivered = push.delivery === "delivered";
    const turn = !delivered
      ? null
      : push.request === "turn/steer"
        ? { id: push.response?.turnId ?? push.response?.turn?.id ?? null }
        : summarizeTurn(push.response?.turn);
    const turnId = turn?.id ?? null;
    const action = !delivered
      ? (held ? "queued_held_thread" : "queued_push_failed")
      : push.request === "turn/steer"
        ? "steered_active_turn"
        : push.resumed ? "resumed+started_turn" : "started_turn";
    const switches = delivered && push.request === "turn/start" ? decision.switches : [];

    // R7.19: a message wait ends on an explicit resolution, never on the
    // turn completing; the turn's final response is not returned.
    const wait = args.waitForReply === true
      ? await waitForResolution({ messageId: sent.messageId, threadId, caller: sent.caller, timeoutMs: args.timeoutMs, pollIntervalMs: args.pollIntervalMs, turnId })
      : null;

    const appServerSummary = appServer.getConnectionSummary();
    const { delivery: deliveryContract, ...stateContract } = buildStateContract({
      action,
      initialThread,
      beforeSendThread: read.thread,
      ...(push.request === "turn/steer" ? { turnId } : { turn: turn ?? undefined }),
      appServer: appServerSummary
    });
    /** @type {Record<string, any>} */
    const result = {
      ok: true,
      messageId: sent.messageId,
      delivery: push.delivery,
      deliveredVia: push.deliveredVia,
      target: { threadId, address: targetAddress },
      turn,
      anticipation: labels.anticipation,
      replyBy: labels.replyBy === null ? null : new Date(labels.replyBy).toISOString(),
      messageStatus: wait ? wait.messageStatus : labels.anticipation === "fyi" ? null : "pending",
      ...roleResult,
      ...(sent.answer?.ok ? { resolved: { messageId: sent.answered?.id, kind: sent.answer.kind, late: sent.answer.late } } : {}),
      ...(switches.length ? { switches: switches.map(switchResult) } : {}),
      ...(wait ? { wait } : {}),
      source: "app-server",
      action,
      previousStatus: status,
      threadId,
      ...(push.request === "turn/steer" ? { turnId } : {}),
      peerMessage: sent.peerMessage,
      warnings,
      ...stateContract,
      deliveryState: { ...deliveryContract, state: delivered ? "accepted_by_app_server" : "queued_in_mailbox" },
      appServer: appServerSummary
    };
    result.receipt = await recordActionReceipt({
      action: "message_thread",
      receipt: args.receipt,
      target: {
        threadId,
        address: targetAddress,
        turnId,
        name: read.thread.name,
        cwd: read.thread.cwd,
        archiveState: inferArchiveState(read.thread),
        status: read.thread.status,
        deepLink: codexThreadDeepLink(threadId)
      },
      message,
      finalResponse: null,
      delivery: { state: push.delivery, deliveredVia: push.deliveredVia, request: push.request, turnId },
      replyConfirmation: null,
      runtimeCallerContext: toolContext.callerContext,
      appServer: appServerSummary,
      extra: { ...receiptExtra, messageId: sent.messageId },
      tags: receiptTags
    });
    // R9.4/R9.10: every applied switch persists (no revert is ever sent) and
    // gets its own receipt, with the token usage of the first turn on the new
    // setting (known only when the call waited).
    if (switches.length) {
      const tokenUsageNext = await firstTurnUsage({ threadId, turnId, waited: args.waitForReply === true, warnings, overrides: turnOverrides, settingsMark });
      result.switchReceipts = [];
      for (const change of switches) {
        result.switchReceipts.push(await recordActionReceipt({
          action: change.kind.replace("-", "_"),
          receipt: args.receipt,
          target: { threadId, address: targetAddress, turnId, name: read.thread.name, cwd: read.thread.cwd },
          message: null,
          runtimeCallerContext: toolContext.callerContext,
          appServer: appServerSummary,
          extra: {
            kind: change.kind,
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
              tokenUsage: tokenUsageNext
            }
          }
        }));
      }
    }
    return result;
  }

  /**
   * Mailbox first, then push (R1.10, R1.11): writes the message to the
   * mailbox addressed to codex:<threadId>, resolves the message it answers
   * (replyToMessageId), then pushes it to the thread as a turn. Shared by
   * message_codex_thread (and the orchestrator and handoff tools built on
   * it) and launch_codex_thread's first message.
   * @param {{
   *   toolContext?: ToolContext,
   *   threadId: string,
   *   message: string,
   *   labels: {anticipation: string, replyBy: number | null},
   *   replyToMessageId?: unknown,
   *   answeredKind?: "reply" | "done",
   *   role?: any,
   *   overrides?: Record<string, any> | null,
   *   receipt?: any,
   *   plan: "start" | "steer" | "held",
   *   resume?: Record<string, any> | null,
   *   startParams?: Record<string, any>,
   *   expectedTurnId?: string | null,
   *   rolloutPath?: string | null
   * }} options
   *   rolloutPath: the thread's transcript (thread/read `path`), for the
   *   deny-only "open in another process" check
   */
  async function sendToThread({ toolContext = {}, threadId, message, labels, replyToMessageId, answeredKind = "reply", role = null, overrides = null, receipt = null, plan, resume = null, startParams = {}, expectedTurnId = null, rolloutPath = null }) {
    const caller = resolveCallerIdentity({ host, runtimeCallerContext: toolContext.callerContext ?? null, currentSession: resolveCurrentSession });
    const targetAddress = /** @type {string} */ (codexAddress(threadId));
    const procedure = role?.procedure ?? null;
    const procedureClaim = procedure ? { role: procedure.name, sha256: procedure.sha256, address: targetAddress } : null;
    const mb = openMb();
    try {
      // The message this send answers must be addressed to the caller
      // (a role's new holder included, R7.20).
      let answered = null;
      if (replyToMessageId !== undefined && replyToMessageId !== null) {
        answered = answeredMessage(mb, replyToMessageId, caller, answeredKind);
      }
      const withText = procedureClaim && roles ? roles.claimProcedureDelivery(procedureClaim) : false;
      const shownOverrides = overrides && Object.values(overrides).some((v) => typeof v === "string" && v.trim()) ? overrides : null;
      const sentAt = Date.now();
      /** @type {Record<string, any>} */
      const metadata = {
        sender: { source: caller.source },
        ...(receipt ? { receipt: receiptMetadata(receipt) } : {}),
        ...(shownOverrides ? { overrides: shownOverrides } : {}),
        ...(role
          ? {
              role: {
                via: role.via,
                address: role.address,
                procedure: procedure ? { name: procedure.name, version: procedure.version } : null,
                ...(withText && procedure ? { procedureText: procedure.text } : {})
              }
            }
          : {})
      };
      /** @type {string} */
      let messageId;
      try {
        messageId = mb.insertMessage({
          fromSessionId: caller.id,
          fromSessionKind: caller.kind,
          toSessionId: threadId,
          toSessionKind: "codex",
          body: message,
          metadata,
          replyToMessageId: answered ? answered.id : null,
          anticipation: labels.anticipation,
          replyBy: labels.replyBy,
          sentAt
        });
      } catch (error) {
        if (withText && procedureClaim && roles) roles.releaseProcedureDelivery(procedureClaim);
        throw error;
      }
      // An answer sent back to the original sender resolves an open
      // reply/action message (R7.5): "reply", or "done" for a work result
      // (R7.7). Exactly once (R7.10).
      /** @type {Record<string, any> | null} */
      let answer = null;
      if (answered && [threadId, targetAddress].includes(answered.from_session_id)) {
        answer = resolveByAnswer(mb, answered, {
          kind: answeredKind,
          byAddress: callerAddressOf(caller),
          replyMessageId: messageId,
          now: Date.now(),
          settings: reminderSettings()
        });
      }
      const row = {
        id: messageId,
        from_session_id: caller.id,
        from_session_kind: caller.kind,
        to_session_id: threadId,
        to_session_kind: "codex",
        body: message,
        metadata_json: JSON.stringify(metadata),
        sent_at: sentAt,
        reply_to_message_id: answered ? answered.id : null,
        anticipation: labels.anticipation,
        reply_by: labels.replyBy
      };
      const fields = normalizePeerMessage(peerMessageFromMailbox(row));
      const push = await pushCodexMessage({
        appServer,
        mailbox: mb,
        messageId,
        threadId,
        text: codexTurnText(row, plan === "steer" ? null : shownOverrides),
        plan,
        resume,
        startParams,
        expectedTurnId,
        // The endpoint's last word on the thread (B7 spike: a turn/start that
        // returns the active turn id steered it), and the deny-only
        // "open in another process" check (R1.12a).
        tracker,
        rolloutPath,
        rolloutCheck
      });
      return {
        messageId,
        caller,
        push,
        answer,
        answered: answered ? { id: answered.id, fromTarget: [threadId, targetAddress].includes(answered.from_session_id) } : null,
        procedureTextIncluded: Boolean(withText),
        peerMessage: {
          messageId: fields.id,
          from: fields.from,
          fromHarness: fields.fromHarness,
          fromVerified: fields.fromVerified,
          sentAt: fields.sentAt,
          anticipation: fields.anticipation,
          enveloped: true
        }
      };
    } finally {
      mb.close();
    }
  }

  /**
   * The message a send answers: it must exist and be addressed to the caller.
   * @param {ReturnType<import("../claude/mailbox.js").openMailbox>} mb
   * @param {unknown} replyToMessageId
   * @param {{aliases: string[], id: string, kind: string}} caller
   * @param {"reply" | "done"} [kind]
   */
  function answeredMessage(mb, replyToMessageId, caller, kind = "reply") {
    const original = typeof replyToMessageId === "string" ? mb.getMessage({ messageId: replyToMessageId }) : null;
    const address = callerAddressOf(caller);
    const aliases = address ? [...caller.aliases, address] : caller.aliases;
    if (kind === "done") {
      // return_project_work_result resolves the message (R7.7): the
      // resolution errors of reply_agent_link_message apply.
      if (!original) {
        throw new AgentLinkError("not_found", `No Agent Link message has id ${JSON.stringify(String(replyToMessageId)).slice(0, 80)}.`, {
          details: { id: replyToMessageId, candidates: [] },
          hint: "Use the messageId from the <agent-link-message> envelope or read_agent_link_inbox."
        });
      }
      if (!recipientMatcher({ aliases, table: readRoleTable(roles) })(original)) {
        throw new AgentLinkError("wrong_recipient", "That message was not addressed to this session.", {
          details: { messageId: original.id, expected: original.to_session_id, caller: caller.id }
        });
      }
      if (original.resolution) {
        const view = messageStatus(original, { now: Date.now(), settings: reminderSettings() });
        throw new AgentLinkError("already_resolved", `Message ${original.id} is already ${view.status}.`, {
          details: { messageId: original.id, status: view.status, resolvedAt: view.resolution?.at ?? null },
          hint: "Send the result without replyToMessageId if there is more to report."
        });
      }
      return original;
    }
    if (!original || !recipientMatcher({ aliases, table: readRoleTable(roles) })(original)) {
      throw new AgentLinkError("invalid_arguments", "`replyToMessageId` must reference an Agent Link message addressed to the caller.", {
        details: { errors: [{ path: "replyToMessageId", rule: "reference", expected: "a message addressed to the caller" }] }
      });
    }
    return original;
  }

  /**
   * A message wait on a Codex send (R7.19): ends when the message is
   * resolved (an explicit reply_agent_link_message from the thread, or a
   * send with replyToMessageId), becomes unresolved or expired, or on
   * timeout. Never on turn completion.
   * @param {{messageId: string, threadId: string, caller: {aliases: string[]}, timeoutMs?: number, pollIntervalMs?: number, turnId?: string | null}} options
   */
  async function waitForResolution({ messageId, threadId, caller, timeoutMs, pollIntervalMs, turnId = null }) {
    const fromIds = [threadId, /** @type {string} */ (codexAddress(threadId))];
    const releaseWait = registerActiveWait({ replyToMessageId: messageId, fromIds, toIds: caller.aliases });
    const startedAt = Date.now();
    const mb = openMb();
    try {
      const done = await pollMessageResolution(mb, {
        messageId,
        fromIds,
        toIds: caller.aliases,
        timeoutMs: typeof timeoutMs === "number" && timeoutMs >= 0 ? timeoutMs : LIMITS.timeoutMs.def,
        pollIntervalMs: typeof pollIntervalMs === "number" && pollIntervalMs > 0 ? pollIntervalMs : 250,
        settings: reminderSettings(),
        host
      });
      return {
        outcome: done.outcome,
        messageStatus: done.messageStatus,
        waitedMs: Date.now() - startedAt,
        target: { threadId, address: codexAddress(threadId) },
        ...(done.reply ? { reply: done.reply } : {}),
        // The turn that carried the message, for get_codex_thread; its
        // final response is never a reply (R7.5, R7.19).
        ...(turnId ? { turn: { turnId } } : {})
      };
    } finally {
      releaseWait();
      mb.close();
    }
  }

  /**
   * Token usage of the first turn on a new setting (R9.10). Message waits end
   * on an explicit resolution, not on the turn (R7.19), so with waitForReply
   * this asks the tracker for the turn's usage directly
   * (tokenUsage.awaitTurnUsage: usage notifications arrive before
   * turn/completed; it waits at most its grace period). Without a wait the
   * result is `{next: null, reason: "not_waited"}` with no warning;
   * `{next: null, reason: "no_notification"}` with a token_usage_unavailable
   * warning when it waited and none came. Adds a settings_mismatch warning
   * when a thread/settings/updated sent after this turn/start reports other
   * values than the ones sent; no notification is not a mismatch.
   * @param {{threadId: string, turnId: string | null, waited: boolean, warnings: any[], overrides: Record<string, string>, settingsMark: number}} input
   */
  async function firstTurnUsage({ threadId, turnId, waited, warnings, overrides, settingsMark }) {
    if (!tokenUsage) return { next: null };
    const checkSettings = () => {
      const mismatch = settingsMismatchWarning({ threadId, requested: { model: overrides.model, effort: overrides.effort, cwd: overrides.cwd }, applied: tokenUsage.settingsSince(threadId, settingsMark) });
      if (mismatch) warnings.push(mismatch);
    };
    // Not waiting is the caller's choice, not a failure: no warning.
    if (!waited) {
      checkSettings();
      return { next: null, reason: "not_waited" };
    }
    const usage = turnId ? await tokenUsage.awaitTurnUsage(threadId, turnId) : null;
    // After the usage wait, so a thread/settings/updated sent during the turn is seen.
    checkSettings();
    if (!usage) {
      warnings.push(tokenUsageUnavailableWarning({ threadId, turnId, purpose: "the first turn on the new setting" }));
      return { next: null, reason: "no_notification" };
    }
    return { next: usage };
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

  /**
   * wait_for_agent on a message sent to a Codex thread (R7.19).
   * @param {{messageId: string, threadId: string, callerContext?: any, timeoutMs?: number, pollIntervalMs?: number}} options
   */
  async function waitOnCodexMessage({ messageId, threadId, callerContext = null, timeoutMs, pollIntervalMs }) {
    const caller = resolveCallerIdentity({ host, runtimeCallerContext: callerContext, currentSession: resolveCurrentSession });
    return await waitForResolution({ messageId, threadId, caller, timeoutMs, pollIntervalMs });
  }

  return { messageThread, messageThreadTool, sendToThread, waitOnCodexMessage, buildPeerTurnInput, recordActionReceipt, tryWaitForReply, callerAddress, launcherOf };
}

/**
 * The caller's canonical address, or null for an external caller.
 * @param {{id: string, kind: string}} caller
 * @returns {string | null}
 */
function callerAddressOf(caller) {
  if (!caller || caller.id === "external") return null;
  const address = storedAddress(caller.id, caller.kind);
  return address.includes(":") ? address : null;
}

/**
 * Bounded receipt fields kept in the mailbox record (never the free-text note).
 * @param {any} receipt
 */
function receiptMetadata(receipt) {
  const normalized = normalizeReceiptInput(receipt);
  return {
    record: normalized.record,
    purpose: normalized.purpose,
    cleanupRecommendation: normalized.cleanupRecommendation,
    tags: normalized.tags
  };
}
