// src/codex/loaded-threads.js
//
// Runtime-loaded Codex threads, the renderer sidebar state, and the loaded
// thread-spawn subagent registry (moved from src/server.js in PR B5,
// unchanged). Built by a factory taking the app-server client; nothing runs
// at import time.

import { AppServerError } from "./app-server-client.js";
import { clampInt as clamp, optionalString } from "../shared/args.js";
import { AgentLinkError } from "../shared/errors.js";
import { LIMITS } from "../server/schemas.js";
import {
  classifySidebarMembership,
  inferArchiveState,
  loadedStateSemantics,
  normalizeSidebarStateResponse,
  sidebarMembershipSemantics
} from "./thread-utils.js";

/** @typedef {import("./thread-queries.js").AppServerLike} AppServerLike */
/** @typedef {import("./thread-queries.js").ThreadSummaryQuery} ThreadSummaryQuery */

/**
 * A loaded thread as listed by thread/loaded/list (a bare id becomes {id}).
 * @typedef {{id: string, sidebarMembership?: string, [key: string]: any}} LoadedThreadEntry
 */

/**
 * The thread-spawn fields of a subagent thread's `source`.
 * @typedef {{
 *   parentThreadId: string | null,
 *   depth: number | null,
 *   agentPath: string | null,
 *   agentNickname: string | null,
 *   agentRole: string | null
 * }} ThreadSpawnSource
 */

/**
 * @typedef {{
 *   appServer: AppServerLike,
 *   collectAppServerThreadSummaries: (query: ThreadSummaryQuery) => Promise<{data: any[], nextCursor: any, backwardsCursor: any}>
 * }} LoadedThreadDeps
 */

// One page of loaded thread ids (cursor passes through to the app-server),
// or, with threadId, a scan of every page for that one thread so "is X
// loaded?" is a single call.
export const LOADED_LOOKUP_MAX_PAGES = 50;

/**
 * Loaded thread ids from a thread/loaded/list response.
 * @param {any} [response]
 * @returns {string[]}
 */
export function extractLoadedThreadIds(response = {}) {
  const values = Array.isArray(response.data)
    ? response.data
    : (Array.isArray(response.threadIds) ? response.threadIds : []);
  return values
    .map((entry) => typeof entry === "string" ? entry : entry?.id ?? entry?.threadId ?? entry?.localThreadId)
    .filter(Boolean);
}

/**
 * @param {any} [response]
 * @param {string[]} [loadedThreadIds]
 * @returns {LoadedThreadEntry[]}
 */
export function normalizeLoadedThreadEntries(response = {}, loadedThreadIds = []) {
  const values = Array.isArray(response.data)
    ? response.data
    : (Array.isArray(response.threadIds) ? response.threadIds : loadedThreadIds);
  return values
    .map((entry) => {
      if (typeof entry === "string") {
        return { id: entry };
      }
      if (entry && typeof entry === "object") {
        const id = entry.id ?? entry.threadId ?? entry.localThreadId ?? null;
        return {
          ...entry,
          id
        };
      }
      return null;
    })
    .filter((entry) => typeof entry?.id === "string" && entry.id.trim().length > 0);
}

/**
 * @param {any} thread  a thread summary
 * @param {string | undefined} sidebarMembership
 */
export function buildSubagentRegistryEntry(thread, sidebarMembership) {
  /** @type {Partial<ThreadSpawnSource>} */
  const spawn = extractThreadSpawnSource(thread.source) ?? {};
  return {
    id: thread.id,
    parentThreadId: spawn.parentThreadId ?? null,
    depth: spawn.depth ?? null,
    agentPath: spawn.agentPath ?? null,
    agentNickname: thread.agentNickname ?? spawn.agentNickname ?? null,
    agentRole: thread.agentRole ?? spawn.agentRole ?? null,
    status: thread.status ?? null,
    cwd: thread.cwd ?? null,
    path: thread.path ?? null,
    archiveState: thread.archiveState ?? inferArchiveState(thread),
    updatedAt: thread.updatedAt ?? null,
    sidebarMembership: sidebarMembership ?? "unknown",
    source: thread.source ?? null
  };
}

