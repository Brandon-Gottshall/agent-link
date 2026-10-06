// src/codex/thread-queries.js
//
// Read-side Codex thread operations: list, resolve, get and wait, with the
// local-transcript fallbacks and the not_found enrichment they share (moved
// from src/server.js in PR B5, unchanged). Built by a factory taking the
// app-server client; nothing runs at import time.

import { clampInt as clamp, optionalString, requiredString } from "../shared/args.js";
import { codexAddress } from "../shared/identity.js";
import { AgentLinkError } from "../shared/errors.js";
import { sleep } from "../shared/process.js";
import { listReceipts } from "../shared/receipt-index.js";
import { toIso, truncate } from "../shared/text.js";
import { LIMITS } from "../server/schemas.js";
import { AppServerError } from "./app-server-client.js";
import { listLocalThreadIds, listLocalThreads, readLocalThread } from "./session-index.js";
import { summarizeThread } from "./thread-summary.js";
import {
  analyzeThreadWaitState,
  loadedStateSemantics,
  normalizeArchiveScope,
  rankThreadSummaries,
  suggestThreadIds
} from "./thread-utils.js";

/** @typedef {import("./app-server-client.js").CodexAppServerClient} CodexAppServerClient */
/** @typedef {import("./thread-summary.js").ThreadSummary} ThreadSummary */

/**
 * The Codex app-server surface these operations use.
 * @typedef {Pick<CodexAppServerClient, "request" | "getConnectionSummary">} AppServerLike
 */

/**
 * @typedef {{
 *   appServer: AppServerLike,
 *   now?: () => number,
 *   wait?: (ms: number) => Promise<void>
 * }} ThreadQueryDeps
 */

/**
 * @typedef {{
 *   archiveScope: string,
 *   limit: number,
 *   searchTerm: string,
 *   cwd: string | null,
 *   sourceKinds?: string[] | null
 * }} ThreadSummaryQuery
 */

/**
 * @typedef {{
 *   threadId: string,
 *   targetTurnId?: string | null,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number
 * }} WaitReadArgs
 */

/**
 * @typedef {{timedOut: boolean, waitedMs: number, thread: any, waitState: any}} WaitReadResult
 */

// Local transcript fallbacks read at most this many of the newest transcripts
// when a search has to be answered from disk (they used to read up to 2,000).
export const LOCAL_SEARCH_SCAN_LIMIT = 300;

/**
 * @param {ThreadSummary[]} threads
 * @param {{limit: number, searchTerm: string}} options
 */
export function finalizeThreadResults(threads, { limit, searchTerm }) {
  if (searchTerm) {
    return rankThreadSummaries(threads, searchTerm, limit);
  }
  return threads.slice(0, limit);
}

/**
 * @template {{id: string}} T
 * @param {T[]} threads
 * @returns {T[]}
 */
export function dedupeThreads(threads) {
  const seen = new Set();
  const out = [];
  for (const thread of threads) {
    if (seen.has(thread.id)) {
      continue;
    }
    seen.add(thread.id);
    out.push(thread);
  }
  return out;
}

/**
 * @param {any[]} candidates  ranked thread summaries carrying `match.score`
 */
export function buildResolveSelection(candidates) {
  if (candidates.length === 0) {
    return {
      bestId: null,
      strategy: "highest match score; ties sort by newest updatedAt",
      ambiguous: false,
      tiedCandidateCount: 0,
      note: "No candidates matched the query."
    };
  }

  const topScore = candidates[0].match?.score ?? 0;
  const tied = candidates.filter((candidate) => candidate.match?.score === topScore);
  return {
    bestId: candidates[0].id,
    topScore,
    strategy: "highest match score; ties sort by newest updatedAt",
    ambiguous: tied.length > 1,
    tiedCandidateCount: tied.length,
    tiedCandidateIds: tied.map((candidate) => candidate.id),
    note: tied.length > 1
      ? "Multiple candidates have the same top score; inspect candidates and match reasons before messaging."
      : "Best candidate has the highest match score."
  };
}

