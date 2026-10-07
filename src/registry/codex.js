// src/registry/codex.js
//
// Codex provider for the session registry (design doc section 1.4). Lists
// threads through the Codex app-server when it is reachable and falls back to
// the local transcript index otherwise, on any host. When neither answers,
// the provider is unavailable and returns an empty list plus a warning (R1.8).

import fs from "node:fs";
import path from "node:path";
import { describeCodexInstall } from "../codex/app-server-client.js";
import { readLocalThread } from "../codex/session-index.js";
import { summarizeThread } from "../codex/thread-summary.js";
import { codexAddress } from "../shared/identity.js";
import { codexHome } from "../shared/paths.js";

/** @typedef {import("./index.js").AgentSession} AgentSession */
/** @typedef {import("./index.js").ProviderList} ProviderList */
/** @typedef {import("../codex/thread-queries.js").AppServerLike} AppServerLike */

// Thread `source` values as the app-server reports them, mapped to the
// section 1.1 surfaces. The desktop app and the IDE extension report
// "vscode"; `codex` and `codex exec` report "cli" and "exec". Other sources
// (app-server clients, subagents) have no user-facing surface.
const SURFACE_BY_SOURCE = Object.freeze({ vscode: "app", cli: "cli", exec: "cli" });
const LOADED_STATUS = new Set(["idle", "active", "systemError"]);

/**
 * @param {unknown} source
 * @returns {string[]}
 */
export function codexSurfaces(source) {
  const surface = typeof source === "string" ? SURFACE_BY_SOURCE[/** @type {keyof typeof SURFACE_BY_SOURCE} */ (source)] : undefined;
  return surface ? [surface] : [];
}

/**
 * A Codex thread summary (summarizeThread output) as a registry session.
 * `loaded` is true only when the app-server reports the thread loaded; a
 * transcript read without the app-server cannot tell, so it is false.
 * @param {Record<string, any>} thread
 * @param {{fromAppServer?: boolean}} [options]
 * @returns {AgentSession | null}
 */
// No raw preview (another agent's text) in registry sessions: list_agents and
// resolve_agent return only metadata. list_codex_threads keeps its preview,
// documented there as untrusted.
export function toCodexAgent(thread, { fromAppServer = true } = {}) {
  const address = codexAddress(thread?.id);
  if (!address) return null;
  const statusType = typeof thread.status === "string" ? thread.status : thread.status?.type ?? null;
  return {
    address,
    harness: "codex",
    id: address.slice("codex:".length),
    title: typeof thread.name === "string" && thread.name ? thread.name : null,
    cwd: typeof thread.cwd === "string" && thread.cwd ? thread.cwd : null,
    surface: codexSurfaces(thread.source),
    loaded: fromAppServer && LOADED_STATUS.has(statusType),
    archived: thread.archiveState?.scope === "archived",
    lastActivityAt: typeof thread.updatedAt === "string" ? thread.updatedAt : null,
    // nudge: the Codex prompt hook (R1.9, R1.14), once the user trusts it.
    receive: { push: "codex-turn", nudge: "codex-hook", pull: false },
    threadId: thread.id,
    status: statusType
  };
}

/**
 * Whether Codex is installed here: a Codex binary, or Codex session storage
 * under CODEX_HOME. Cheap (no `codex --version`).
 * @returns {{installed: boolean, reason: string | null}}
 */
export function codexInstallState() {
  let binary = { available: false, reason: null };
  try {
    binary = describeCodexInstall({ probeVersion: false });
  } catch {
    // treated as no binary
  }
  if (binary.available) return { installed: true, reason: null };
  let home = null;
  try {
    home = codexHome();
  } catch {
    home = null;
  }
  const hasSessions = Boolean(home) && ["sessions", "archived_sessions"].some((dir) => {
    try {
      return fs.existsSync(path.join(/** @type {string} */ (home), dir));
    } catch {
      return false;
    }
  });
  return hasSessions
    ? { installed: true, reason: null }
    : { installed: false, reason: "Codex is not installed: no Codex binary was found and CODEX_HOME has no session storage." };
}

/**
 * @param {{
 *   appServer: AppServerLike,
 *   listThreads: (args: Record<string, any>) => Promise<{source: string, data: any[], appServerError?: string | null}>,
 *   readLocal?: typeof readLocalThread,
 *   installState?: () => {installed: boolean, reason: string | null}
 * }} deps
 */
export function makeCodexProvider({ appServer, listThreads, readLocal = readLocalThread, installState = codexInstallState }) {
  /**
   * @param {{includeArchived?: boolean, limit?: number, searchTerm?: string}} [options]
   * @returns {Promise<ProviderList>}
   */
  async function listSessions({ includeArchived = false, limit = 200, searchTerm = "" } = {}) {
    try {
      const result = await listThreads({
        archiveScope: includeArchived ? "all" : "active",
        limit,
        searchTerm,
        useLocalFallback: true
      });
      const fromAppServer = !String(result.source).startsWith("local-jsonl");
      const sessions = result.data
        .map((thread) => toCodexAgent(thread, { fromAppServer }))
        .filter(/** @returns {s is AgentSession} */ (s) => s !== null);
      // No app-server and nothing on disk: say whether Codex is installed at
      // all, instead of reporting an empty but available provider (R1.8).
      if (!fromAppServer && sessions.length === 0) {
        const install = installState();
        if (!install.installed) {
          return {
            available: false,
            reason: install.reason,
            source: null,
            sessions: [],
            warnings: [{ code: "codex_unavailable", message: `${install.reason} Codex threads are not listed.` }]
          };
        }
      }
      const warnings = fromAppServer
        ? []
        : [{ code: "codex_unavailable", message: "The Codex app-server was not reachable; Codex threads were listed from local transcripts and report loaded=false." }];
      return {
        available: true,
        reason: fromAppServer ? null : result.appServerError ?? null,
        source: result.source,
        sessions,
        warnings
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        source: null,
        sessions: [],
        warnings: [{ code: "codex_unavailable", message: "Neither the Codex app-server nor local Codex transcripts could be read; Codex threads are not listed." }]
      };
    }
  }

  /**
   * One thread by id (bare or address), archived included; null when
   * neither the app-server nor the local transcripts know it.
   * @param {string} id
   * @returns {Promise<AgentSession | null>}
   */
  async function get(id) {
    const threadId = String(id ?? "").trim().replace(/^codex:/, "");
    if (!codexAddress(threadId)) return null;
    try {
      const response = await appServer.request("thread/read", { threadId, includeTurns: false });
      if (response?.thread) return toCodexAgent(summarizeThread(response.thread));
    } catch {
      // not known to the app-server, or no app-server: try the transcripts
    }
    try {
      const local = await readLocal(threadId, { includeTurns: false });
      if (local?.thread) return toCodexAgent(summarizeThread(local.thread), { fromAppServer: false });
    } catch {
      // unknown thread
    }
    return null;
  }

  return { harness: /** @type {"codex"} */ ("codex"), list: listSessions, get };
}