/**
 * @param {any} source  a thread's `source` field
 * @returns {ThreadSpawnSource | null}
 */
export function extractThreadSpawnSource(source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  const subagent = source.subAgent ?? source.subagent ?? null;
  if (!subagent || typeof subagent !== "object") {
    return null;
  }
  const spawn = subagent.threadSpawn ?? subagent.thread_spawn ?? null;
  if (!spawn || typeof spawn !== "object") {
    return null;
  }
  return {
    parentThreadId: spawn.parentThreadId ?? spawn.parent_thread_id ?? null,
    depth: spawn.depth ?? null,
    agentPath: spawn.agentPath ?? spawn.agent_path ?? null,
    agentNickname: spawn.agentNickname ?? spawn.agent_nickname ?? null,
    agentRole: spawn.agentRole ?? spawn.agent_role ?? null
  };
}

/**
 * @template {{parentThreadId?: string | null}} T
 * @param {T[]} subagents
 * @returns {Record<string, T[]>}
 */
export function groupSubagentsByParentThreadId(subagents) {
  /** @type {Record<string, T[]>} */
  const grouped = {};
  for (const subagent of subagents) {
    const parentThreadId = subagent.parentThreadId ?? "unknown";
    grouped[parentThreadId] ??= [];
    grouped[parentThreadId].push(subagent);
  }
  return grouped;
}

/**
 * @param {LoadedThreadDeps} deps
 */
