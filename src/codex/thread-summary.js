// src/codex/thread-summary.js
//
// Pure shaping of app-server threads, turns and items into tool output
// (moved from src/server.js in PR B5, unchanged). No I/O, no app-server.

import { clampInt as clamp } from "../shared/args.js";
import { toIso, truncate } from "../shared/text.js";
import { LIMITS } from "../server/schemas.js";
import { inferArchiveState } from "./thread-utils.js";

/**
 * A thread as the app-server (or the local-transcript reader) reports it.
 * Only the fields Agent Link reads are listed; others pass through untouched.
 * @typedef {{
 *   id: string,
 *   name?: string | null,
 *   preview?: string | null,
 *   status?: any,
 *   createdAt?: number | null,
 *   updatedAt?: number | null,
 *   cwd?: string | null,
 *   path?: string | null,
 *   archiveState?: any,
 *   source?: any,
 *   modelProvider?: string | null,
 *   cliVersion?: string | null,
 *   forkedFromId?: string | null,
 *   agentNickname?: string | null,
 *   agentRole?: string | null,
 *   localOnly?: boolean,
 *   originator?: string | null,
 *   lastEventType?: string | null,
 *   lastAgentMessage?: string | null,
 *   recentItems?: any[],
 *   turns?: AppServerTurn[],
 *   [key: string]: any
 * }} AppServerThread
 */

/**
 * @typedef {{
 *   id?: string | null,
 *   status?: string | null,
 *   startedAt?: number | null,
 *   completedAt?: number | null,
 *   durationMs?: number | null,
 *   error?: any,
 *   items?: any[],
 *   [key: string]: any
 * }} AppServerTurn
 */

/**
 * The thread summary every Codex thread tool returns.
 * @typedef {{
 *   id: string,
 *   name: string | null,
 *   preview: string,
 *   status: any,
 *   createdAt: string | null,
 *   updatedAt: string | null,
 *   cwd: string | null,
 *   path: string | null,
 *   archiveState: any,
 *   source: any,
 *   modelProvider: string | null,
 *   cliVersion: string | null,
 *   forkedFromId: string | null,
 *   agentNickname: string | null,
 *   agentRole: string | null,
 *   localOnly?: boolean,
 *   originator?: string | null,
 *   lastEventType?: string | null,
 *   lastAgentMessage?: string | null,
 *   recentItems?: any[],
 *   turns?: any[],
 *   [key: string]: any
 * }} ThreadSummary
 */

/**
 * Also used directly as an Array#map callback, where `options` is the index
 * (a number has no includeTurns, so turns are left out).
 * @param {AppServerThread} thread
 * @param {any} [options]  {includeTurns?: boolean, recentItems?: number}
 * @returns {ThreadSummary}
 */
export function summarizeThread(thread, options = {}) {
  /** @type {ThreadSummary} */
  const summary = {
    id: thread.id,
    name: thread.name ?? null,
    preview: truncate(thread.preview ?? "", 700),
    status: thread.status,
    createdAt: toIso(thread.createdAt),
    updatedAt: toIso(thread.updatedAt),
    cwd: thread.cwd ?? null,
    path: thread.path ?? null,
    archiveState: thread.archiveState ?? inferArchiveState(thread),
    source: thread.source ?? null,
    modelProvider: thread.modelProvider ?? null,
    cliVersion: thread.cliVersion ?? null,
    forkedFromId: thread.forkedFromId ?? null,
    agentNickname: thread.agentNickname ?? null,
    agentRole: thread.agentRole ?? null
  };

  if (thread.localOnly) {
    summary.localOnly = true;
    summary.originator = thread.originator ?? null;
    summary.lastEventType = thread.lastEventType ?? null;
    summary.lastAgentMessage = thread.lastAgentMessage ?? null;
  }

  if (options.includeTurns) {
    const limit = clamp(options.recentItems ?? LIMITS.recentItems.def, LIMITS.recentItems.min, LIMITS.recentItems.max);
    if (thread.recentItems) {
      summary.recentItems = limit === 0 ? [] : thread.recentItems.slice(-limit);
    } else {
      const window = recentItemWindow(thread.turns ?? [], limit);
      summary.recentItems = window.items;
      summary.turns = window.turns;
    }
  }

  return summary;
}

