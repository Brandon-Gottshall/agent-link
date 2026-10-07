// src/codex/fork.js
//
// fork_codex_thread: run a task on a fork of an existing Codex thread and
// send the result back to the original as a reconcile message (design doc
// section 9.3, R9.7-R9.11; PR B7b). An existing thread keeps its model and
// its warm cache: a different model runs on the fork.
//
// Lifecycle (R9.7):
//   1. validate the original (a codex: thread, not archived), lastTurnId (a
//      completed turn) and cwd (inside the original's workspace, R9.5);
//   2. thread/fork with threadSource "agent-link-fork";
//   3. thread/compact/start on the fork when compactFork says so (R9.11);
//   4. turn/start on the fork with the enveloped task and effort;
//   5. when the task's turn ends (completed, failed or interrupted), write
//      exactly one reconcile message to the original's mailbox and hand it to
//      `deliver` (claim-before-notify, P4-10);
//   6. archive the fork after a completed reconcile (archiveFork, default true).
//
// Every step is an event in <state>/forks.jsonl (src/codex/fork-jobs.js), so
// any Agent Link server finishes a job whose turn ended while the caller's
// server was gone: at startup and on agent_link_health (sweep()).
//
// The original never gets a turn/start with model, effort or cwd, and is
// never compacted.

import { asUserTextInput } from "./app-server-client.js";
import { inferArchiveState } from "./thread-utils.js";
import { launcherAddress } from "./thread-actions.js";
import { createForkJobStore, forkJobStatus } from "./fork-jobs.js";
import { lastRecordedUsage, settingsMismatchWarning, tokenUsageUnavailableWarning } from "./token-usage.js";
import { openMailbox as defaultOpenMailbox } from "../claude/mailbox.js";
import { resolveCallerIdentity } from "../claude/identity.js";
import { isWithinWorkspace, workspaceRoot } from "../delivery/override-policy.js";
import { resolveLabels } from "../delivery/message-status.js";
import { optionalString, requiredString } from "../shared/args.js";
import {
  MAX_PEER_BODY_BYTES,
  assertPeerBodyWithinLimit,
  isRuntimeIdentitySource,
  newPeerMessageId,
  peerMessageFromMailbox,
  peerMessageResult,
  renderPeerEnvelope
} from "../shared/envelope.js";
import { AgentLinkError } from "../shared/errors.js";
import { EXTERNAL_ADDRESS, codexAddress, hostIdentity, parseAddress } from "../shared/identity.js";
import { getLogger } from "../shared/log.js";
import { listReceipts as defaultListReceipts } from "../shared/receipt-index.js";
import { LIMITS } from "../server/schemas.js";

/** thread/fork `threadSource` and the task's `turnTrigger` (R9.7). */
export const FORK_THREAD_SOURCE = "agent-link-fork";
export const FORK_TURN_TRIGGER = "agent-link-fork";

/**
 * compactFork "auto" compacts the fork before the task when the original's
 * last turn used more than this fraction of the model context window (R9.11).
 * TODO(spike): placeholder; the B7 spike (R9.12 item 5) measures the
 * break-even fraction and records it in the design doc.
 */
export const COMPACT_FORK_AUTO_FRACTION = 0.6;

export const COMPACT_FORK_MODES = Object.freeze(["auto", "always", "never"]);

/** How often a watcher reads the fork's task turn. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** A watcher that cannot read the fork this many times in a row stops; sweep() takes over. */
const WATCH_MAX_CONSECUTIVE_ERRORS = 30;
/** Longest wait for a compaction to finish before the task starts. */
const COMPACTION_WAIT_MS = 10 * 60_000;
/** A reconcile claim older than this with no message is superseded. */
const STALE_RECONCILE_MS = 60_000;
/** At most this many reconcile claims per job (the first plus supersessions). */
const MAX_RECONCILE_CLAIMS = 5;

/**
 * The reconcile delivery seam (R9.8). The reconcile message is already in
 * the original's mailbox when this runs; delivery pushes it. Until Codex
 * push (src/delivery/codex-push.js, B7b-receive) is wired in, the message
 * stays queued for inbox pull.
 * @param {ReconcileRecord} _record
 * @returns {Promise<DeliveryResult>}
 */
export async function queuedDelivery(_record) {
  return { delivery: "queued" };
}

