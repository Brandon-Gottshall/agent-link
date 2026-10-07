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
import { finalAnswerText, lastRecordedUsage, settingsMismatchWarning, tokenUsageUnavailableWarning } from "./token-usage.js";
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
 * B7 spike (R9.12 item 5): 0.5, i.e. 129,200 tokens for the 258,400-token
 * windows tested. Compaction keeps user messages verbatim (no saving for
 * user-message context), cut assistant-heavy context by 45%, and costs about
 * 8 s plus 5.7k-41k tokens.
 */
export const COMPACT_FORK_AUTO_FRACTION = 0.5;

export const COMPACT_FORK_MODES = Object.freeze(["auto", "always", "never"]);

/** How often the owner's watcher first reads the fork's status; it backs off. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** The watcher's longest poll interval. */
const MAX_POLL_INTERVAL_MS = 15_000;
const POLL_BACKOFF = 1.5;
/** A watcher that cannot read the fork this many times in a row stops; sweep() takes over. */
const WATCH_MAX_CONSECUTIVE_ERRORS = 30;
/** Longest wait for a compaction to finish before the task starts. */
const COMPACTION_WAIT_MS = 10 * 60_000;
/**
 * A reconcile claim older than this with no message is superseded, and a
 * written but unfinished reconcile older than this is finished by a sweep.
 */
const STALE_RECONCILE_MS = 60_000;
/** A job forked this long ago whose task never started is failed (R9.7.5). */
export const FORK_START_STALE_MS = COMPACTION_WAIT_MS + 5 * 60_000;
/** One server at a time sweeps a job: a lease this long (claim-gated). */
const SWEEP_LEASE_MS = 60_000;
/** How often the server-wide sweeper runs (src/server/index.js). */
export const FORK_SWEEP_INTERVAL_MS = 60_000;
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

/** @deprecated use finalAnswerText (src/codex/token-usage.js) */
export const finalResponseText = finalAnswerText;

const TERMINAL = ["completed", "failed", "interrupted"];

/**
 * @typedef {{
 *   promise: Promise<any> | null,
 *   waiting: boolean,
 *   settingsMark: number,
 *   toolResult: Record<string, any> | null,
 *   done: boolean
 * }} JobRuntime
 *   One job this server started. `waiting`: its caller waits for the result
 *   (R9.8 self-fork). `toolResult`: the self-fork result, set synchronously
 *   with the mailbox write.
 */

/** @param {unknown} error */
function errorText(error) {
  const e = /** @type {any} */ (error);
  return typeof e?.message === "string" ? e.message : typeof e === "string" ? e : null;
}

/**
 * Codex answers thread/archive on an archived thread with -32600 "no
 * rollout found for thread id" (spike): already archived.
 * @param {unknown} error
 */
