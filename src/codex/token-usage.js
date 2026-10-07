// src/codex/token-usage.js
//
// Token usage, applied settings and turn completion from Codex app-server
// notifications (design doc R9.10, PR B7b). Shapes as observed by the B7
// spike (codex-cli 0.159.2, docs/design/b7-spike-results.md section B):
//
//   thread/tokenUsage/updated  {threadId, turnId, tokenUsage: {last, total, modelContextWindow}}
//     once per MODEL REQUEST, before turn/completed. `last` is that request,
//     `total` is cumulative for the thread. A turn's usage is the sum of
//     `last` over its notifications. An interrupted turn repeats the previous
//     request's `last` with `total` unchanged, and a compaction reports only
//     `last.totalTokens` with `total` unchanged: a notification whose `total`
//     did not change is not counted.
//   thread/settings/updated    {threadId, threadSettings: {model, effort, cwd, serviceTier, ...}}
//     only after a turn/start that CHANGES settings (13-35 ms later); its
//     absence is not a mismatch.
//   turn/completed             {threadId, turn: {id, status, items, error, ...}}
//
// One tracker per app-server client keeps the latest values per thread and
// per turn in memory. The usage notifications arrive before turn/completed,
// so the TOKEN_USAGE_GRACE_MS wait after a turn ends is only a fallback.
// Nothing here sends a request.

/** Fallback wait for a turn's usage after the turn ends (R9.10). */
export const TOKEN_USAGE_GRACE_MS = 5_000;

/** Per-thread memory bound: the newest turns kept. */
const MAX_TURNS_PER_THREAD = 20;
/** Threads remembered, oldest dropped first. */
const MAX_THREADS = 500;