export function makeLoadedThreads({ appServer, collectAppServerThreadSummaries }) {
  /** @param {{limit?: number, cursor?: string | null, threadId?: string}} args */
  async function readLoadedPage(args) {
    const limit = clamp(args.limit ?? LIMITS.list.def, LIMITS.list.min, LIMITS.list.max);
    if (!args.threadId) {
      const response = await appServer.request("thread/loaded/list", { limit, cursor: args.cursor ?? null });
      return { response, lookup: null };
    }
    let cursor = args.cursor ?? null;
    let pagesScanned = 0;
    while (pagesScanned < LOADED_LOOKUP_MAX_PAGES) {
      const page = await appServer.request("thread/loaded/list", { limit: LIMITS.list.max, cursor });
      pagesScanned += 1;
      const match = normalizeLoadedThreadEntries(page, extractLoadedThreadIds(page)).find((entry) => entry.id === args.threadId);
      if (match) {
        return { response: { data: [match], nextCursor: null }, lookup: { threadId: args.threadId, loaded: true, pagesScanned, complete: true } };
      }
      cursor = page.nextCursor ?? null;
      if (!cursor) break;
    }
    return {
      response: { data: [], nextCursor: null },
      lookup: { threadId: args.threadId, loaded: cursor ? null : false, pagesScanned, complete: !cursor }
    };
  }

  /** @param {{limit?: number, cursor?: string | null, threadId?: string}} args */
  async function listLoadedThreads(args) {
    const { response, lookup } = await readLoadedPage(args);
    const loadedThreadIds = extractLoadedThreadIds(response);
    const sidebarProbe = await readSidebarStateForMembership();
    const sidebarState = sidebarProbe.sidebarState;
    const loadedThreads = normalizeLoadedThreadEntries(response, loadedThreadIds).map((thread) => ({
      ...thread,
      sidebarMembership: classifySidebarMembership(thread.id, sidebarState)
    }));
    const sidebarMembershipByThreadId = Object.fromEntries(
      loadedThreads.map((thread) => [thread.id, thread.sidebarMembership])
    );
    const subagentRegistry = await buildLoadedSubagentRegistry({
      loadedThreads,
      sidebarMembershipByThreadId
    });

    return {
      ok: true,
      source: "app-server",
      appServer: appServer.getConnectionSummary(),
      stateSemantics: loadedStateSemantics(),
      // Named keys only: app-server response fields are not passed through.
      data: response.data ?? null,
      nextCursor: response.nextCursor ?? null,
      hasMore: Boolean(response.nextCursor),
      ...(lookup ? { lookup } : {}),
      sidebarState,
      sidebarStateError: sidebarProbe.error,
      sidebarMembershipSemantics: sidebarMembershipSemantics(),
      threadIds: Array.isArray(response.threadIds) ? response.threadIds : loadedThreadIds,
      loadedThreads,
      sidebarMembershipByThreadId,
      subagentRegistry
    };
  }

  /**
   * @param {{loadedThreads: LoadedThreadEntry[], sidebarMembershipByThreadId: Record<string, string>}} options
   */
  async function buildLoadedSubagentRegistry({ loadedThreads, sidebarMembershipByThreadId }) {
    const loadedThreadIds = new Set(
      loadedThreads
        .map((thread) => optionalString(thread.id).trim())
        .filter(Boolean)
    );
    const empty = {
      source: "app-server-thread-list",
      loadedSubagents: [],
      byParentThreadId: {},
      loadedSubagentCount: 0,
      error: null,
      note: "Thread-spawn subagents are tracked separately from renderer sidebar membership so background workers remain queryable even when the sidebar omits them."
    };
    if (loadedThreadIds.size === 0) {
      return empty;
    }

    try {
      const response = await collectAppServerThreadSummaries({
        archiveScope: "all",
        limit: 1000,
        searchTerm: "",
        cwd: null,
        sourceKinds: ["subAgentThreadSpawn"]
      });
      const loadedSubagents = response.data
        .filter((thread) => loadedThreadIds.has(thread.id))
        .map((thread) => buildSubagentRegistryEntry(thread, sidebarMembershipByThreadId[thread.id]));
      return {
        ...empty,
        loadedSubagents,
        byParentThreadId: groupSubagentsByParentThreadId(loadedSubagents),
        loadedSubagentCount: loadedSubagents.length
      };
    } catch (error) {
      return {
        ...empty,
        source: "app-server-thread-list-error",
        error: {
          message: error.message,
          details: error.details ?? null
        },
        note: "Loaded thread IDs were available, but Agent Link could not read subagent source metadata from thread/list."
      };
    }
  }

  // A missing capability is an `unsupported` error, not an ad-hoc object
  // (section 3.7). A transport failure stays codex_unavailable.
  async function getSidebarState(_args = {}) {
    let response;
    try {
      response = await appServer.request("desktop/sidebar/state/read", {});
    } catch (error) {
      if (error instanceof AppServerError && typeof error.code === "number") {
        throw new AgentLinkError("unsupported", "This Codex app-server does not support desktop/sidebar/state/read.", {
          details: { capability: "desktop/sidebar/state/read", rpcCode: error.code, rpcMessage: error.message },
          hint: "Sidebar state needs a Codex Desktop app-server with renderer authority. Agent Link does not infer GUI membership."
        });
      }
      throw error;
    }
    const sidebarState = normalizeSidebarStateResponse(response);
    if (sidebarState.supported === false) {
      throw new AgentLinkError("unsupported", "The Codex app-server reports sidebar state as unsupported.", {
        details: { capability: "desktop/sidebar/state/read", reason: sidebarState.unsupported?.reason ?? null, authority: sidebarState.authority ?? null },
        hint: "Sidebar state needs a Codex Desktop app-server with renderer authority. Agent Link does not infer GUI membership."
      });
    }
    return {
      ok: true,
      source: "app-server",
      appServer: appServer.getConnectionSummary(),
      sidebarState,
      sidebarMembershipSemantics: sidebarMembershipSemantics()
    };
  }

  async function readSidebarStateForMembership() {
    try {
      const response = await appServer.request("desktop/sidebar/state/read", {});
      return {
        sidebarState: normalizeSidebarStateResponse(response),
        error: null
      };
    } catch (error) {
      return {
        sidebarState: normalizeSidebarStateResponse(null),
        error: {
          message: error.message,
          details: error.details ?? null,
          note: "Sidebar state read failed; loaded thread sidebarMembership is unknown because Agent Link does not infer GUI membership from runtime-loaded state."
        }
      };
    }
  }

  return { readLoadedPage, listLoadedThreads, getSidebarState };
}
