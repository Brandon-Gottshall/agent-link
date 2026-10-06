import { listClaudeSessions } from "../claude/session-index.js";
import { resolveSession } from "../claude/session-resolver.js";

export const claudeListingTools = [
  {
    name: "list_claude_sessions",
    description: "List Claude Desktop and Claude Code sessions. Returns normalized sessionId, cliSessionId, surface, title, cwd, loaded state, and supported receive surfaces.",
    inputSchema: {
      type: "object",
      properties: {
        includeArchived: { type: "boolean" },
        surface: { type: "string", enum: ["all", "desktop", "code"] },
        limit: { type: "number" }
      }
    }
  },
  {
    name: "list_loaded_claude_sessions",
    description: "List Claude Desktop and Claude Code sessions currently running as `claude --resume <uuid>` processes.",
    inputSchema: { type: "object", properties: { surface: { type: "string", enum: ["all", "desktop", "code"] } } }
  },
  {
    name: "get_claude_session",
    description: "Read one Claude Desktop or Claude Code session by sessionId or cliSessionId.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "resolve_claude_session",
    description: "Fuzzy lookup over title, processName, cwd, userSelectedFolders, and partial sessionId/cliSessionId. Returns ranked candidates and a selection block.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        surface: { type: "string", enum: ["all", "desktop", "code"] }
      },
      required: ["query"]
    }
  }
];

export function makeClaudeListingHandlers() {
  return {
    list_claude_sessions: async (args) => {
      let sessions = listClaudeSessions({
        includeArchived: args?.includeArchived === true,
        surface: args?.surface ?? "all"
      });
      if (args?.limit) sessions = sessions.slice(0, args.limit);
      return { sessions };
    },
    list_loaded_claude_sessions: async (args = {}) => {
      const sessions = listClaudeSessions({ surface: args.surface ?? "all" }).filter(s => s.loaded);
      return { sessions };
    },
    get_claude_session: async ({ sessionId }) => {
      const sessions = listClaudeSessions({ includeArchived: true });
      const found = sessions.find(s => s.sessionId === sessionId || s.cliSessionId === sessionId);
      if (!found) return { error: "not_found", sessionId };
      return { session: found };
    },
    resolve_claude_session: async ({ query, surface }) => {
      const sessions = listClaudeSessions({ surface: surface ?? "all", includeArchived: true });
      return resolveSession({ query }, sessions);
    }
  };
}