/**
 * @typedef {{
 *   kind: "fork-reconcile",
 *   messageId: string,
 *   forkJobId: string,
 *   to: string,
 *   threadId: string,
 *   row: Record<string, any> | null,
 *   envelope: string | null
 * }} ReconcileRecord
 *   What `deliver` receives: the mailbox message id and row, the original's
 *   address and thread id, and the rendered envelope.
 *
 * @typedef {{
 *   delivery: "queued" | "delivered",
 *   deliveredVia?: string,
 *   turnId?: string | null,
 *   tokenUsage?: Record<string, any> | null,
 *   warnings?: any[]
 * }} DeliveryResult
 */

/**
 * Whether to compact the fork before its task (R9.11).
 * @param {{mode?: string, usage?: {inputTokens?: number | null, modelContextWindow?: number | null} | null, sameModel?: boolean, fraction?: number}} input
 */
export function decideForkCompaction({ mode = "auto", usage = null, sameModel = true, fraction = COMPACT_FORK_AUTO_FRACTION }) {
  const inputTokens = Number.isFinite(usage?.inputTokens) ? /** @type {number} */ (usage?.inputTokens) : null;
  const modelContextWindow = Number.isFinite(usage?.modelContextWindow) ? /** @type {number} */ (usage?.modelContextWindow) : null;
  const base = { mode, threshold: fraction, inputTokens, modelContextWindow, windowBasis: sameModel ? "same-model" : "original-model" };
  if (mode === "never") return { ...base, compact: false, reason: "never" };
  if (mode === "always") return { ...base, compact: true, reason: "always" };
  if (inputTokens === null || modelContextWindow === null || modelContextWindow <= 0) {
    return { ...base, compact: false, reason: "usage_unknown" };
  }
  const over = inputTokens > fraction * modelContextWindow;
  return { ...base, compact: over, reason: over ? "over_threshold" : "under_threshold" };
}

/**
 * The reconcile body (R9.8): the fork's final response, or the error summary
 * for a failed or interrupted turn. Over 64 KiB it is cut with a note naming
 * the fork, so the rest can be read with get_codex_thread.
 * @param {{status: string, text?: string | null, error?: string | null, forkAddress: string}} outcome
 */
