// src/tools/claude-listing.js
//
// Claude session listing tools: list_claude_sessions,
// list_loaded_claude_sessions, get_claude_session, resolve_claude_session.
// Registered on the Claude host only (host-neutral registration is a later
// release, design doc section 1.6).
import { listClaudeSessions } from "../claude/session-index.js";
import { resolveSession } from "../claude/session-resolver.js";
import { claudeSessionMatches } from "../claude/identity.js";
import { AgentLinkError } from "../shared/errors.js";
import { CLAUDE_SURFACES, LIMITS, enumOf, bool, limit, out, str } from "../server/schemas.js";

/** @typedef {import("../server/registry.js").ToolDefinition} ToolDefinition */
/** @typedef {import("../server/registry.js").ToolEntry} ToolEntry */

const surface = enumOf(CLAUDE_SURFACES, "Only sessions on this surface: desktop, code, or all. Defaults to all.");
const READ_ONLY = { readOnlyHint: true };
const sessionsOut = { sessions: out("array", "Normalized sessions: sessionId, cliSessionId, surface, title, cwd, loaded, isArchived, and supported receive surfaces.") };

/** @type {ToolDefinition[]} */
export const claudeListingTools = [
  {
    name: "list_claude_sessions",
    description: "List Claude Desktop and Claude Code sessions, most recently active first. Returns normalized sessionId, cliSessionId, surface, title, cwd, loaded state, and supported receive surfaces.",
    inputSchema: {
      type: "object",
      properties: {
        includeArchived: bool("Include archived sessions. Defaults to false."),
        surface,
        limit: limit("list", "sessions")
      },
      additionalProperties: false
    },
    output: sessionsOut,
    annotations: READ_ONLY
  },
  {
    name: "list_loaded_claude_sessions",
    description: "List Claude Desktop and Claude Code sessions currently running as `claude --resume <uuid>` processes.",
    inputSchema: {
      type: "object",
      properties: {
        surface,
        limit: limit("list", "sessions")
      },
      additionalProperties: false
    },
    output: sessionsOut,
    annotations: READ_ONLY
  },
  {
    name: "get_claude_session",
    description: "Read one Claude Desktop or Claude Code session by sessionId or cliSessionId, archived sessions included. An unknown id is a not_found error.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: str("Exact sessionId (local_<uuid>) or cliSessionId.")
      },
      required: ["sessionId"],
      additionalProperties: false
    },
    output: { session: out("object", "The session.") },
    annotations: READ_ONLY
  },
  {
    name: "resolve_claude_session",
    description: "Fuzzy lookup over title, processName, cwd, userSelectedFolders, and partial sessionId/cliSessionId. Returns ranked candidates, a selection block, and the verdict in status: resolved, ambiguous, or not_found (not an error).",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Title, cwd, folder, or partial session id."),
        surface,
        limit: limit("resolve", "candidates")
      },
      required: ["query"],
      additionalProperties: false
    },
    output: {
      status: enumOf(["resolved", "ambiguous", "not_found"], "Verdict: one best match, several tied, or none."),
      query: out("string", "The query as given."),
      best: out(["object", "null"], "The top candidate, or null."),
      candidates: out("array", "Ranked candidates with score and matchReasons."),
      selection: out("object", "{ambiguous, matchReasons} for the top candidate.")
    },
    annotations: READ_ONLY
  }
];

/**
 * @param {Record<string, any>} args
 * @param {keyof typeof LIMITS} kind
 */
function limitOf(args, kind) {
  return typeof args.limit === "number" ? args.limit : LIMITS[kind].def;
}

export function makeClaudeListingHandlers() {
  return {
    /** @param {Record<string, any>} [args] */
    list_claude_sessions: async (args = {}) => {
      const sessions = listClaudeSessions({
        includeArchived: args.includeArchived === true,
        surface: args.surface ?? "all"
      });
      return { sessions: sessions.slice(0, limitOf(args, "list")) };
    },
    /** @param {Record<string, any>} [args] */
    list_loaded_claude_sessions: async (args = {}) => {
      const sessions = listClaudeSessions({ surface: args.surface ?? "all" }).filter((s) => s.loaded);
      return { sessions: sessions.slice(0, limitOf(args, "list")) };
    },
    /** @param {Record<string, any>} [args] */
    get_claude_session: async ({ sessionId } = {}) => {
      const sessions = listClaudeSessions({ includeArchived: true });
      const found = sessions.find((s) => claudeSessionMatches(s, sessionId));
      if (!found) {
        throw new AgentLinkError("not_found", `No Claude session matches ${JSON.stringify(String(sessionId))}.`, {
          details: { query: sessionId, candidates: [] },
          hint: "Call resolve_claude_session or list_claude_sessions to find the session id."
        });
      }
      return { session: found };
    },
    /** @param {Record<string, any>} [args] */
    resolve_claude_session: async (args = {}) => {
      const sessions = listClaudeSessions({ surface: args.surface ?? "all", includeArchived: true });
      const result = resolveSession({ query: args.query }, sessions);
      const candidates = result.candidates.slice(0, limitOf(args, "resolve"));
      const status = !result.best ? "not_found" : result.selection.ambiguous ? "ambiguous" : "resolved";
      return { status, query: args.query, best: result.best ?? null, candidates, selection: result.selection };
    }
  };
}

/** @returns {ToolEntry[]} */
export function claudeListingEntries() {
  const handlers = makeClaudeListingHandlers();
  return claudeListingTools.map((definition) => ({
    definition,
    handler: (args) => handlers[/** @type {keyof typeof handlers} */ (definition.name)](args)
  }));
}