function alreadyArchived(error) {
  return /no rollout found for thread id/i.test(error instanceof Error ? error.message : String(error));
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
   * @type {Map<string, JobRuntime>}
   */
  const active = new Map();
  /** This server's lease token (takeLease). */
  const token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  let closed = false;
  /** @type {() => void} */
  let resolveClosed = () => {};
  /** @type {Promise<void>} */
  const closedSignal = new Promise((resolve) => {
    resolveClosed = resolve;
  });

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
    // turn/completed of the fork's turns is kept while this server owns the job.
    tokenUsage?.watch(forkThreadId);
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
      const seen = new Set((tokenUsage?.completedTurns(forkThreadId) ?? []).map((turn) => turn.turnId));
      try {
        // Returns {} at once; the compaction runs as a turn and ends with
        // turn/completed (spike).
        await appServer.request("thread/compact/start", { threadId: forkThreadId });
        const turn = await waitForCompaction(forkThreadId, seen);
        compacted = true;
        compactionUsage = turn && tokenUsage ? tokenUsage.compactionUsage(forkThreadId, turn.turnId) : null;
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
    // thread/settings/updated is sent only after a turn/start that changes
    // settings; only one received after this mark is about the task's turn.
    /** @type {JobRuntime} */
    const runtime = { promise: null, waiting: args.waitForResult === true, settingsMark: tokenUsage?.mark() ?? 0, toolResult: null, done: false };
    active.set(jobId, runtime);
    let turnId = null;
    try {
      const started = await appServer.request("turn/start", startParams);
      turnId = started?.turn?.id ?? started?.turnId ?? null;
      // No id in the answer: the task turn is the one carrying this job's
      // clientUserMessageId (echoed as clientId, spike).
      if (!turnId) turnId = await findTaskTurn(forkThreadId, jobId).catch(() => null);
      if (turnId) store.append("turn-started", jobId, { turnId });
      else store.append("failed", jobId, { turnId: null, error: "turn/start returned no turn id, and no turn on the fork carries this job's clientUserMessageId" });
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
      // A real timer: `wait` paces the watcher's polls, not the caller's deadline.
      finished = await Promise.race([runtime.promise.catch(() => null), sleep(timeoutMs).then(() => null)]);
      // Synchronous from here: once waiting is false, a reconcile not yet
      // written is pushed instead. One already written for this tool result
      // (R9.8) is returned even when the archive and receipts are still
      // running.
      runtime.waiting = false;
      if (!finished && runtime.toolResult) finished = runtime.toolResult;
      if (runtime.done) active.delete(jobId);
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
            tokenUsage: { ...(compaction.compact ? { compaction: compactionUsage } : {}), task: finished.taskUsage ?? null },
            archived: finished.archived ?? null,
            ...(finished.receipt ? { receipt: finished.receipt } : {}),
            ...(finished.reconcileReceipt ? { reconcileReceipt: finished.reconcileReceipt } : {})
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

  /**
   * Waits for the compaction turn to end: its turn/completed notification,
   * or (without a tracker) the fork's status leaving active. Reads the fork
   * while it waits, which also keeps the app-server connection in use.
   * @param {string} threadId
   * @param {Set<string>} seen  turn ids that completed before the compaction
   * @returns {Promise<import("./token-usage.js").CompletedTurn | null>}
   */
  async function waitForCompaction(threadId, seen) {
    const deadline = now() + COMPACTION_WAIT_MS;
    let sawActive = false;
    while (now() < deadline) {
      const done = tokenUsage?.completedTurns(threadId).find((turn) => !seen.has(turn.turnId));
      if (done) return done;
      const read = await appServer.request("thread/read", { threadId, includeTurns: false });
      const active = read?.thread?.status?.type === "active";
      if (!tokenUsage && sawActive && !active) return null;
      sawActive = sawActive || active;
      await wait(pollIntervalMs);
    }
    throw new Error("compaction did not finish in time");
  }

  /**
   * The fork's task turn by its clientUserMessageId (echoed as `clientId`
   * on the userMessage item, spike), or null.
   * @param {string} forkThreadId
   * @param {string} jobId
   */
  async function findTaskTurn(forkThreadId, jobId) {
    const read = await appServer.request("thread/read", { threadId: forkThreadId, includeTurns: true });
    const turn = (read?.thread?.turns ?? []).find((/** @type {any} */ t) => (t?.items ?? []).some((/** @type {any} */ item) =>
      item?.type === "userMessage" && (item.clientId === jobId || item.clientUserMessageId === jobId)));
    return typeof turn?.id === "string" ? turn.id : null;
  }

  /**
   * Reads the fork's task turn: its turn/completed when this server saw it,
   * else the fork's status (cheap, no turns) and, once it is not active, the
   * turns once. Null while the turn runs.
   * @param {string} forkThreadId
   * @param {string} turnId
   */
  async function observeTurn(forkThreadId, turnId) {
    const notified = tokenUsage?.completedTurns(forkThreadId).find((t) => t.turnId === turnId) ?? null;
    if (notified && TERMINAL.includes(/** @type {string} */ (notified.status)) && (notified.status !== "completed" || notified.finalText)) {
      return { status: /** @type {"completed" | "failed" | "interrupted"} */ (notified.status), text: notified.finalText, error: errorText(notified.error) };
    }
    if (!notified) {
      const status = (await appServer.request("thread/read", { threadId: forkThreadId, includeTurns: false }))?.thread?.status?.type;
      if (status === "active") return null;
    }
    const read = await appServer.request("thread/read", { threadId: forkThreadId, includeTurns: true });
    const turn = (read?.thread?.turns ?? []).find((/** @type {any} */ t) => t?.id === turnId);
    if (!turn || !TERMINAL.includes(turn.status)) return null;
    return { status: /** @type {"completed" | "failed" | "interrupted"} */ (turn.status), text: finalAnswerText(turn.items), error: errorText(turn.error) };
  }

  /**
   * Waits one poll interval, waking early on the task's turn/completed or
   * when this server closes.
   * @param {string} forkThreadId
   * @param {string} turnId
   * @param {number} interval
   */
  function pause(forkThreadId, turnId, interval) {
    return Promise.race([
      wait(interval),
      closedSignal,
      ...(tokenUsage ? [tokenUsage.awaitTurnCompleted(forkThreadId, (t) => t.turnId === turnId, { timeoutMs: interval })] : [])
    ]);
  }

  /**
   * The owner's watcher (R9.7): only the server that started the job
   * watches it live, with a backed-off cheap status poll; other servers'
   * sweeps check it at most once per lease. Finishes the job when its task
   * turn ends. Stops after repeated read failures or when the server closes;
   * the sweep then takes the job over.
   * @param {string} jobId
   * @param {{warnings?: any[]}} [options]
   */
  async function runJob(jobId, { warnings = [] } = {}) {
    const runtime = active.get(jobId);
    let forkThreadId = null;
    try {
      const job = store.get(jobId);
      if (!job || job.reconciled) return null;
      forkThreadId = job.forked?.fork?.threadId ?? null;
      if (job.outcome || job.written) return await finishJob(job, outcomeOf(job), { warnings });
      const turnId = job.turnStarted?.turnId;
      if (!forkThreadId || !turnId) return null;
      let interval = pollIntervalMs;
      let errors = 0;
      for (;;) {
        if (closed) return null;
        try {
          const observed = await observeTurn(forkThreadId, turnId);
          errors = 0;
          if (observed) {
            if (closed) return null;
            return await finishJob(store.get(jobId) ?? job, observed, { warnings });
          }
        } catch (error) {
          errors += 1;
          if (errors >= WATCH_MAX_CONSECUTIVE_ERRORS) {
            getLogger().warn("fork.watch_stopped", { jobId, message: messageOf(error) });
            return null;
          }
        }
        await pause(forkThreadId, turnId, interval);
        interval = Math.min(Math.ceil(interval * POLL_BACKOFF), MAX_POLL_INTERVAL_MS);
      }
    } finally {
      if (forkThreadId) tokenUsage?.unwatch(forkThreadId);
      if (runtime) {
        runtime.done = true;
        if (!runtime.waiting) active.delete(jobId);
      }
    }
  }

  /**
   * The task turn ended: record the outcome and reconcile once.
   * @param {import("./fork-jobs.js").ForkJob} job
   * @param {{status: "completed" | "failed" | "interrupted", text: string | null, error: string | null}} observed
   * @param {{warnings?: any[], graceMs?: number}} [options]  graceMs 0 in sweeps: no wait for usage
   * @returns {Promise<Record<string, any>>}
   */
  async function finishJob(job, observed, { warnings = [], graceMs = tokenUsageGraceMs } = {}) {
    if (!job.outcome) {
      store.append(observed.status, job.id, { turnId: job.turnStarted?.turnId ?? null, ...(observed.error ? { error: observed.error } : {}) });
    }
    const reconciled = await reconcile(store.get(job.id) ?? job, observed, { warnings, graceMs });
    return { ...reconciled, status: reconciled.status ?? observed.status };
  }

  /**
   * The task turn's usage, read after the reconcile claim (a sweep passes
   * graceMs 0: what this server saw, or null).
   * @param {import("./fork-jobs.js").ForkJob} job
   * @param {number | undefined} graceMs
   * @param {any[]} warnings
   */
  async function taskUsageOf(job, graceMs, warnings) {
    const forkThreadId = job.forked?.fork?.threadId;
    const turnId = job.turnStarted?.turnId;
    if (!tokenUsage || !forkThreadId || !turnId) return null;
    const usage = await tokenUsage.awaitTurnUsage(forkThreadId, turnId, graceMs === undefined ? {} : { graceMs });
    if (!usage) warnings.push(tokenUsageUnavailableWarning({ threadId: forkThreadId, turnId, purpose: "the fork's task" }));
    const request = job.created?.request ?? {};
    const mismatch = settingsMismatchWarning({
      threadId: forkThreadId,
      requested: { model: request.model, effort: request.effort, cwd: request.cwd },
      applied: tokenUsage.settingsSince(forkThreadId, active.get(job.id)?.settingsMark ?? 0)
    });
    if (mismatch) warnings.push(mismatch);
    return usage;
  }

  /**
   * Writes the reconcile message once (claim-before-notify), delivers it,
   * archives a completed fork, and writes the fork and reconcile receipts.
   * A message that is already written (job.written) is finished instead
   * (recoverReconcile).
   * @param {import("./fork-jobs.js").ForkJob} job
   * @param {{status: "completed" | "failed" | "interrupted", text: string | null, error: string | null}} observed
   * @param {{warnings?: any[], graceMs?: number}} options
   * @returns {Promise<Record<string, any>>}
   */
  async function reconcile(job, observed, { warnings: startWarnings = [], graceMs }) {
    const created = job.created ?? /** @type {any} */ ({});
    const forkInfo = job.forked?.fork ?? {};
    const originalAddress = created.original;
    const originalId = parseAddress(originalAddress)?.id ?? null;
    if (!originalId || !forkInfo.threadId) return { reconcile: null, warnings: [] };
    if (job.reconciled) return alreadyReconciled(job);
    const mb = openMailbox();
    try {
      if (job.written) return await recoverReconcile(mb, job, observed);
      const claimed = claimReconcile(mb, job.id);
      if (!claimed) return { reconcile: { messageId: null, delivery: "claimed-elsewhere" }, warnings: [] };
      // Re-read under the claim: a superseded claim's holder may have written it.
      const fresh = store.get(job.id) ?? job;
      if (fresh.reconciled) return alreadyReconciled(fresh);
      if (fresh.written) return await recoverReconcile(mb, fresh, observed);
      if (claimed > 1) {
        // A superseded claim (its holder stopped): it may have written the
        // message without recording it. Only this rare path scans the mailbox.
        const lost = findReconcileMessage(mb, originalId, job.id);
        if (lost) {
          const status = (() => {
            try {
              return JSON.parse(lost.metadata_json)?.fork?.status ?? observed.status;
            } catch {
              return observed.status;
            }
          })();
          store.append("reconcile-written", job.id, { messageId: lost.id, status, recovered: true });
          return await recoverReconcile(mb, { ...fresh, written: { type: "reconcile-written", jobId: job.id, at: 0, messageId: lost.id, status } }, observed);
        }
      }

      const warnings = [...startWarnings];
      let outcome = observed;
      const turnId = fresh.turnStarted?.turnId ?? null;
      if (observed.status === "completed" && observed.text === null && turnId) {
        outcome = (await observeTurn(forkInfo.threadId, turnId).catch(() => null)) ?? observed;
      }
      const taskUsage = await taskUsageOf(fresh, graceMs, warnings);

      // Synchronous from the check to the tool-result record: the waiting
      // caller (R9.8) sees either this result or a pushed message.
      const runtime = active.get(job.id);
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
      store.append("reconcile-written", job.id, { messageId, status: outcome.status, ...(viaToolResult ? { deliveredVia: "tool-result" } : {}) });
      const row = mb.getMessage({ messageId });
      const peer = row ? peerMessageFromMailbox(row) : null;
      /** @type {DeliveryResult} */
      let delivery;
      if (viaToolResult) {
        mb.markDelivered({ messageId, to: originalAddress });
        delivery = { delivery: "delivered", deliveredVia: "tool-result" };
        if (runtime) {
          runtime.toolResult = {
            status: outcome.status,
            reconcile: { messageId, delivery: "delivered", deliveredVia: "tool-result", anticipation: labels.anticipation ?? "fyi" },
            ...(peer ? { output: peerMessageResult(peer) } : {}),
            taskUsage,
            archived: null,
            warnings
          };
        }
      } else {
        delivery = await safeDeliver({ messageId, job, originalAddress, originalId, row, peer }, warnings);
      }
      return await completeReconcile(mb, fresh, { messageId, peer, delivery, status: outcome.status, taskUsage, warnings, labels, viaToolResult });
    } finally {
      mb.close?.();
    }
  }

  /** @param {import("./fork-jobs.js").ForkJob} job */
  function alreadyReconciled(job) {
    return { reconcile: { messageId: job.reconciled?.messageId ?? job.written?.messageId ?? null, delivery: "already-reconciled" }, warnings: [] };
  }

  /**
   * Hands a written reconcile message to `deliver`; a throw leaves it queued.
   * @param {{messageId: string, job: import("./fork-jobs.js").ForkJob, originalAddress: string, originalId: string, row: Record<string, any> | null, peer: any}} input
   * @param {any[]} warnings
   * @returns {Promise<DeliveryResult>}
   */
  async function safeDeliver({ messageId, job, originalAddress, originalId, row, peer }, warnings) {
    /** @type {DeliveryResult} */
    let delivery;
    try {
      delivery = await deliver({ kind: "fork-reconcile", messageId, forkJobId: job.id, to: originalAddress, threadId: originalId, row, envelope: peer ? renderPeerEnvelope(peer) : null });
    } catch (error) {
      delivery = { delivery: "queued" };
      warnings.push({ code: "reconcile_push_failed", severity: "warning", message: `The reconcile message is queued; pushing it failed: ${messageOf(error)}` });
    }
    if (Array.isArray(delivery?.warnings)) warnings.push(...delivery.warnings);
    return delivery;
  }

  /**
   * A reconcile message was written but the job never recorded `reconciled`
   * (its server stopped in between). Once it is older than
   * STALE_RECONCILE_MS, one sweep (a `fork-recover-<jobId>` claim) finishes
   * the rest: delivery if the message is still undelivered, `reconciled`,
   * the archive, and any missing receipt.
   * @param {ReturnType<typeof defaultOpenMailbox>} mb
   * @param {import("./fork-jobs.js").ForkJob} job
   * @param {{status: string}} observed
   */
  async function recoverReconcile(mb, job, observed) {
    const written = /** @type {import("./fork-jobs.js").ForkJobEvent} */ (job.written);
    const messageId = written.messageId;
    if (now() - written.at < STALE_RECONCILE_MS) return { reconcile: { messageId, delivery: "in-progress" }, warnings: [] };
    if (!mb.claim(`fork-recover-${job.id}`, String(now()))) return { reconcile: { messageId, delivery: "claimed-elsewhere" }, warnings: [] };
    const created = job.created ?? /** @type {any} */ ({});
    const originalAddress = created.original;
    const originalId = /** @type {string} */ (parseAddress(originalAddress)?.id);
    const row = mb.getMessage({ messageId });
    const peer = row ? peerMessageFromMailbox(row) : null;
    const warnings = [];
    /** @type {DeliveryResult} */
    let delivery;
    if (written.deliveredVia === "tool-result") {
      // Treated as delivered: the waiting caller may have returned it.
      delivery = { delivery: "delivered", deliveredVia: "tool-result" };
    } else if (row?.delivered_at) {
      delivery = { delivery: "delivered" };
    } else {
      delivery = await safeDeliver({ messageId, job, originalAddress, originalId, row, peer }, warnings);
    }
    const status = written.status ?? job.outcome?.type ?? observed.status;
    const taskUsage = await taskUsageOf(job, 0, warnings);
    return await completeReconcile(mb, job, {
      messageId, peer, delivery, status, taskUsage, warnings,
      labels: created.request?.reconcile ?? {},
      viaToolResult: written.deliveredVia === "tool-result",
      recovered: true
    });
  }

  /**
   * After the message is written and delivered (or queued): `reconciled`,
   * the archive of a completed fork, the receipts, and claim cleanup.
   * Idempotent for a recovery: it skips an archive or receipt that exists.
   * @param {ReturnType<typeof defaultOpenMailbox>} mb
   * @param {import("./fork-jobs.js").ForkJob} job
   * @param {{messageId: string, peer: any, delivery: DeliveryResult, status: string, taskUsage: any, warnings: any[], labels: Record<string, any>, viaToolResult: boolean, recovered?: boolean}} input
   */
  async function completeReconcile(mb, job, { messageId, peer, delivery, status, taskUsage, warnings, labels, viaToolResult, recovered = false }) {
    const created = job.created ?? /** @type {any} */ ({});
    const forkInfo = job.forked?.fork ?? {};
    const originalAddress = created.original;
    const originalId = /** @type {string} */ (parseAddress(originalAddress)?.id);
    store.append("reconciled", job.id, { messageId, delivery: delivery.delivery, deliveredVia: delivery.deliveredVia ?? null, ...(recovered ? { recovered: true } : {}) });

    // 6. Archive a completed fork, unless archiveFork is false; a failed or
    // interrupted one is kept.
    let archived = !!job.archived;
    if (!archived && status === "completed" && created.request?.archiveFork !== false) {
      archived = await archiveForkThread(job, forkInfo, originalId, warnings);
    }

    const links = { forkJobId: job.id, original: originalAddress, fork: forkInfo.address };
    const haveReceipt = async (/** @type {string} */ kind, /** @type {string} */ threadId) => recovered
      && ((await listReceipts({ kind, targetThreadId: threadId, limit: 50 }).catch(() => ({ data: [] }))).data ?? []).some((r) => r.forkJobId === job.id);
    const receipt = await haveReceipt("fork", forkInfo.threadId) ? null : await messaging.recordActionReceipt({
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
        status,
        tokenUsage: { ...(job.compacted ? { compaction: job.compacted.tokenUsage ?? null } : {}), task: taskUsage ?? null }
      }
    });
    const reconcileReceipt = await haveReceipt("reconcile", originalId) ? null : await messaging.recordActionReceipt({
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
        status,
        archived,
        deliveredVia: delivery.deliveredVia ?? null,
        tokenUsage: { delivery: delivery.tokenUsage ?? null },
        ...(recovered ? { recovered: true } : {})
      }
    });

    // The job is done: its claims are no longer needed (bounded state).
    for (const name of mb.listClaims()) {
      if (name.startsWith(`fork-reconcile-${job.id}`) || name === `fork-recover-${job.id}` || name === `fork-lease-${job.id}`) mb.removeClaim(name);
    }
    if (forkInfo.threadId) tokenUsage?.unwatch(forkInfo.threadId);
    return {
      status,
      reconcile: { messageId, delivery: delivery.delivery, ...(delivery.deliveredVia ? { deliveredVia: delivery.deliveredVia } : {}), anticipation: labels.anticipation ?? "fyi", ...(recovered ? { recovered: true } : {}) },
      ...(viaToolResult && peer ? { output: peerMessageResult(peer) } : {}),
      taskUsage,
      archived,
      receipt,
      reconcileReceipt,
      warnings
    };
  }

  /**
   * Archives the fork, only after checking it is the fork this job made:
   * not the original, forked from the original, and (when the app-server
   * reports it) with threadSource "agent-link-fork". An already archived
   * fork counts as archived.
   * @param {import("./fork-jobs.js").ForkJob} job
   * @param {Record<string, any>} forkInfo
   * @param {string} originalId
   * @param {any[]} warnings
   */
  async function archiveForkThread(job, forkInfo, originalId, warnings) {
    const refuse = (/** @type {string} */ why) => {
      warnings.push({ code: "fork_archive_refused", severity: "warning", message: `The fork ${forkInfo.address} was not archived: ${why}.` });
      return false;
    };
    if (!forkInfo.threadId || forkInfo.threadId === originalId) return refuse("its id is the original's");
    let thread;
    try {
      thread = (await appServer.request("thread/read", { threadId: forkInfo.threadId, includeTurns: false }))?.thread ?? {};
    } catch (error) {
      if (alreadyArchived(error)) {
        store.append("archived", job.id, { already: true });
        return true;
      }
      warnings.push({ code: "fork_archive_failed", severity: "warning", message: `The fork ${forkInfo.address} was not archived: ${messageOf(error)}` });
      return false;
    }
    if (thread.forkedFromId !== originalId) return refuse(`it reports forkedFromId ${String(thread.forkedFromId ?? null)}, not ${originalId}`);
    if (thread.threadSource !== undefined && thread.threadSource !== null && thread.threadSource !== FORK_THREAD_SOURCE) {
      return refuse(`its threadSource is ${String(thread.threadSource)}, not ${FORK_THREAD_SOURCE}`);
    }
    try {
      await appServer.request("thread/archive", { threadId: forkInfo.threadId });
      store.append("archived", job.id, {});
      return true;
    } catch (error) {
      if (alreadyArchived(error)) {
        store.append("archived", job.id, { already: true });
        return true;
      }
      warnings.push({ code: "fork_archive_failed", severity: "warning", message: `The fork ${forkInfo.address} was not archived: ${messageOf(error)}` });
      return false;
    }
  }

  /**
   * Claim-before-notify for one job's reconcile (P4-10). A claim with no
   * message after STALE_RECONCILE_MS (its holder died) is superseded by the
   * next numbered claim, up to MAX_RECONCILE_CLAIMS. Returns the claim's
   * number (1 for the first, more for a supersession), or 0.
   * @param {ReturnType<typeof defaultOpenMailbox>} mb
   * @param {string} jobId
   */
  function claimReconcile(mb, jobId) {
    for (let n = 1; n <= MAX_RECONCILE_CLAIMS; n += 1) {
      const key = n === 1 ? `fork-reconcile-${jobId}` : `fork-reconcile-${jobId}.${n}`;
      if (mb.claim(key, String(now()))) return n;
      const takenAt = Number(mb.claimContent(key)) || mb.claimTakenAt(key) || 0;
      if (now() - takenAt < STALE_RECONCILE_MS) return 0;
    }
    return 0;
  }

  /**
   * A reconcile message already in the mailbox for a job, by a scan of the
   * original's messages. Used only after superseding a stale claim.
   * @param {ReturnType<typeof defaultOpenMailbox>} mb
   * @param {string} originalId
   * @param {string} jobId
   */
  function findReconcileMessage(mb, originalId, jobId) {
    return mb.inspect({ toSessionId: originalId, limit: 1000 }).find((/** @type {Record<string, any>} */ row) => {
      if (typeof row.metadata_json !== "string" || !row.metadata_json.includes(jobId)) return false;
      try {
        return JSON.parse(row.metadata_json)?.fork?.jobId === jobId;
      } catch {
        return false;
      }
    }) ?? null;
  }

  /**
   * One server at a time sweeps a job (fix for watcher fan-out): a
   * `fork-lease-<jobId>` claim holding this server's token and the time.
   * This server renews its own lease; another server's lease is taken over
   * only when older than SWEEP_LEASE_MS. The lease spreads load; exactly-
   * once still rests on the reconcile claim.
   * @param {ReturnType<typeof defaultOpenMailbox>} mb
   * @param {string} jobId
   */
  function takeLease(mb, jobId) {
    const key = `fork-lease-${jobId}`;
    const content = `${token}:${now()}`;
    if (mb.claim(key, content)) return true;
    const [holder, at] = String(mb.claimContent(key) ?? "").split(":");
    if (holder !== token && now() - Number(at || 0) < SWEEP_LEASE_MS) return false;
    mb.removeClaim(key);
    return mb.claim(key, content);
  }

  /** @param {import("./fork-jobs.js").ForkJob} job */
  function outcomeOf(job) {
    return {
      status: /** @type {"completed" | "failed" | "interrupted"} */ (job.outcome?.type ?? job.written?.status ?? "failed"),
      text: null,
      error: job.outcome?.error ?? null
    };
  }

  /**
   * The server-wide sweep (R9.7), run at start and on a timer
   * (src/server/index.js), never from a tool call. For every unfinished job
   * this server does not own and holds the lease for:
   *   - an outcome or a written message: finish it (graceMs 0, after the claim);
   *   - no task turn recorded: find it by clientUserMessageId, or after
   *     FORK_START_STALE_MS mark the job failed and reconcile it (R9.7.5);
   *   - a running turn: one cheap status read, and finish it if it ended.
   * Then the job log is compacted when it is large.
   */
  async function sweep() {
    const summary = { checked: 0, reconciled: 0, running: 0, failed: 0, errors: 0 };
    let jobs;
    try {
      jobs = store.list();
    } catch {
      return summary;
    }
    const pending = jobs.filter((job) => !job.reconciled && !job.aborted && job.forked && !active.has(job.id));
    if (pending.length) {
      const mb = openMailbox();
      try {
        for (const job of pending) {
          if (closed) break;
          if (!takeLease(mb, job.id)) continue;
          summary.checked += 1;
          try {
            const done = await sweepJob(job, summary);
            if (done?.reconcile?.messageId && !["already-reconciled", "in-progress", "claimed-elsewhere"].includes(done.reconcile.delivery)) summary.reconciled += 1;
          } catch (error) {
            summary.errors += 1;
            getLogger().warn("fork.sweep_failed", { jobId: job.id, message: messageOf(error) });
          }
        }
      } finally {
        mb.close?.();
      }
    }
    try {
      store.compact();
    } catch (error) {
      getLogger().warn("fork.compact_failed", { message: messageOf(error) });
    }
    return summary;
  }

  /**
   * @param {import("./fork-jobs.js").ForkJob} job
   * @param {{running: number, failed: number}} summary
   * @returns {Promise<Record<string, any> | null>}
   */
  async function sweepJob(job, summary) {
    if (job.outcome || job.written) return await finishJob(job, outcomeOf(job), { graceMs: 0 });
    const forkThreadId = /** @type {string} */ (job.forked?.fork?.threadId);
    let turnId = job.turnStarted?.turnId ?? null;
    if (!turnId) {
      turnId = await findTaskTurn(forkThreadId, job.id).catch(() => null);
      if (turnId) {
        store.append("turn-started", job.id, { turnId, recovered: true });
      } else if (now() - Number(job.forked?.at ?? 0) > FORK_START_STALE_MS) {
        store.append("failed", job.id, { turnId: null, error: "The fork's task never started: the server that forked it stopped before turn/start." });
        summary.failed += 1;
        const failed = store.get(job.id) ?? job;
        return await finishJob(failed, outcomeOf(failed), { graceMs: 0 });
      } else {
        summary.running += 1;
        return null;
      }
    }
    const observed = await observeTurn(forkThreadId, turnId);
    if (!observed) {
      summary.running += 1;
      return null;
    }
    return await finishJob(store.get(job.id) ?? job, observed, { graceMs: 0 });
  }

  /**
   * Fork job counts for agent_link_health, from the job log only: no
   * writes, no app-server reads.
   * - pending: the task ended (or the message is written) but the job is
   *   not reconciled yet;
   * - running: the task turn started and has not ended;
   * - stuck: forked FORK_START_STALE_MS ago with no task turn, or a written
   *   message unfinished for STALE_RECONCILE_MS (the next sweep finishes both).
   */
  function jobCounts() {
    const counts = { pending: 0, running: 0, stuck: 0 };
    for (const job of store.list()) {
      if (job.reconciled || job.aborted || !job.forked) continue;
      if (job.written && now() - Number(job.written.at) > STALE_RECONCILE_MS) counts.stuck += 1;
      else if (job.outcome || job.written) counts.pending += 1;
      else if (job.turnStarted) counts.running += 1;
      else if (now() - Number(job.forked.at) > FORK_START_STALE_MS) counts.stuck += 1;
      else counts.running += 1;
    }
    return counts;
  }

  /** Promises of the jobs this process watches (tests wait on them). */
  function settled() {
    return Promise.all([...active.values()].map((runtime) => runtime.promise?.catch(() => null)));
  }

  /** Stops this server's watchers (shutdown); sweeps elsewhere take over. */
  function close() {
    closed = true;
    resolveClosed();
  }

  return { forkThread, sweep, jobCounts, settled, close, reconcile, decideForkCompaction };
}