export function reconcileBody({ status, text = null, error = null, forkAddress }) {
  const body = status === "completed"
    ? (typeof text === "string" && text.trim() ? text : `The fork's task completed without a final response. Read it with get_codex_thread threadId="${forkAddress}".`)
    : `The fork's task ${status}${error ? `: ${error}` : "."} The fork ${forkAddress} is kept for inspection (get_codex_thread).`;
  if (Buffer.byteLength(body, "utf8") <= MAX_PEER_BODY_BYTES) return body;
  const note = `\n[Agent Link: the fork's response was cut at 64 KiB. Read the rest with get_codex_thread threadId="${forkAddress}".]`;
  const room = MAX_PEER_BODY_BYTES - Buffer.byteLength(note, "utf8");
  const cut = new TextDecoder("utf-8").decode(Buffer.from(body, "utf8").subarray(0, room)).replace(/�+$/, "");
  return cut + note;
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {{
 *   appServer: import("./thread-queries.js").AppServerLike,
 *   host: string,
 *   resolveCurrentSession?: () => any,
 *   queries: {resolveThread: (args: Record<string, any>) => Promise<any>, enrichThreadLookupError: (error: any, threadId: string) => Promise<any>},
 *   messaging: {recordActionReceipt: (input: import("./thread-messaging.js").ActionReceiptInput) => Promise<any>},
 *   tokenUsage?: import("./token-usage.js").TokenUsageTracker | null,
 *   deliver?: (record: ReconcileRecord) => Promise<DeliveryResult>,
 *   store?: import("./fork-jobs.js").ForkJobStore,
 *   openMailbox?: () => ReturnType<typeof defaultOpenMailbox>,
 *   listReceipts?: (options: Record<string, any>) => Promise<{data?: any[]}>,
 *   now?: () => number,
 *   wait?: (ms: number) => Promise<void>,
 *   pollIntervalMs?: number,
 *   tokenUsageGraceMs?: number
 * }} deps
 */
export function makeForkJobs({
  appServer,
  host,
  resolveCurrentSession = () => null,
  queries,
  messaging,
  tokenUsage = null,
  deliver = queuedDelivery,
  store = createForkJobStore(),
  openMailbox = () => defaultOpenMailbox(),
  listReceipts = defaultListReceipts,
  now = () => Date.now(),
  wait = sleep,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  tokenUsageGraceMs = undefined
}) {
  /**
   * Jobs this process is watching or finishing. `waiting` is true while a
   * caller waits for the result in its tool call (R9.8 self-fork).
   * @type {Map<string, {promise: Promise<any> | null, waiting: boolean}>}
   */
  const active = new Map();

  /**
   * @param {Record<string, any>} args
   * @param {{callerContext?: any}} [toolContext]
   */
  async function forkThread(args, toolContext = {}) {
    const originalId = await resolveOriginal(args);
    const message = requiredString(args.message, "message").trim();
    if (!message) {
      throw new AgentLinkError("invalid_arguments", "message must not be empty.", {
        details: { errors: [{ path: "message", rule: "required", expected: "non-empty string" }] }
      });
    }
    assertPeerBodyWithinLimit(message);
    const compactFork = args.compactFork ?? "auto";
    const reconcileArgs = args.reconcile ?? {};
    const labels = resolveLabels({ anticipation: reconcileArgs.anticipation ?? "fyi", replyBy: reconcileArgs.replyBy, now: now() });
    const archiveFork = args.archiveFork !== false;
    const requested = {
      model: optionalString(args.model).trim() || null,
      modelProvider: optionalString(args.modelProvider).trim() || null,
      serviceTier: optionalString(args.serviceTier).trim() || null,
      effort: optionalString(args.effort).trim() || null,
      cwd: optionalString(args.cwd).trim() || null
    };

    // 1. The original: readable, not archived, with a completed turn to fork through.
    let read;
    try {
      read = await appServer.request("thread/read", { threadId: originalId, includeTurns: true });
    } catch (error) {
      throw await queries.enrichThreadLookupError(error, originalId);
    }
    const original = read.thread ?? {};
    if (inferArchiveState(original).scope === "archived") {
      throw new AgentLinkError("archived", `Thread ${originalId} is archived; fork_codex_thread forks active threads only.`, {
        details: { threadId: originalId, address: codexAddress(originalId) }
      });
    }
    const completed = (original.turns ?? []).filter((/** @type {any} */ turn) => turn?.status === "completed" && typeof turn.id === "string");
    const lastTurnId = optionalString(args.lastTurnId).trim() || completed.at(-1)?.id || null;
    if (!lastTurnId || !completed.some((/** @type {any} */ turn) => turn.id === lastTurnId)) {
      throw new AgentLinkError("invalid_arguments", args.lastTurnId
        ? `lastTurnId ${lastTurnId} is not a completed turn of ${originalId}.`
        : `Thread ${originalId} has no completed turn to fork through.`, {
        details: { errors: [{ path: "lastTurnId", rule: "completed_turn", expected: "the id of a completed turn of the original" }] },
        hint: "A fork takes completed turns only. Wait for the original's turn to finish, or pass an earlier completed turn."
      });
    }
    if (requested.cwd) assertForkCwd(requested.cwd, original.cwd, originalId);

    // The caller, from runtime identity only (R1.4).
    const by = hostIdentity({ host, callerContext: toolContext.callerContext ?? null, currentSession: resolveCurrentSession }).address;
    const caller = resolveCallerIdentity({ host, runtimeCallerContext: toolContext.callerContext ?? null, currentSession: resolveCurrentSession });
    const originalAddress = /** @type {string} */ (codexAddress(originalId));
    const jobId = newPeerMessageId(now());
    store.append("created", jobId, {
      original: originalAddress,
      by,
      launchedBy: launcherAddress(by),
      from: { id: caller.id, kind: caller.kind, source: caller.source },
      lastTurnId,
      request: { ...requested, compactFork, archiveFork, reconcile: { anticipation: labels.anticipation, replyBy: labels.replyBy } },
      receipt: args.receipt ?? null
    });
    const warnings = [];

    // 2. thread/fork. Sandbox, approvals and instructions are inherited.
    /** @type {Record<string, any>} */
    const forkParams = { threadId: originalId, lastTurnId, threadSource: FORK_THREAD_SOURCE, excludeTurns: true, ephemeral: false };
    for (const field of /** @type {const} */ (["model", "modelProvider", "serviceTier", "cwd"])) {
      if (requested[field]) forkParams[field] = requested[field];
    }
    let forkResponse;
    try {
      forkResponse = await appServer.request("thread/fork", forkParams);
    } catch (error) {
      store.append("aborted", jobId, { error: messageOf(error) });
      throw error;
    }
    const forkThreadId = forkResponse?.thread?.id;
    if (typeof forkThreadId !== "string" || !forkThreadId) {
      store.append("aborted", jobId, { error: "thread/fork returned no thread id" });
      throw new AgentLinkError("upstream_error", "thread/fork returned no thread id.", { details: { method: "thread/fork" } });
    }
    const fork = {
      threadId: forkThreadId,
      address: /** @type {string} */ (codexAddress(forkThreadId)),
      forkedFromId: forkResponse.thread.forkedFromId ?? originalId,
      model: forkResponse.model ?? forkResponse.thread.model ?? requested.model ?? null,
      effort: requested.effort ?? forkResponse.reasoningEffort ?? null,
      cwd: forkResponse.cwd ?? forkResponse.thread.cwd ?? requested.cwd ?? null
    };
    store.append("forked", jobId, { fork });
    const forkMismatch = settingsMismatchWarning({
      threadId: forkThreadId,
      requested: { model: requested.model, cwd: requested.cwd },
      applied: { model: forkResponse.model, cwd: forkResponse.cwd }
    });
    if (forkMismatch) warnings.push(forkMismatch);

    // 3. Compaction (R9.11), on the fork only.
    const originalUsage = await lastRecordedUsage({ threadId: originalId, tracker: tokenUsage, listReceipts });
    const compaction = decideForkCompaction({
      mode: compactFork,
      usage: originalUsage,
      sameModel: !requested.model || requested.model === original.model
    });
    let compactionUsage = null;
    let compacted = false;
    if (compaction.compact) {
      const before = tokenUsage?.latest(forkThreadId) ?? null;
      try {
        await appServer.request("thread/compact/start", { threadId: forkThreadId });
        await waitForIdle(forkThreadId);
        compacted = true;
        compactionUsage = await awaitNewUsage(forkThreadId, before);
        if (!compactionUsage && tokenUsage) warnings.push(tokenUsageUnavailableWarning({ threadId: forkThreadId, purpose: "the fork's compaction" }));
      } catch (error) {
        warnings.push({ code: "fork_compaction_failed", severity: "warning", message: `Compacting the fork failed (${messageOf(error)}); the task runs on the uncompacted fork.` });
      }
      store.append("compacted", jobId, { compacted, tokenUsage: compactionUsage });
    }

    // 4. The task, enveloped (section 2), on the fork only.
    const envelope = renderPeerEnvelope({
      id: jobId,
      from: caller.id,
      fromHarness: caller.kind,
      fromVerified: isRuntimeIdentitySource(caller.source),
      to: forkThreadId,
      toHarness: "codex",
      sentAt: now(),
      anticipation: "action",
      body: message,
      overrides: { cwd: requested.cwd, model: requested.model, modelProvider: requested.modelProvider, serviceTier: requested.serviceTier, effort: requested.effort },
      reply: "fork"
    });
    /** @type {Record<string, any>} */
    const startParams = { threadId: forkThreadId, input: asUserTextInput(envelope), turnTrigger: FORK_TURN_TRIGGER, clientUserMessageId: jobId };
    if (requested.effort) startParams.effort = requested.effort;
    const runtime = { promise: /** @type {Promise<any> | null} */ (null), waiting: args.waitForResult === true };
    active.set(jobId, runtime);
    let turnId = null;
    try {
      const started = await appServer.request("turn/start", startParams);
      turnId = started?.turn?.id ?? started?.turnId ?? null;
      store.append("turn-started", jobId, { turnId });
    } catch (error) {
      // The outcome is never silent (R9.7.5): a task that could not start is
      // a failed fork, reconciled like one.
      store.append("failed", jobId, { turnId: null, error: `turn/start failed: ${messageOf(error)}` });
    }

    runtime.promise = runJob(jobId, { warnings });
    runtime.promise.catch((error) => getLogger().warn("fork.job_failed", { jobId, message: messageOf(error) }));

    let finished = null;
    if (runtime.waiting) {
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? LIMITS.timeoutMs.def), LIMITS.timeoutMs.min), LIMITS.timeoutMs.max);
      finished = await Promise.race([runtime.promise.catch(() => null), wait(timeoutMs).then(() => null)]);
      runtime.waiting = false;
      if (finished) active.delete(jobId);
    }

    const job = store.get(jobId);
    /** @type {Record<string, any>} */
    const result = {
      forkJobId: jobId,
      status: finished?.status ?? (job ? forkJobStatus(job) : "running"),
      original: { address: originalAddress, threadId: originalId },
      fork,
      lastTurnId,
      turn: { id: turnId },
      compaction: { ...compaction, compacted, tokenUsage: compactionUsage },
      ...(finished
        ? {
            reconcile: finished.reconcile,
            ...(finished.output ? { output: finished.output } : {}),
            tokenUsage: { ...(compaction.compact ? { compaction: compactionUsage } : {}), task: finished.taskUsage },
            archived: finished.archived,
            receipt: finished.receipt,
            reconcileReceipt: finished.reconcileReceipt
          }
        : {}),
      warnings: [...warnings, ...(finished?.warnings ?? [])]
    };
    return result;
  }

  /**
   * The original's thread id from threadId (address or id) or query.
   * @param {Record<string, any>} args
   */
  async function resolveOriginal(args) {
    const raw = optionalString(args.threadId).trim();
    if (raw) {
      const parsed = parseAddress(raw);
      if (parsed?.harness === "claude" || raw.startsWith("claude:")) {
        throw new AgentLinkError("unsupported", `${raw} is a Claude session; only Codex threads can be forked.`, {
          details: { capability: "fork", address: raw },
          hint: "Claude sessions have no fork. Message the session instead, or launch a Codex thread for the task."
        });
      }
      if (raw.startsWith("role:")) {
        throw new AgentLinkError("invalid_arguments", "fork_codex_thread takes a codex: address, a thread id, or a query; not a role.", {
          details: { errors: [{ path: "threadId", rule: "format", expected: "codex:<id> or a thread id" }] }
        });
      }
      return parsed ? parsed.id : raw;
    }
    const query = optionalString(args.query).trim();
    if (!query) {
      throw new AgentLinkError("invalid_arguments", "Pass threadId (the original thread) or query.", {
        details: { errors: [{ path: "threadId", rule: "required", expected: "threadId or query" }] }
      });
    }
    const resolved = await queries.resolveThread({ query, archiveScope: "active" });
    if (!resolved.best) {
      throw new AgentLinkError("not_found", `No Codex thread matches "${query}".`, { details: { query } });
    }
    if (resolved.selection?.ambiguous) {
      throw new AgentLinkError("ambiguous", `Several Codex threads match "${query}" equally well.`, {
        details: { query, candidates: resolved.selection.tiedCandidateIds ?? [] },
        hint: "Pass threadId with the thread you mean."
      });
    }
    return resolved.best.id;
  }

  /**
   * R9.5 for a fork: the cwd stays inside the original's workspace.
   * @param {string} cwd
   * @param {unknown} originalCwd
   * @param {string} originalId
   */
  function assertForkCwd(cwd, originalCwd, originalId) {
    if (!cwd.startsWith("/")) {
      throw new AgentLinkError("invalid_arguments", "cwd must be an absolute path.", {
        details: { errors: [{ path: "cwd", rule: "absolute", expected: "an absolute directory path" }] }
      });
    }
    const own = typeof originalCwd === "string" && originalCwd ? originalCwd : null;
    const workspace = own ? workspaceRoot(own) : null;
    if (!workspace || !isWithinWorkspace(cwd, workspace)) {
      throw new AgentLinkError("permission_denied", `Refusing a fork cwd outside the workspace of ${originalId} (cwd_outside_workspace).`, {
        details: { reason: "cwd_outside_workspace", conflicts: [{ field: "cwd", requested: cwd, threadValue: own }], workspace },
        hint: "A fork's cwd must stay inside the original's workspace (the git top level of its cwd, or that cwd outside a repository), after symlinks are resolved."
      });
    }
  }

  /** @param {string} threadId */
  async function waitForIdle(threadId) {
    const deadline = now() + COMPACTION_WAIT_MS;
    while (now() < deadline) {
      const read = await appServer.request("thread/read", { threadId, includeTurns: false });
      if (read?.thread?.status?.type !== "active") return;
      await wait(pollIntervalMs);
    }
    throw new Error("compaction did not finish in time");
  }

  /**
   * Usage reported after `before`, waiting at most the grace period.
   * @param {string} threadId
   * @param {any} before
   */
  async function awaitNewUsage(threadId, before) {
    if (!tokenUsage) return null;
    const grace = tokenUsageGraceMs ?? 5_000;
    const deadline = now() + grace;
    for (;;) {
      const latest = tokenUsage.latest(threadId);
      if (latest && latest !== before) return latest;
      if (now() >= deadline) return null;
      await wait(Math.min(100, grace));
    }
  }

  /**
   * Reads the fork's task turn once.
   * @param {string} forkThreadId
   * @param {string} turnId
   */
  async function observeTurn(forkThreadId, turnId) {
    const read = await appServer.request("thread/read", { threadId: forkThreadId, includeTurns: true });
    const turn = (read?.thread?.turns ?? []).find((/** @type {any} */ t) => t?.id === turnId);
    if (!turn || !["completed", "failed", "interrupted"].includes(turn.status)) return null;
    // Only the task turn's own text: a fork also holds the original's turns.
    const text = [...(turn.items ?? [])].reverse().find((/** @type {any} */ item) => ["agentMessage", "assistantMessage"].includes(item?.type) && typeof item.text === "string" && item.text.trim())?.text ?? null;
    const error = typeof turn.error?.message === "string" ? turn.error.message : typeof turn.error === "string" ? turn.error : null;
    return { status: /** @type {"completed" | "failed" | "interrupted"} */ (turn.status), text, error };
  }

  /**
   * Watches a job's task turn until it ends, then finishes the job. Gives up
   * after repeated read failures; sweep() takes the job over.
   * @param {string} jobId
   * @param {{warnings?: any[]}} [options]
   */
  async function runJob(jobId, { warnings = [] } = {}) {
    try {
      let errors = 0;
      for (;;) {
        const job = store.get(jobId);
        if (!job) return null;
        if (job.reconciled) return null;
        if (job.outcome) return await finishJob(job, { status: /** @type {any} */ (job.outcome.type), text: null, error: job.outcome.error ?? null }, warnings);
        const forkThreadId = job.forked?.fork?.threadId;
        const turnId = job.turnStarted?.turnId;
        if (!forkThreadId || !turnId) return null;
        try {
          const observed = await observeTurn(forkThreadId, turnId);
          errors = 0;
          if (observed) return await finishJob(job, observed, warnings);
        } catch (error) {
          errors += 1;
          if (errors >= WATCH_MAX_CONSECUTIVE_ERRORS) {
            getLogger().warn("fork.watch_stopped", { jobId, message: messageOf(error) });
            return null;
          }
        }
        await wait(pollIntervalMs);
      }
    } finally {
      const runtime = active.get(jobId);
      if (runtime && !runtime.waiting) active.delete(jobId);
    }
  }

  /**
   * The task turn ended: record the outcome, read its token usage, and
   * reconcile once.
   * @param {import("./fork-jobs.js").ForkJob} job
   * @param {{status: "completed" | "failed" | "interrupted", text: string | null, error: string | null}} observed
   * @param {any[]} [startWarnings]
   */
  async function finishJob(job, observed, startWarnings = []) {
    const forkInfo = job.forked?.fork ?? {};
    const turnId = job.turnStarted?.turnId ?? null;
    if (!job.outcome) store.append(observed.status, job.id, { turnId, ...(observed.error ? { error: observed.error } : {}) });
    // A recorded outcome without text (another server saw the turn end):
    // read the turn again for the final response.
    let outcome = observed;
    if (observed.status === "completed" && observed.text === null && forkInfo.threadId && turnId) {
      outcome = (await observeTurn(forkInfo.threadId, turnId).catch(() => null)) ?? observed;
    }
    const warnings = [...startWarnings];
    let taskUsage = null;
    if (tokenUsage && forkInfo.threadId && turnId) {
      taskUsage = await tokenUsage.awaitTurnUsage(forkInfo.threadId, turnId, tokenUsageGraceMs === undefined ? {} : { graceMs: tokenUsageGraceMs });
      if (!taskUsage) warnings.push(tokenUsageUnavailableWarning({ threadId: forkInfo.threadId, turnId, purpose: "the fork's task" }));
      const mismatch = settingsMismatchWarning({
        threadId: forkInfo.threadId,
        requested: { model: job.created?.request?.model, effort: job.created?.request?.effort, cwd: job.created?.request?.cwd },
        applied: tokenUsage.settings(forkInfo.threadId)
      });
      if (mismatch) warnings.push(mismatch);
    }
    const reconciled = await reconcile(job, { ...outcome, taskUsage });
    return { ...reconciled, status: outcome.status, taskUsage, warnings: [...warnings, ...(reconciled.warnings ?? [])] };
  }

  /**
   * Writes the reconcile message once (claim-before-notify), delivers it,
   * archives a completed fork, and writes the fork and reconcile receipts.
   * @param {import("./fork-jobs.js").ForkJob} job
   * @param {{status: "completed" | "failed" | "interrupted", text: string | null, error: string | null, taskUsage: any}} outcome
   */
  async function reconcile(job, outcome) {
    const created = job.created ?? /** @type {any} */ ({});
    const forkInfo = job.forked?.fork ?? {};
    const originalAddress = created.original;
    const originalId = parseAddress(originalAddress)?.id ?? null;
    if (!originalId || !forkInfo.threadId) return { reconcile: null, warnings: [] };
    const mb = openMailbox();
    try {
      const existing = findReconcileMessage(mb, originalId, job.id);
      if (existing) return { reconcile: { messageId: existing.id, delivery: "already-reconciled" }, warnings: [] };
      if (!claimReconcile(mb, job.id)) return { reconcile: { messageId: null, delivery: "claimed-elsewhere" }, warnings: [] };
      // Re-checked under the claim: a superseded claim's holder may have written it.
      const again = findReconcileMessage(mb, originalId, job.id);
      if (again) return { reconcile: { messageId: again.id, delivery: "already-reconciled" }, warnings: [] };

      const runtime = active.get(job.id);
      // R9.8: the original asked for its own fork and is waiting, so the
      // output goes back in its tool result instead of a push.
      const viaToolResult = runtime?.waiting === true && created.by === originalAddress;
      const labels = created.request?.reconcile ?? {};
      const body = reconcileBody({ status: outcome.status, text: outcome.text, error: outcome.error, forkAddress: forkInfo.address });
      const messageId = mb.insertMessage({
        fromSessionId: created.from?.id ?? EXTERNAL_ADDRESS,
        fromSessionKind: created.from?.kind ?? "external",
        toSessionId: originalId,
        toSessionKind: "codex",
        body,
        metadata: {
          sender: { source: created.from?.source ?? null },
          fork: { jobId: job.id, thread: forkInfo.address, original: originalAddress, model: forkInfo.model ?? null, effort: forkInfo.effort ?? null, status: outcome.status },
          ...(viaToolResult ? { deliveredVia: "tool-result" } : {})
        },
        anticipation: labels.anticipation ?? "fyi",
        replyBy: labels.replyBy ?? null
      });
      const row = mb.getMessage({ messageId });
      const peer = row ? peerMessageFromMailbox(row) : null;
      const warnings = [];
      /** @type {DeliveryResult} */
      let delivery;
      if (viaToolResult) {
        mb.markDelivered({ messageId, to: originalAddress });
        delivery = { delivery: "delivered", deliveredVia: "tool-result" };
      } else {
        try {
          delivery = await deliver({ kind: "fork-reconcile", messageId, forkJobId: job.id, to: originalAddress, threadId: originalId, row, envelope: peer ? renderPeerEnvelope(peer) : null });
        } catch (error) {
          delivery = { delivery: "queued" };
          warnings.push({ code: "reconcile_push_failed", severity: "warning", message: `The reconcile message is queued; pushing it failed: ${messageOf(error)}` });
        }
        if (Array.isArray(delivery?.warnings)) warnings.push(...delivery.warnings);
      }
      store.append("reconciled", job.id, { messageId, delivery: delivery.delivery, deliveredVia: delivery.deliveredVia ?? null });

      // 6. Archive a completed fork; a failed or interrupted one is kept.
      let archived = false;
      if (outcome.status === "completed" && created.request?.archiveFork !== false) {
        try {
          await appServer.request("thread/archive", { threadId: forkInfo.threadId });
          archived = true;
          store.append("archived", job.id, {});
        } catch (error) {
          warnings.push({ code: "fork_archive_failed", severity: "warning", message: `The fork ${forkInfo.address} was not archived: ${messageOf(error)}` });
        }
      }

      const links = { forkJobId: job.id, original: originalAddress, fork: forkInfo.address };
      const receipt = await messaging.recordActionReceipt({
        action: "fork_thread",
        receipt: created.receipt ?? null,
        target: { threadId: forkInfo.threadId, address: forkInfo.address, turnId: job.turnStarted?.turnId ?? null, cwd: forkInfo.cwd ?? null },
        message: null,
        appServer: appServer.getConnectionSummary(),
        extra: {
          kind: "fork",
          ...links,
          forkedFromId: forkInfo.forkedFromId ?? originalId,
          lastTurnId: created.lastTurnId ?? null,
          model: forkInfo.model ?? null,
          effort: forkInfo.effort ?? null,
          cwd: forkInfo.cwd ?? null,
          compacted: job.compacted?.compacted === true,
          by: created.by ?? null,
          // R9.9: the caller launched the fork.
          launchedBy: created.launchedBy ?? null,
          status: outcome.status,
          tokenUsage: { ...(job.compacted ? { compaction: job.compacted.tokenUsage ?? null } : {}), task: outcome.taskUsage ?? null }
        }
      });
      const reconcileReceipt = await messaging.recordActionReceipt({
        action: "reconcile_fork",
        receipt: created.receipt ?? null,
        target: { threadId: originalId, address: originalAddress },
        message: null,
        delivery: { state: delivery.delivery, deliveredVia: delivery.deliveredVia ?? null, messageId },
        appServer: appServer.getConnectionSummary(),
        extra: {
          kind: "reconcile",
          ...links,
          messageId,
          from: peer ? peerMessageResult(peer, { includeEnvelope: false }).from : null,
          to: originalAddress,
          status: outcome.status,
          archived,
          deliveredVia: delivery.deliveredVia ?? null,
          tokenUsage: { delivery: delivery.tokenUsage ?? null }
        }
      });
      return {
        reconcile: { messageId, delivery: delivery.delivery, ...(delivery.deliveredVia ? { deliveredVia: delivery.deliveredVia } : {}), anticipation: labels.anticipation ?? "fyi" },
        ...(viaToolResult && peer ? { output: peerMessageResult(peer) } : {}),
        archived,
        receipt,
        reconcileReceipt,
        warnings
      };
    } finally {
      mb.close?.();
    }
  }

  /**
   * The reconcile message already written for a job, or null.
   * @param {ReturnType<typeof defaultOpenMailbox>} mb
   * @param {string} originalId
   * @param {string} jobId
   */
  function findReconcileMessage(mb, originalId, jobId) {
    const rows = mb.inspect({ toSessionId: originalId, limit: Number.MAX_SAFE_INTEGER });
    return rows.find((/** @type {Record<string, any>} */ row) => {
      if (typeof row.metadata_json !== "string" || !row.metadata_json.includes(jobId)) return false;
      try {
        return JSON.parse(row.metadata_json)?.fork?.jobId === jobId;
      } catch {
        return false;
      }
    }) ?? null;
  }

  /**
   * Claim-before-notify for one job's reconcile (P4-10). A claim with no
   * message after STALE_RECONCILE_MS (its holder died) is superseded by the
   * next numbered claim, up to MAX_RECONCILE_CLAIMS.
   * @param {ReturnType<typeof defaultOpenMailbox>} mb
   * @param {string} jobId
   */
  function claimReconcile(mb, jobId) {
    for (let n = 1; n <= MAX_RECONCILE_CLAIMS; n += 1) {
      const key = n === 1 ? `fork-reconcile-${jobId}` : `fork-reconcile-${jobId}.${n}`;
      if (mb.claim(key, String(now()))) return true;
      const takenAt = Number(mb.claimContent(key)) || mb.claimTakenAt(key) || 0;
      if (now() - takenAt < STALE_RECONCILE_MS) return false;
    }
    return false;
  }

  /**
   * Finishes jobs whose task turn ended while no server watched them, and
   * starts watching unfinished ones this process does not watch yet (R9.7:
   * at startup and on agent_link_health). Exactly one reconcile per job
   * across every server (claims).
   * @returns {Promise<{checked: number, reconciled: number, running: number, errors: number}>}
   */
  async function sweep() {
    const summary = { checked: 0, reconciled: 0, running: 0, errors: 0 };
    let jobs;
    try {
      jobs = store.list();
    } catch {
      return summary;
    }
    for (const job of jobs) {
      if (job.reconciled || job.aborted || !job.forked || active.has(job.id)) continue;
      summary.checked += 1;
      try {
        if (job.outcome) {
          const done = await finishJob(job, { status: /** @type {any} */ (job.outcome.type), text: null, error: job.outcome.error ?? null });
          if (done.reconcile?.messageId && done.reconcile.delivery !== "already-reconciled") summary.reconciled += 1;
          continue;
        }
        const turnId = job.turnStarted?.turnId;
        if (!turnId) continue;
        const observed = await observeTurn(job.forked.fork.threadId, turnId);
        if (observed) {
          const done = await finishJob(job, observed);
          if (done.reconcile?.messageId && done.reconcile.delivery !== "already-reconciled") summary.reconciled += 1;
        } else {
          summary.running += 1;
          const runtime = { promise: /** @type {Promise<any> | null} */ (null), waiting: false };
          active.set(job.id, runtime);
          runtime.promise = runJob(job.id);
          runtime.promise.catch((error) => getLogger().warn("fork.job_failed", { jobId: job.id, message: messageOf(error) }));
        }
      } catch (error) {
        summary.errors += 1;
        getLogger().warn("fork.sweep_failed", { jobId: job.id, message: messageOf(error) });
      }
    }
    return summary;
  }

  /** Promises of the jobs this process watches (tests wait on them). */
  function settled() {
    return Promise.all([...active.values()].map((runtime) => runtime.promise?.catch(() => null)));
  }

  return { forkThread, sweep, settled, reconcile, decideForkCompaction };
}