/**
 * @param {unknown} error
 */
export function isTransientIncludeTurnsUnavailable(error) {
  const message = String(/** @type {any} */ (error)?.message ?? "");
  return /not materialized yet/i.test(message)
    || /includeTurns is unavailable before first user message/i.test(message);
}

// An app-server JSON-RPC error for a thread read means the thread does not
// exist (or its id is malformed): not_found with ranked candidates, like
// get_codex_thread (section 3.2). Transport failures keep their own code.
const THREAD_MISSING_TEXT = /not found|no such|unknown thread|does not exist|no rollout|invalid thread|invalid uuid|failed to parse/i;

/**
 * @param {any} error
 * @param {string} threadId
 */
export async function enrichThreadLookupError(error, threadId) {
  const rpcCode = error instanceof AppServerError && typeof error.code === "number" ? error.code : null;
  if (rpcCode === null || !THREAD_MISSING_TEXT.test(String(error.message ?? ""))) {
    return error;
  }
  return threadNotFound(threadId, { appServerReachable: true, rpcCode });
}

/**
 * @param {string} threadId
 * @param {Record<string, unknown>} [extra]
 */
export async function threadNotFound(threadId, extra = {}) {
  return new AgentLinkError("not_found", `Codex thread ${threadId} was not found.`, {
    details: {
      id: threadId,
      candidates: await getThreadIdSuggestions(threadId),
      ...extra
    },
    hint: "Call resolve_codex_thread or list_codex_threads to find the thread id."
  });
}

// Rank by id similarity using transcript filenames only, then read just the
// few winners for their names and previews.
// At most 5 candidates, as {id, name, score}: no previews (another agent's
// text) and no paths.
/**
 * @param {string} threadId
 */
export async function getThreadIdSuggestions(threadId) {
  const brief = (candidate) => ({
    id: candidate.id,
    name: typeof candidate.name === "string" ? truncate(candidate.name, 120) : null,
    score: candidate.score ?? null
  });
  return (await rankedThreadIdSuggestions(threadId)).slice(0, 5).map(brief);
}

/**
 * @param {string} threadId
 */
