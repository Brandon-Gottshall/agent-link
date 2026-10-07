// src/codex/token-usage.js
//
// Token usage and applied settings from Codex app-server notifications
// (design doc R9.10, PR B7b):
//
//   thread/tokenUsage/updated  {threadId, turnId, tokenUsage: {last, total, modelContextWindow}}
//   thread/settings/updated    {threadId, ...settings (model, effort, cwd, serviceTier)}
//
// One tracker per app-server client listens to every notification and keeps
// the latest values per thread and per turn in memory. Receipts record the
// turn's `last` breakdown plus `modelContextWindow`. A turn whose usage does
// not arrive within TOKEN_USAGE_GRACE_MS after it ends is recorded as null
// with a token_usage_unavailable warning. Nothing here sends a request.

/** How long to wait for a turn's usage after the turn ends (R9.10). */
export const TOKEN_USAGE_GRACE_MS = 5_000;

/** Per-thread memory bound: the newest turns kept. */
const MAX_TURNS_PER_THREAD = 20;
/** Threads remembered, oldest dropped first. */
const MAX_THREADS = 500;

const BREAKDOWN_FIELDS = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];

/**
 * @typedef {{
 *   inputTokens: number | null,
 *   cachedInputTokens: number | null,
 *   cacheWriteInputTokens: number | null,
 *   outputTokens: number | null,
 *   reasoningOutputTokens: number | null,
 *   totalTokens: number | null,
 *   modelContextWindow: number | null,
 *   turnId: string | null
 * }} TurnTokenUsage
 */

/**
 * The receipt form of one notification: the `last` breakdown plus
 * `modelContextWindow` and the turn id. Null when there is no breakdown.
 * @param {any} params  thread/tokenUsage/updated params
 * @returns {TurnTokenUsage | null}
 */
export function receiptTokenUsage(params) {
  const usage = params?.tokenUsage;
  const last = usage?.last;
  if (!last || typeof last !== "object") return null;
  /** @type {Record<string, number | null>} */
  const out = {};
  for (const field of BREAKDOWN_FIELDS) out[field] = Number.isFinite(last[field]) ? last[field] : null;
  return /** @type {TurnTokenUsage} */ ({
    ...out,
    modelContextWindow: Number.isFinite(usage.modelContextWindow) ? usage.modelContextWindow : null,
    turnId: typeof params?.turnId === "string" ? params.turnId : null
  });
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
      : `No thread/tokenUsage/updated notification for ${purpose} arrived within ${TOKEN_USAGE_GRACE_MS / 1000} s after the turn ended, so its token usage is recorded as null.`,
    details: { threadId, turnId, purpose, reason },
    ...(notWaited ? { hint: "Pass waitForReply:true to record the turn's token usage in the receipt." } : {})
  };
}

/**
 * The settings_mismatch warning, or null when everything requested was
 * applied. Compares only settings that were requested and that the
 * app-server reported.
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
 *   awaitTurnUsage: (threadId: string, turnId: string, options?: {graceMs?: number}) => Promise<TurnTokenUsage | null>,
 *   settings: (threadId: string) => Record<string, any> | null,
 *   handle: (notification: {method?: string, params?: any}) => void,
 *   close: () => void
 * }} TokenUsageTracker
 */

/**
 * Tracks thread/tokenUsage/updated and thread/settings/updated. Subscribes
 * through `appServer.onNotification` when the client has it; tests can also
 * call `handle()` directly.
 * @param {{appServer?: {onNotification?: (listener: (n: any) => void) => () => void} | null, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout}} [options]
 * @returns {TokenUsageTracker}
 */
export function createTokenUsageTracker({ appServer = null, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  /** @type {Map<string, {turns: Map<string, TurnTokenUsage>, latest: TurnTokenUsage | null, settings: Record<string, any> | null}>} */
  const threads = new Map();
  /** @type {Set<{threadId: string, turnId: string, resolve: (usage: TurnTokenUsage | null) => void}>} */
  const waiters = new Set();

  /** @param {string} threadId */
  function entry(threadId) {
    let found = threads.get(threadId);
    if (!found) {
      found = { turns: new Map(), latest: null, settings: null };
      threads.set(threadId, found);
      if (threads.size > MAX_THREADS) threads.delete(/** @type {string} */ (threads.keys().next().value));
    }
    return found;
  }

  /** @param {{method?: string, params?: any}} notification */
  function handle(notification) {
    const params = notification?.params;
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (!threadId) return;
    if (notification.method === "thread/tokenUsage/updated") {
      const usage = receiptTokenUsage(params);
      if (!usage) return;
      const record = entry(threadId);
      record.latest = usage;
      if (usage.turnId) {
        record.turns.delete(usage.turnId);
        record.turns.set(usage.turnId, usage);
        if (record.turns.size > MAX_TURNS_PER_THREAD) record.turns.delete(/** @type {string} */ (record.turns.keys().next().value));
        for (const waiter of [...waiters]) {
          if (waiter.threadId === threadId && waiter.turnId === usage.turnId) waiter.resolve(usage);
        }
      }
    } else if (notification.method === "thread/settings/updated") {
      const { threadId: _id, ...rest } = params;
      const settings = rest.settings && typeof rest.settings === "object" ? rest.settings : rest;
      entry(threadId).settings = { ...settings };
    }
  }

  const unsubscribe = typeof appServer?.onNotification === "function" ? appServer.onNotification(handle) : null;

  return {
    latest: (threadId) => threads.get(threadId)?.latest ?? null,
    forTurn: (threadId, turnId) => threads.get(threadId)?.turns.get(turnId) ?? null,
    settings: (threadId) => threads.get(threadId)?.settings ?? null,
    handle,
    /**
     * The turn's usage, waiting at most `graceMs` for its notification.
     * Call when the turn has ended.
     */
    awaitTurnUsage(threadId, turnId, { graceMs = TOKEN_USAGE_GRACE_MS } = {}) {
      const known = threads.get(threadId)?.turns.get(turnId) ?? null;
      if (known || !(graceMs > 0)) return Promise.resolve(known);
      return new Promise((resolve) => {
        /** @type {{threadId: string, turnId: string, resolve: (usage: TurnTokenUsage | null) => void}} */
        const waiter = {
          threadId,
          turnId,
          resolve: (usage) => {
            clearTimer(timer);
            waiters.delete(waiter);
            resolve(usage);
          }
        };
        const timer = setTimer(() => waiter.resolve(null), graceMs);
        /** @type {any} */ (timer)?.unref?.();
        waiters.add(waiter);
      });
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