// The newest `limit` items across turns (oldest first, each tagged with its
// turn), plus those turns with their items trimmed to the same window.
/**
 * @param {AppServerTurn[]} turns
 * @param {number} limit
 * @returns {{items: any[], turns: any[]}}
 */
export function recentItemWindow(turns, limit) {
  const items = [];
  const windowTurns = [];
  for (let index = turns.length - 1; index >= 0 && items.length < limit; index -= 1) {
    const turn = turns[index];
    const turnItems = (turn.items ?? []).map(summarizeItem);
    const kept = turnItems.slice(Math.max(0, turnItems.length - (limit - items.length)));
    items.unshift(...kept.map((item) => ({ ...item, turnId: turn.id ?? null })));
    windowTurns.unshift({
      ...summarizeTurn({ ...turn, items: [] }),
      items: kept,
      ...(kept.length < turnItems.length ? { itemsOmitted: turnItems.length - kept.length } : {})
    });
  }
  return { items, turns: windowTurns };
}

/**
 * @param {AppServerTurn} turn
 */
export function summarizeTurn(turn) {
  return {
    id: turn.id,
    status: turn.status,
    startedAt: toIso(turn.startedAt),
    completedAt: toIso(turn.completedAt),
    durationMs: turn.durationMs ?? null,
    error: turn.error ?? null,
    items: (turn.items ?? []).map(summarizeItem)
  };
}

// App-server item fields that are identifiers (tool names, ids, types) are
// passed only when they look like identifiers, so another agent's thread
// cannot smuggle free text into a tool result through them. Free text
// (messages, reasoning, commands) is handled by the peer envelope.
const ITEM_ID_PATTERN = /^[A-Za-z0-9_.:@/+-]{1,128}$/;

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeId(value) {
  return typeof value === "string" && ITEM_ID_PATTERN.test(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function safeIdList(value) {
  return Array.isArray(value) ? value.map(safeId).filter(Boolean).slice(0, 50) : [];
}

/**
 * @param {any} item  an app-server thread item
 */
export function summarizeItem(item) {
  const type = safeId(item?.type) ?? "unknown";
  const id = safeId(item?.id);
  switch (type) {
    case "userMessage":
      return { type, id, text: summarizeUserContent(item.content) };
    case "agentMessage":
      return { type, id, text: truncate(item.text ?? "", 1000), phase: safeId(item.phase) };
    case "reasoning":
      return { type, id, summary: (Array.isArray(item.summary) ? item.summary : []).map((text) => truncate(String(text), 500)) };
    case "commandExecution":
      return {
        type,
        id,
        command: truncate(item.command ?? "", 500),
        status: safeId(item.status),
        exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
        durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null
      };
    case "mcpToolCall":
      return {
        type,
        id,
        server: safeId(item.server),
        tool: safeId(item.tool),
        status: safeId(item.status),
        durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null
      };
    case "collabAgentToolCall":
      return {
        type,
        id,
        tool: safeId(item.tool),
        status: safeId(item.status),
        receiverThreadIds: safeIdList(item.receiverThreadIds),
        agentsStates: item.agentsStates && typeof item.agentsStates === "object" ? item.agentsStates : {}
      };
    default:
      return { type, id };
  }
}

/**
 * @param {any[] | null | undefined} content  userMessage content entries
 * @returns {string}
 */
export function summarizeUserContent(content) {
  return (content ?? []).map((entry) => {
    if (entry.type === "text") {
      return truncate(entry.text ?? "", 1000);
    }
    if (entry.type === "localImage") {
      return `[localImage] ${entry.path}`;
    }
    if (entry.type === "image") {
      return `[image] ${entry.url}`;
    }
    if (entry.type === "mention" || entry.type === "skill") {
      return `[${entry.type}] ${entry.name}`;
    }
    return `[${entry.type}]`;
  }).join("\n");
}
