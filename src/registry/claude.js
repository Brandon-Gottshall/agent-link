// src/registry/claude.js
//
// Claude provider for the session registry (design doc section 1.4). Reads
// the Claude session index (Desktop sidecars and Claude Code transcripts
// under the Claude config dir, `ps` for loaded) on any host. A machine with
// no Claude data is reported as unavailable with an empty list (R1.8).

import fs from "node:fs";
import {
  DEFAULT_CODE_ROOT,
  DEFAULT_DESKTOP_ROOT,
  findClaudeSessionById,
  isClaudeSessionLoaded,
  listClaudeSessions,
  summarizeTranscriptSession
} from "../claude/session-index.js";
import { claudeConfigDir } from "../shared/host-detect.js";
import { claudeAddress, canonicalizeClaudeId } from "../shared/identity.js";

/** @typedef {import("./index.js").AgentSession} AgentSession */
/** @typedef {import("./index.js").ProviderList} ProviderList */

/**
 * @param {unknown} ms
 * @returns {string | null}
 */
function isoFromMs(ms) {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/**
 * A Claude session index entry as a registry session.
 * @param {Record<string, any>} session
 * @returns {AgentSession | null}
 */
export function toClaudeAgent(session) {
  const address = claudeAddress(session);
  if (!address) return null;
  return {
    address,
    harness: "claude",
    id: address.slice("claude:".length),
    title: typeof session.title === "string" && session.title ? session.title : null,
    cwd: typeof session.cwd === "string" && session.cwd ? session.cwd : null,
    surface: typeof session.surface === "string" ? [session.surface] : [],
    loaded: session.loaded === true,
    archived: session.isArchived === true,
    lastActivityAt: isoFromMs(session.lastActivityAt),
    receive: {
      push: session.supportsChannel === true ? "channel" : null,
      nudge: "claude-hook",
      pull: true
    },
    sessionId: session.sessionId ?? null,
    cliSessionId: session.cliSessionId ?? null
  };
}

/**
 * @param {string} dir
 */
function exists(dir) {
  try {
    return fs.existsSync(dir);
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   list?: typeof listClaudeSessions,
 *   find?: typeof findClaudeSessionById,
 *   isLoaded?: typeof isClaudeSessionLoaded,
 *   summarize?: (file: string) => any,
 *   roots?: () => string[]
 * }} [deps]
 */
export function makeClaudeProvider({
  list = listClaudeSessions,
  find = findClaudeSessionById,
  isLoaded = isClaudeSessionLoaded,
  summarize = (file) => summarizeTranscriptSession(file),
  roots = () => [claudeConfigDir(), DEFAULT_DESKTOP_ROOT, DEFAULT_CODE_ROOT]
} = {}) {
  function availability() {
    const searched = roots();
    const available = searched.some(exists);
    return { available, reason: available ? null : "No Claude config directory or Claude Desktop session store was found.", searched };
  }

  /**
   * @param {{includeArchived?: boolean}} [options]
   * @returns {Promise<ProviderList>}
   */
  async function listSessions({ includeArchived = false } = {}) {
    const status = availability();
    // No Claude data on this machine (R1.8): empty list plus a warning.
    if (!status.available) {
      return {
        ...status,
        source: null,
        sessions: [],
        warnings: [{ code: "claude_unavailable", message: `${status.reason} Claude sessions are not listed.` }]
      };
    }
    try {
      const sessions = list({ includeArchived, surface: "all" })
        .map(toClaudeAgent)
        .filter(/** @returns {s is AgentSession} */ (s) => s !== null);
      return { ...status, source: "claude-session-index", sessions, warnings: [] };
    } catch (error) {
      return {
        ...status,
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        source: "claude-session-index",
        sessions: [],
        warnings: [{ code: "claude_unavailable", message: "The Claude session index could not be read; Claude sessions are not listed." }]
      };
    }
  }

  /**
   * One session by any Claude id form (address, local_<uuid>, CLI id),
   * archived included; null when unknown.
   * @param {string} id
   * @returns {Promise<AgentSession | null>}
   */
  async function get(id) {
    const raw = String(id ?? "").trim().replace(/^claude:/, "");
    if (!raw) return null;
    // The indexed lookup (sidecar id, current or prior CLI id, transcript
    // file), never a full listing: one sidecar walk over cached parses at
    // most, plus one `ps` for loaded.
    let session = null;
    try {
      session = find(raw);
      // An address carries the CLI id; a sidecar may know it only under a
      // `local_` name when the CLI id was never seen, so try that too.
      if (!session && canonicalizeClaudeId(raw) === raw && !raw.startsWith("local_")) session = find(`local_${raw}`);
    } catch {
      session = null;
    }
    if (!session) return null;
    // A transcript-only hit carries no title or cwd; read that one
    // transcript's summary for them.
    if (session.source === "transcript" && session.transcriptPath) {
      try {
        const summary = summarize(session.transcriptPath);
        if (summary) session = { ...summary, ...session, title: summary.title ?? session.title, cwd: summary.cwd || session.cwd };
      } catch {
        // keep the bare entry
      }
    }
    let loaded = false;
    try {
      loaded = isLoaded(session.cliSessionId);
    } catch {
      loaded = false;
    }
    return toClaudeAgent({ ...session, loaded });
  }

  return { harness: /** @type {"claude"} */ ("claude"), list: listSessions, get, availability };
}