const BREAKDOWN_FIELDS = /** @type {const} */ (["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]);

/**
 * @typedef {{
 *   inputTokens: number | null,
 *   cachedInputTokens: number | null,
 *   cacheWriteInputTokens: number | null,
 *   outputTokens: number | null,
 *   reasoningOutputTokens: number | null,
 *   totalTokens: number | null,
 *   modelContextWindow: number | null,
 *   modelRequests: number,
 *   turnId: string | null
 * }} TurnTokenUsage
 *
 * @typedef {{
 *   counted: number,
 *   notifications: number,
 *   sum: Record<string, number>,
 *   rawLast: Record<string, any> | null,
 *   modelContextWindow: number | null
 * }} TurnAccumulator
 *
 * @typedef {{turnId: string, status: string | null, items: any[], error: any}} CompletedTurn
 */

/** @param {unknown} value */
const num = (value) => (Number.isFinite(value) ? /** @type {number} */ (value) : null);

/**
 * The receipt form of one turn's accumulated usage: the summed `last`
 * breakdown of its counted model requests, plus `modelContextWindow`,
 * the request count and the turn id. Null when no request was counted.
 * @param {TurnAccumulator | undefined} acc
 * @param {string} turnId
 * @returns {TurnTokenUsage | null}
 */
function turnUsage(acc, turnId) {
  if (!acc || acc.counted === 0) return null;
  /** @type {Record<string, number | null>} */
  const out = {};
  for (const field of BREAKDOWN_FIELDS) out[field] = Object.prototype.hasOwnProperty.call(acc.sum, field) ? acc.sum[field] : null;
  return /** @type {TurnTokenUsage} */ ({ ...out, modelContextWindow: acc.modelContextWindow, modelRequests: acc.counted, turnId });
}

/**
 * The warning for a turn whose usage did not arrive (R9.10).
 * @param {{threadId: string, turnId?: string | null, purpose: string, reason?: string}} details
 */
export function tokenUsageUnavailableWarning({ threadId, turnId = null, purpose, reason = "no_notification" }) {
  const notWaited = reason === "not_waited";
  return {
    code: "token_usage_unavailable",
    severity: "warning",
    message: notWaited
      ? `Token usage for ${purpose} was not recorded, because the call did not wait for the turn to end.`
      : `No thread/tokenUsage/updated notification for ${purpose} was seen by ${TOKEN_USAGE_GRACE_MS / 1000} s after the turn ended, so its token usage is recorded as null.`,
    details: { threadId, turnId, purpose, reason },
    ...(notWaited ? { hint: "Pass waitForReply:true to record the turn's token usage in the receipt." } : {})
  };
}

/**
 * The settings_mismatch warning, or null when everything requested was
 * applied. Compares only settings that were requested and that the
 * app-server reported: a setting it did not report (no
 * thread/settings/updated, which Codex sends only for a change) is never a
 * mismatch.
 * @param {{threadId: string, requested: Record<string, string | null | undefined>, applied: Record<string, any> | null}} input
 */
export function settingsMismatchWarning({ threadId, requested, applied }) {
  if (!applied) return null;
  /** @type {Array<{setting: string, requested: string, applied: unknown}>} */
  const mismatches = [];
  for (const [setting, value] of Object.entries(requested)) {
    if (typeof value !== "string" || !value) continue;
    const actual = appliedValue(applied, setting);
    if (actual === undefined || actual === null) continue;
    if (String(actual) !== value) mismatches.push({ setting, requested: value, applied: actual });
  }
  if (!mismatches.length) return null;
  return {
    code: "settings_mismatch",
    severity: "warning",
    message: `The app-server reports different settings than requested for ${threadId}: ${mismatches.map((m) => `${m.setting} ${String(m.applied)} (requested ${m.requested})`).join(", ")}.`,
    details: { threadId, mismatches }
  };
}

/**
 * @param {Record<string, any>} applied
 * @param {string} setting
 */
function appliedValue(applied, setting) {
  if (setting === "effort") return applied.effort ?? applied.reasoningEffort;
  return applied[setting];
}

/**
 * @typedef {{
 *   latest: (threadId: string) => TurnTokenUsage | null,
 *   forTurn: (threadId: string, turnId: string) => TurnTokenUsage | null,
 *   compactionUsage: (threadId: string, turnId: string) => {totalTokens: number | null} | null,
 *   awaitTurnUsage: (threadId: string, turnId: string, options?: {graceMs?: number}) => Promise<TurnTokenUsage | null>,
 *   completedTurns: (threadId: string) => CompletedTurn[],
 *   awaitTurnCompleted: (threadId: string, predicate: (turn: CompletedTurn) => boolean, options?: {timeoutMs?: number}) => Promise<CompletedTurn | null>,
 *   settings: (threadId: string) => Record<string, any> | null,
 *   settingsSince: (threadId: string, mark: number) => Record<string, any> | null,
 *   mark: () => number,
 *   handle: (notification: {method?: string, params?: any}) => void,
 *   close: () => void
 * }} TokenUsageTracker
 */

/**
 * Tracks thread/tokenUsage/updated, thread/settings/updated and
 * turn/completed. Subscribes through `appServer.onNotification` when the
 * client has it; tests can also call `handle()` directly.
 * @param {{appServer?: {onNotification?: (listener: (n: any) => void) => () => void} | null, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout}} [options]
 * @returns {TokenUsageTracker}
 */
export function createTokenUsageTracker({ appServer = null, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  /**
   * @type {Map<string, {
   *   turns: Map<string, TurnAccumulator>,
   *   latestTurnId: string | null,
   *   lastTotal: number | null,
   *   settings: Record<string, any> | null,
   *   settingsMark: number,
   *   completed: CompletedTurn[]
   * }>}
   */
  const threads = new Map();
  /** @type {Set<{threadId: string, test: (kind: string, value: any) => boolean, resolve: (value: any) => void}>} */
  const waiters = new Set();
  let sequence = 0;

  /** @param {string} threadId */
  function entry(threadId) {
    let found = threads.get(threadId);
    if (!found) {
      found = { turns: new Map(), latestTurnId: null, lastTotal: null, settings: null, settingsMark: 0, completed: [] };
      threads.set(threadId, found);
      if (threads.size > MAX_THREADS) threads.delete(/** @type {string} */ (threads.keys().next().value));
    }
    return found;
  }

  /**
   * @param {string} threadId
   * @param {string} kind
   * @param {any} value
   */
  function notify(threadId, kind, value) {
    for (const waiter of [...waiters]) {
      if (waiter.threadId === threadId && waiter.test(kind, value)) waiter.resolve(value);
    }
  }

  /** @param {{method?: string, params?: any}} notification */
  function handle(notification) {
    const params = notification?.params;
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (!threadId) return;
    if (notification.method === "thread/tokenUsage/updated") {
      const usage = params.tokenUsage;
      const last = usage?.last;
      const turnId = typeof params.turnId === "string" ? params.turnId : null;
      if (!last || typeof last !== "object" || !turnId) return;
      const record = entry(threadId);
      let acc = record.turns.get(turnId);
      if (!acc) {
        acc = { counted: 0, notifications: 0, sum: {}, rawLast: null, modelContextWindow: null };
        record.turns.set(turnId, acc);
        if (record.turns.size > MAX_TURNS_PER_THREAD) record.turns.delete(/** @type {string} */ (record.turns.keys().next().value));
      }
      acc.notifications += 1;
      acc.rawLast = { ...last };
      acc.modelContextWindow = num(usage.modelContextWindow) ?? acc.modelContextWindow;
      record.latestTurnId = turnId;
      // A notification whose cumulative total did not move is not a new
      // model request: an interrupted turn's stale copy of the previous
      // `last`, or a compaction (spike). It is not counted.
      const total = num(usage.total?.totalTokens);
      const counts = record.lastTotal === null || total === null || total !== record.lastTotal;
      if (total !== null) record.lastTotal = total;
      if (counts) {
        acc.counted += 1;
        for (const field of BREAKDOWN_FIELDS) {
          const value = num(last[field]);
          if (value !== null) acc.sum[field] = (acc.sum[field] ?? 0) + value;
        }
        notify(threadId, "usage", turnId);
      }
    } else if (notification.method === "thread/settings/updated") {
      const { threadId: _id, ...rest } = params;
      const settings = rest.threadSettings && typeof rest.threadSettings === "object"
        ? rest.threadSettings
        : rest.settings && typeof rest.settings === "object" ? rest.settings : rest;
      const record = entry(threadId);
      record.settings = { ...settings };
      record.settingsMark = ++sequence;
    } else if (notification.method === "turn/completed") {
      const turn = params.turn;
      if (!turn || typeof turn.id !== "string") return;
      /** @type {CompletedTurn} */
      const completed = { turnId: turn.id, status: typeof turn.status === "string" ? turn.status : null, items: Array.isArray(turn.items) ? turn.items : [], error: turn.error ?? null };
      const record = entry(threadId);
      record.completed.push(completed);
      if (record.completed.length > MAX_TURNS_PER_THREAD) record.completed.shift();
      notify(threadId, "completed", completed);
    }
  }

  /**
   * @param {string} threadId
   * @param {(kind: string, value: any) => boolean} test
   * @param {number} timeoutMs
   */
  function waitFor(threadId, test, timeoutMs) {
    return new Promise((resolve) => {
      /** @type {{threadId: string, test: (kind: string, value: any) => boolean, resolve: (value: any) => void}} */
      const waiter = {
        threadId,
        test,
        resolve: (value) => {
          clearTimer(timer);
          waiters.delete(waiter);
          resolve(value);
        }
      };
      const timer = setTimer(() => waiter.resolve(null), timeoutMs);
      /** @type {any} */ (timer)?.unref?.();
      waiters.add(waiter);
    });
  }

  const unsubscribe = typeof appServer?.onNotification === "function" ? appServer.onNotification(handle) : null;

  return {
    latest(threadId) {
      const record = threads.get(threadId);
      if (!record) return null;
      // The newest turn with a counted request.
      for (const [turnId, acc] of [...record.turns].reverse()) {
        const usage = turnUsage(acc, turnId);
        if (usage) return usage;
      }
      return null;
    },
    forTurn: (threadId, turnId) => turnUsage(threads.get(threadId)?.turns.get(turnId), turnId),
    // A compaction reports only `last.totalTokens` (spike).
    compactionUsage(threadId, turnId) {
      const raw = threads.get(threadId)?.turns.get(turnId)?.rawLast;
      return raw ? { totalTokens: num(raw.totalTokens) } : null;
    },
    completedTurns: (threadId) => [...(threads.get(threadId)?.completed ?? [])],
    awaitTurnCompleted(threadId, predicate, { timeoutMs = TOKEN_USAGE_GRACE_MS } = {}) {
      const done = (threads.get(threadId)?.completed ?? []).find(predicate);
      if (done) return Promise.resolve(done);
      return waitFor(threadId, (kind, value) => kind === "completed" && predicate(value), timeoutMs);
    },
    settings: (threadId) => threads.get(threadId)?.settings ?? null,
    settingsSince(threadId, mark) {
      const record = threads.get(threadId);
      return record && record.settingsMark > mark ? record.settings : null;
    },
    mark: () => sequence,
    handle,
    /**
     * The turn's usage. Usage notifications arrive before turn/completed, so
     * this normally answers at once; otherwise it waits at most `graceMs`.
     */
    awaitTurnUsage(threadId, turnId, { graceMs = TOKEN_USAGE_GRACE_MS } = {}) {
      const known = turnUsage(threads.get(threadId)?.turns.get(turnId), turnId);
      if (known || !(graceMs > 0)) return Promise.resolve(known);
      return waitFor(threadId, (kind, value) => kind === "usage" && value === turnId, graceMs)
        .then(() => turnUsage(threads.get(threadId)?.turns.get(turnId), turnId));
    },
    close() {
      unsubscribe?.();
      for (const waiter of [...waiters]) waiter.resolve(null);
    }
  };
}

/**
 * The token usage a receipt recorded for its target thread's turn, or null:
 * a fork receipt's task turn, a reconcile receipt's delivery turn, or a
 * switch receipt's first turn on the new setting (R9.10).
 * @param {Record<string, any>} receipt  a receipt summary
 * @returns {TurnTokenUsage | null}
 */
export function usageFromReceipt(receipt) {
  const candidates = [receipt?.tokenUsage?.task, receipt?.tokenUsage?.delivery, receipt?.tokenUsage?.next, receipt?.override?.tokenUsage?.next];
  return candidates.find((usage) => usage && typeof usage === "object" && Number.isFinite(usage.inputTokens)) ?? null;
}

/**
 * The last turn's token usage for a thread: the newest notification this
 * server saw, else the newest receipt that recorded one (R9.4). Null when
 * neither is known.
 * @param {{threadId: string, tracker?: TokenUsageTracker | null, listReceipts?: ((options: Record<string, any>) => Promise<{data?: any[]}>) | null}} input
 * @returns {Promise<TurnTokenUsage | null>}
 */
export async function lastRecordedUsage({ threadId, tracker = null, listReceipts = null }) {
  const seen = tracker?.latest(threadId) ?? null;
  if (seen) return seen;
  if (!listReceipts) return null;
  try {
    const { data = [] } = await listReceipts({ targetThreadId: threadId, limit: 50 });
    for (const receipt of data) {
      const usage = usageFromReceipt(receipt);
      if (usage) return usage;
    }
  } catch {
    // An unreadable receipt log means the usage is unknown, not an error.
  }
  return null;
}

/**
 * The expected cost of an in-place switch (R9.4): the input tokens of the
 * thread's last turn, or null with basis "unknown".
 * @param {TurnTokenUsage | null} usage
 * @returns {{uncachedInputTokens: number | null, basis: "last-turn-input" | "unknown"}}
 */
export function expectedCostFrom(usage) {
  return usage && Number.isFinite(usage.inputTokens)
    ? { uncachedInputTokens: /** @type {number} */ (usage.inputTokens), basis: "last-turn-input" }
    : { uncachedInputTokens: null, basis: "unknown" };
}