async function rankedThreadIdSuggestions(threadId) {
  try {
    const ids = await listLocalThreadIds();
    const ranked = suggestThreadIds(ids.map((entry) => ({ id: entry.id, path: entry.path })), threadId);
    const out = [];
    for (const suggestion of ranked) {
      try {
        const local = await readLocalThread(suggestion.id);
        const enriched = suggestThreadIds([summarizeThread(local.thread)], threadId)[0];
        out.push(enriched ?? suggestion);
      } catch {
        out.push(suggestion);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * @param {Record<string, any>} payload
 * @param {{includeReceipts?: boolean, receiptLimit?: number}} args
 * @param {string} threadId
 */
async function withOptionalReceipts(payload, args, threadId) {
  if (args.includeReceipts !== true) {
    return payload;
  }
  return {
    ...payload,
    agentLinkReceipts: await listReceipts({
      targetThreadId: threadId,
      limit: args.receiptLimit ?? LIMITS.receiptLimit.def
    })
  };
}

/**
 * @param {ThreadQueryDeps} deps
 */
export function makeThreadQueries({ appServer, now = () => Date.now(), wait = sleep }) {
  // Tool-facing wrappers. The internal functions keep their argument names
  // (searchTerm) because other tools call them; the tools take the canonical
  // `query` (section 3.3).
  /** @param {Record<string, any>} args */
  async function listThreadsTool(args) {
    const { query, ...rest } = args;
    return await listThreads({ ...rest, searchTerm: query });
  }

  /** @param {Record<string, any>} args */
  async function resolveThreadTool(args) {
    const result = await resolveThread(args);
    const status = result.candidates.length === 0
      ? "not_found"
      : result.selection.ambiguous ? "ambiguous" : "resolved";
    return { status, ...result };
  }

  /** @param {Record<string, any>} args */
  async function listThreads(args) {
    const limit = clamp(args.limit ?? LIMITS.list.def, LIMITS.list.min, LIMITS.list.max);
    const searchTerm = optionalString(args.searchTerm).trim();
    const archiveScope = normalizeArchiveScope(args);
    const includeSubagents = args.includeSubagents === true;

    try {
      const response = await collectAppServerThreadSummaries({
        archiveScope,
        limit,
        searchTerm,
        cwd: args.cwd ?? null
      });
      const appServerData = includeSubagents
        ? finalizeThreadResults(
            dedupeThreads([
              ...response.data,
              ...(await collectAppServerThreadSummaries({
                archiveScope,
                limit,
                searchTerm,
                cwd: args.cwd ?? null,
                sourceKinds: ["subAgentThreadSpawn"]
              })).data
            ]),
            { limit, searchTerm }
          )
        : response.data;
      const supplemented = await supplementSearchResultsFromLocalJsonl({
        data: appServerData,
        archiveScope,
        limit,
        searchTerm,
        cwd: args.cwd ?? null,
        useLocalFallback: args.useLocalFallback
      });
      return {
        ok: true,
        source: supplemented.source,
        appServer: appServer.getConnectionSummary(),
        archiveScope,
        stateSemantics: loadedStateSemantics(),
        nextCursor: response.nextCursor ?? null,
        backwardsCursor: response.backwardsCursor ?? null,
        localSearchSupplement: supplemented.localSearchSupplement,
        data: supplemented.data
      };
    } catch (error) {
      if (args.useLocalFallback === false) {
        throw error;
      }
      const local = await listLocalThreads({
        limit: searchTerm ? LOCAL_SEARCH_SCAN_LIMIT : limit,
        archiveScope,
        searchTerm: null,
        cwd: args.cwd ?? null
      });
      const data = finalizeThreadResults(local.data.map(summarizeThread), {
        limit,
        searchTerm
      });
      // local.source ("local-jsonl") must not replace the fallback label.
      return {
        ok: true,
        source: "local-jsonl-fallback",
        archiveScope: local.archiveScope ?? archiveScope,
        codexHome: local.codexHome ?? null,
        scannedFiles: local.scannedFiles ?? null,
        appServerError: error.message,
        stateSemantics: loadedStateSemantics(),
        data
      };
    }
  }

  /** @param {Record<string, any>} args */
  async function resolveThread(args) {
    const query = requiredString(args.query, "query").trim();
    const limit = clamp(args.limit ?? LIMITS.resolve.def, LIMITS.resolve.min, LIMITS.resolve.max);
    const archiveScope = args.archiveScope ?? "all";

    const response = await listThreads({
      archiveScope,
      limit: LIMITS.list.max,
      searchTerm: query,
      cwd: args.cwd ?? null,
      useLocalFallback: args.useLocalFallback
    });
    const candidates = rankThreadSummaries(response.data, query, limit);
    return {
      ok: true,
      source: response.source,
      archiveScope,
      query,
      best: candidates[0] ?? null,
      selection: buildResolveSelection(candidates),
      candidates,
      stateSemantics: loadedStateSemantics(),
      appServer: response.appServer ?? null,
      appServerError: response.appServerError ?? null
    };
  }

  /** @param {ThreadSummaryQuery} query */
  async function collectAppServerThreadSummaries({ archiveScope, limit, searchTerm, cwd, sourceKinds = null }) {
    const fetchLimit = searchTerm ? 100 : limit;
    const scopes = archiveScope === "all" ? ["active", "archived"] : [archiveScope];
    const responses = [];

    for (const scope of scopes) {
      const response = await appServer.request("thread/list", {
        limit: fetchLimit,
        archived: scope === "archived",
        searchTerm: null,
        cwd,
        sourceKinds
      });
      responses.push({ scope, response });
    }

    const summaries = dedupeThreads(
      responses.flatMap(({ response }) => response.data.map(summarizeThread))
    );

    return {
      nextCursor: archiveScope === "all"
        ? Object.fromEntries(responses.map(({ scope, response }) => [scope, response.nextCursor ?? null]))
        : responses[0]?.response.nextCursor ?? null,
      backwardsCursor: archiveScope === "all"
        ? Object.fromEntries(responses.map(({ scope, response }) => [scope, response.backwardsCursor ?? null]))
        : responses[0]?.response.backwardsCursor ?? null,
      data: finalizeThreadResults(summaries, { limit, searchTerm })
    };
  }

  /**
   * @param {{data: ThreadSummary[], archiveScope: string, limit: number, searchTerm: string, cwd: string | null, useLocalFallback?: boolean}} options
   */
  async function supplementSearchResultsFromLocalJsonl({ data, archiveScope, limit, searchTerm, cwd, useLocalFallback }) {
    if (!searchTerm || useLocalFallback === false) {
      return {
        source: "app-server",
        localSearchSupplement: null,
        data
      };
    }

    try {
      const local = await listLocalThreads({
        limit: LOCAL_SEARCH_SCAN_LIMIT,
        archiveScope,
        searchTerm: null,
        cwd
      });
      const localData = finalizeThreadResults(local.data.map(summarizeThread), {
        limit: LOCAL_SEARCH_SCAN_LIMIT,
        searchTerm
      });
      const originalIds = new Set(data.map((thread) => thread.id));
      const addedIds = localData
        .map((thread) => thread.id)
        .filter((id) => !originalIds.has(id));
      if (addedIds.length === 0) {
        return {
          source: "app-server",
          localSearchSupplement: {
            checked: true,
            addedCount: 0,
            scannedFiles: local.scannedFiles ?? null
          },
          data
        };
      }
      return {
        source: "app-server+local-jsonl-search",
        localSearchSupplement: {
          checked: true,
          addedCount: addedIds.length,
          addedIds: addedIds.slice(0, 20),
          scannedFiles: local.scannedFiles ?? null,
          note: "Search terms are supplemented from local JSONL so older active/archived matches are not hidden by app-server pagination."
        },
        data: finalizeThreadResults(dedupeThreads([...data, ...localData]), { limit, searchTerm })
      };
    } catch (error) {
      return {
        source: "app-server",
        localSearchSupplement: {
          checked: false,
          error: error.message
        },
        data
      };
    }
  }

  /** @param {Record<string, any>} args */
  async function getThread(args) {
    const includeTurns = args.includeTurns ?? false;
    const threadId = requiredString(args.threadId, "threadId");
    try {
      const response = await appServer.request("thread/read", {
        threadId,
        includeTurns
      });
      return await withOptionalReceipts({
        ok: true,
        source: "app-server",
        appServer: appServer.getConnectionSummary(),
        stateSemantics: loadedStateSemantics(),
        thread: summarizeThread(response.thread, {
          includeTurns,
          recentItems: args.recentItems ?? LIMITS.recentItems.def
        })
      }, args, threadId);
    } catch (error) {
      if (args.useLocalFallback === false) {
        throw await enrichThreadLookupError(error, threadId);
      }
      try {
        const local = await readLocalThread(threadId, {
          includeTurns,
          recentItems: args.recentItems ?? 20
        });
        return await withOptionalReceipts({
          ok: true,
          source: "local-jsonl-fallback",
          appServerError: error.message,
          stateSemantics: loadedStateSemantics(),
          thread: summarizeThread(local.thread, {
            includeTurns,
            recentItems: args.recentItems ?? 20
          })
        }, args, threadId);
      } catch (localError) {
        // Codes and booleans only: the raw errors carry local paths.
        throw await threadNotFound(threadId, {
          appServerReachable: error instanceof AppServerError && typeof error.code === "number",
          localTranscriptFound: false
        });
      }
    }
  }

  /** @param {Record<string, any>} args */
  async function waitForThread(args) {
    const threadId = requiredString(args.threadId, "threadId");
    let latest;
    try {
      latest = await waitForThreadRead({
        threadId,
        timeoutMs: args.timeoutMs,
        pollIntervalMs: args.pollIntervalMs
      });
    } catch (error) {
      throw await enrichThreadLookupError(error, threadId);
    }
    const waitState = latest.waitState;
    const observed = (latest.thread?.turns ?? []).find((turn) => turn.id === waitState.observedTurnId) ?? null;
    const outcome = latest.timedOut ? "timeout" : observed ? "turn_completed" : "idle";

    return {
      ok: true,
      outcome,
      waitedMs: latest.waitedMs,
      target: { threadId, address: codexAddress(threadId) },
      ...(outcome === "turn_completed"
        ? {
            turn: {
              turnId: observed.id ?? null,
              status: observed.status ?? null,
              finalResponse: waitState.finalResponse?.text ?? null,
              completedAt: toIso(observed.completedAt)
            }
          }
        : {}),
      source: "app-server",
      timedOut: latest.timedOut,
      finalResponse: latest.waitState.finalResponse,
      waitState: latest.waitState,
      warnings: latest.waitState.warnings,
      thread: summarizeThread(latest.thread, {
        includeTurns: true,
        recentItems: args.recentItems ?? 10
      }),
      stateSemantics: loadedStateSemantics(),
      appServer: appServer.getConnectionSummary()
    };
  }

  /**
   * @param {WaitReadArgs} args
   * @returns {Promise<WaitReadResult>}
   */
  async function waitForThreadRead(args) {
    const threadId = requiredString(args.threadId, "threadId");
    const timeoutMs = clamp(args.timeoutMs ?? LIMITS.timeoutMs.def, LIMITS.timeoutMs.min, LIMITS.timeoutMs.max);
    const pollIntervalMs = clamp(args.pollIntervalMs ?? LIMITS.pollIntervalMs.def, LIMITS.pollIntervalMs.min, LIMITS.pollIntervalMs.max);
    const startedAt = now();
    const deadline = startedAt + timeoutMs;
    let latest = null;
    let lastRetryableError = null;

    while (now() < deadline) {
      try {
        latest = await appServer.request("thread/read", { threadId, includeTurns: true });
        lastRetryableError = null;
      } catch (error) {
        if (isTransientIncludeTurnsUnavailable(error)) {
          lastRetryableError = error;
          await wait(pollIntervalMs);
          continue;
        }
        throw error;
      }
      const waitState = analyzeThreadWaitState(latest.thread, args.targetTurnId ?? null);
      if (!waitState.shouldContinueWaiting) {
        break;
      }
      await wait(pollIntervalMs);
    }

    if (!latest) {
      if (lastRetryableError) {
        throw lastRetryableError;
      }
      latest = await appServer.request("thread/read", { threadId, includeTurns: true });
    }

    const waitState = analyzeThreadWaitState(latest.thread, args.targetTurnId ?? null);
    return {
      timedOut: waitState.shouldContinueWaiting,
      waitedMs: now() - startedAt,
      thread: latest.thread,
      waitState
    };
  }

  /** @param {string} threadId */
  async function inferActiveTurnId(threadId) {
    const response = await appServer.request("thread/read", { threadId, includeTurns: true });
    const turns = response.thread.turns ?? [];
    const active = [...turns].reverse().find((turn) => turn.status === "inProgress");
    return active?.id ?? null;
  }

  return {
    listThreadsTool,
    resolveThreadTool,
    listThreads,
    resolveThread,
    collectAppServerThreadSummaries,
    getThread,
    waitForThread,
    waitForThreadRead,
    inferActiveTurnId,
    enrichThreadLookupError,
    threadNotFound
  };
}
