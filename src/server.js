#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  AppServerError,
  CodexAppServerClient,
  asUserTextInput,
  describeCodexInstall,
  reapOrphanedManagedAppServers
} from "./codex/app-server-client.js";
import {
  callerContextContract,
  extractRuntimeCallerContext,
  summarizeRuntimeCallerContext
} from "./shared/caller-context.js";
import { detectHost, currentClaudeSessionId } from "./shared/host-detect.js";
import { claudeListingTools, makeClaudeListingHandlers } from "./tools/claude-listing.js";
import { claudeSendTool, makeClaudeSendHandler } from "./tools/claude-send.js";
import { claudeWaitTool, makeWaitHandler } from "./tools/claude-wait.js";
import { mailboxInspectTool, makeMailboxInspectHandler } from "./tools/mailbox-inspect.js";
import { readInboxTool, makeReadInboxHandler } from "./tools/read-inbox.js";
import { replyAgentLinkMessageTool, makeReplyAgentLinkMessageHandler } from "./tools/claude-reply.js";
import { makeAgentLinkChannelBridge } from "./claude/channel-bridge.js";
import { listClaudeSessions, resolveCurrentClaudeSession } from "./claude/session-index.js";
import { mailboxStatus } from "./claude/mailbox.js";
import {
  buildReceipt,
  listReceipts,
  normalizeReceiptInput,
  receiptIndexSummary,
  safeAppendReceipt
} from "./shared/receipt-index.js";
import {
  launchProjectWorker,
  messageProjectOrchestrator,
  resolveProjectOrchestrator,
  returnProjectWorkResult
} from "./codex/project-orchestrator.js";
import {
  checkCoordinationObligations,
  registerDependencyHandoff
} from "./codex/dependency-handoff.js";
import {
  archiveLocalThread,
  findLocalThreadFile,
  listLocalThreadIds,
  listLocalThreads,
  readLocalThread
} from "./codex/session-index.js";
import {
  activeTurnWarning,
  analyzeThreadWaitState,
  buildStateContract,
  classifySidebarMembership,
  extractFinalResponse,
  inferArchiveState,
  isRiskyParallelStatus,
  loadedStateSemantics,
  normalizeSidebarStateResponse,
  normalizeArchiveScope,
  rankThreadSummaries,
  sidebarMembershipSemantics,
  suggestThreadIds,
  unsupportedSidebarStateResponse
} from "./codex/thread-utils.js";

const HOST_INFO = detectHost();

const claudeHandlers = HOST_INFO.host === "claude" ? makeClaudeListingHandlers() : null;
const claudeToolDefs = HOST_INFO.host === "claude" ? claudeListingTools : [];

// The current Claude session never changes for the life of this server.
// Resolve it with the fast lookup (sidecar or transcript by id, no `ps`, no
// full listing) and memoize. A transcript-only result is re-checked at most
// every 30 s, in case the Desktop sidecar (which owns the canonical id)
// appears after startup; a miss is retried at most every 5 s.
const CURRENT_SESSION_RECHECK_MS = 30_000;
const CURRENT_SESSION_MISS_RETRY_MS = 5_000;
let currentClaudeSessionMemo = null;
function currentClaudeSession() {
  if (HOST_INFO.host !== "claude") return null;
  const now = Date.now();
  const memo = currentClaudeSessionMemo;
  if (memo) {
    const ttl = !memo.session
      ? CURRENT_SESSION_MISS_RETRY_MS
      : memo.session.source === "transcript" ? CURRENT_SESSION_RECHECK_MS : Infinity;
    if (now - memo.at < ttl) return memo.session;
  }
  let session = null;
  try {
    session = resolveCurrentClaudeSession({ sessionId: currentClaudeSessionId() });
  } catch {
    session = null;
  }
  currentClaudeSessionMemo = { session: session ?? memo?.session ?? null, at: now };
  return currentClaudeSessionMemo.session;
}
const mailboxInspectHandlers = makeMailboxInspectHandler({
  host: HOST_INFO.host,
  resolveCurrentSession: currentClaudeSession
});
const messageClaudeSessionHandlers = makeClaudeSendHandler({
  host: HOST_INFO.host,
  resolveCurrentSession: currentClaudeSession
});
const waitClaudeSessionHandlers = makeWaitHandler({
  host: HOST_INFO.host,
  resolveCurrentSession: currentClaudeSession
});
const readInboxHandlers = makeReadInboxHandler({
  resolveCurrentSession: currentClaudeSession
});
const replyAgentLinkMessageHandlers = makeReplyAgentLinkMessageHandler({
  host: HOST_INFO.host,
  resolveCurrentSession: currentClaudeSession
});

// Replaced with package.json's version when scripts/build.mjs bundles dist/server.mjs.
const SERVER_VERSION = typeof __AGENT_LINK_VERSION__ === "string" ? __AGENT_LINK_VERSION__ : "0.0.0-dev";

const server = new Server(
  {
    name: "agent-link",
    version: SERVER_VERSION
  },
  {
    instructions:
      "Agent Link messages may arrive as <agent-link-message> channel events. " +
      "Use reply_agent_link_message with the messageId to reply to an inbound Agent Link message.",
    capabilities: {
      tools: {},
      experimental: HOST_INFO.host === "claude" && process.env.AGENT_LINK_DISABLE_CHANNEL !== "1"
        ? { "claude/channel": {} }
        : {}
    }
  }
);

const appServer = new CodexAppServerClient();

// Local transcript fallbacks read at most this many of the newest transcripts
// when a search has to be answered from disk (they used to read up to 2,000).
const LOCAL_SEARCH_SCAN_LIMIT = 300;

const receiptInputSchema = {
  type: "object",
  description: "Optional provenance metadata for the local Agent Link receipt index. Receipts are recorded by default for launch/message/archive actions; set record=false to opt out.",
  properties: {
    record: {
      type: "boolean",
      description: "When false, skip writing a receipt for this action. Defaults to true."
    },
    purpose: {
      type: "string",
      description: "Short human-readable reason, such as WF verification, handoff, coordination, or receipt test."
    },
    originThreadId: {
      type: "string",
      description: "Thread ID that caused this action, when known."
    },
    originTurnId: {
      type: "string",
      description: "Turn ID that caused this action, when known."
    },
    originToolCallId: {
      type: "string",
      description: "Tool call ID that caused this action, when known."
    },
    cleanupRecommendation: {
      type: "string",
      description: "Caller guidance for the created, messaged, or archived thread, for example archiveable, archived, keep_as_evidence, or review_before_archive."
    },
    note: {
      type: "string",
      description: "Brief extra provenance note."
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Optional searchable tags."
    }
  },
  additionalProperties: false
};

const tools = [
  {
    name: "agent_link_health",
    description: "Report whether Codex Agent Link can reach a Codex app-server and whether it will use a managed local app-server.",
    inputSchema: {
      type: "object",
      properties: {
        startAppServer: {
          type: "boolean",
          description: "Start/connect to a managed app-server when no endpoint is configured. Defaults to true."
        },
        includeCallerContext: {
          type: "boolean",
          description: "Include the runtime caller context visible on this MCP request. Defaults to false."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "list_codex_threads",
    description: "List recent Codex threads with IDs, status, preview text, cwd, timestamps, and source metadata.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum threads to return. Defaults to 20; caps at 100."
        },
        searchTerm: {
          type: "string",
          description: "Optional substring filter over thread title, preview, cwd, and path."
        },
        cwd: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } }
          ],
          description: "Optional exact cwd filter or list of exact cwd filters."
        },
        archived: {
          type: "boolean",
          description: "Deprecated compatibility flag. When true, list archived threads. Defaults to false."
        },
        archiveScope: {
          type: "string",
          enum: ["active", "archived", "all"],
          description: "Which persisted thread scope to search/list. Defaults to active unless archived=true is supplied."
        },
        useLocalFallback: {
          type: "boolean",
          description: "Use local JSONL transcript scanning if app-server is unavailable. Defaults to true."
        },
        includeSubagents: {
          type: "boolean",
          description: "Also include thread-spawn subagent sessions. Defaults to false so ordinary thread listings stay focused on interactive threads."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "resolve_codex_thread",
    description: "Resolve a thread query or partial ID into ranked Codex thread candidates across active and archived sessions.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Thread ID, title/name, automation name, preview text, cwd fragment, or other user-facing search text."
        },
        limit: {
          type: "number",
          description: "Maximum candidates to return. Defaults to 5; caps at 20."
        },
        archiveScope: {
          type: "string",
          enum: ["active", "archived", "all"],
          description: "Which persisted thread scope to search. Defaults to all."
        },
        cwd: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } }
          ],
          description: "Optional exact cwd filter or list of exact cwd filters."
        },
        useLocalFallback: {
          type: "boolean",
          description: "Use local JSONL transcript scanning if app-server is unavailable. Defaults to true."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "list_loaded_codex_threads",
    description: "List thread IDs currently loaded in the reachable Codex app-server runtime, with best-effort GUI sidebar membership from rendererSidebarModel when available.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Optional maximum loaded thread IDs to return."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_codex_sidebar_state",
    description: "Read Codex Desktop sidebar state from app-server desktop/sidebar/state/read. Unsupported or missing renderer authority is surfaced explicitly; Agent Link does not infer GUI membership.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "get_codex_thread",
    description: "Read one Codex thread by ID, including runtime status and optionally recent visible transcript items.",
    inputSchema: {
      type: "object",
      required: ["threadId"],
      properties: {
        threadId: {
          type: "string",
          description: "Codex thread ID."
        },
        includeTurns: {
          type: "boolean",
          description: "Include turn/item history when supported. Defaults to false."
        },
        recentItems: {
          type: "number",
          description: "Number of recent ITEMS (messages, tool calls, reasoning, commands), not turns, when includeTurns is true. Returned as thread.recentItems (oldest first, each with its turnId) on both the app-server and the local-transcript fallback paths; app-server results also include thread.turns trimmed to the turns those items belong to. Defaults to 20; caps at 100."
        },
        includeReceipts: {
          type: "boolean",
          description: "Include Agent Link receipts whose targetThreadId matches this thread. Defaults to false."
        },
        receiptLimit: {
          type: "number",
          description: "Maximum receipts to include when includeReceipts is true. Defaults to 10."
        },
        useLocalFallback: {
          type: "boolean",
          description: "Use local JSONL transcript scanning if app-server is unavailable. Defaults to true."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "launch_codex_thread",
    description: "Create a new Codex thread through app-server, optionally send an initial message, and optionally route Codex Desktop to that exact thread.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Optional first user message to send after creating the thread. Omit to create an empty thread."
        },
        name: {
          type: "string",
          description: "Optional name/title for the new thread. Empty non-ephemeral threads are named to make them durable without opening the GUI."
        },
        cwd: {
          type: "string",
          description: "Optional working directory for the new thread."
        },
        model: {
          type: "string",
          description: "Optional model override for the new thread."
        },
        modelProvider: {
          type: "string",
          description: "Optional model provider override for the new thread."
        },
        serviceTier: {
          type: "string",
          description: "Optional service tier override for the new thread."
        },
        effort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh"],
          description: "Optional reasoning effort for the initial turn when message is supplied."
        },
        ephemeral: {
          type: "boolean",
          description: "When true, create the thread as ephemeral if supported by the app-server. Ephemeral threads may not support includeTurns-based reply confirmation."
        },
        openInGui: {
          type: "boolean",
          description: "Route Codex Desktop to the created thread via codex://threads/<id>. Defaults to false to avoid stealing focus or changing the active GUI thread."
        },
        receipt: receiptInputSchema
      },
      additionalProperties: false
    }
  },
  {
    name: "archive_codex_thread",
    description: "Archive a Codex thread through app-server when available, falling back to a guarded local sessions move.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Codex thread ID to archive. Defaults to the current caller thread when Codex supplies runtime context."
        },
        reason: {
          type: "string",
          description: "Short human-readable cleanup reason."
        },
        forceLoaded: {
          type: "boolean",
          description: "Allow local JSONL fallback even if the app-server reports the thread as currently loaded. Native app-server archive does not require this. Defaults to false."
        },
        useLocalFallback: {
          type: "boolean",
          description: "Allow local JSONL archive when app-server loaded-state check is unavailable. Defaults to true."
        },
        receipt: receiptInputSchema
      },
      additionalProperties: false
    }
  },
  {
    name: "list_agent_link_receipts",
    description: "List local Agent Link launch/message/archive/Claude-session receipts by target thread, target session, origin thread, action, host, target kind, or search term.",
    inputSchema: {
      type: "object",
      properties: {
        targetThreadId: {
          type: "string",
          description: "Only return receipts whose target.threadId matches this thread."
        },
        originThreadId: {
          type: "string",
          description: "Only return receipts whose origin.threadId matches this thread."
        },
        action: {
          type: "string",
          enum: [
            "launch_thread",
            "message_thread",
            "archive_thread",
            "message_claude_session",
            "reply_message"
          ],
          description: "Only return receipts for this action."
        },
        targetKind: {
          type: "string",
          enum: ["claude", "codex"],
          description: "Filter receipts by what kind of target they reached. Returns receipts where target.kind matches."
        },
        host: {
          type: "string",
          enum: ["claude", "codex"],
          description: "Filter receipts by which host wrote them. Useful for auditing which side initiated a cross-host action."
        },
        targetSessionId: {
          type: "string",
          description: "Filter by Claude target session id (e.g. local_<uuid>). Companion to targetThreadId for Codex targets."
        },
        searchTerm: {
          type: "string",
          description: "Optional substring search across receipt id, purpose, note, tags, message preview, final response, origin, and target fields."
        },
        limit: {
          type: "number",
          description: "Maximum receipts to return. Defaults to 20; caps at 500."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "message_codex_thread",
    description: "Send a direct text message to a Codex thread. Resumes not-loaded threads through app-server before starting a new turn when needed.",
    inputSchema: {
      type: "object",
      required: ["threadId", "message"],
      properties: {
        threadId: {
          type: "string",
          description: "Target Codex thread ID."
        },
        message: {
          type: "string",
          description: "Text to send to the target thread."
        },
        mode: {
          type: "string",
          enum: ["auto", "start_turn", "steer_active"],
          description: "auto resumes idle/not-loaded threads or steers active turns when an active turn ID is available. Defaults to auto."
        },
        resumeIfNeeded: {
          type: "boolean",
          description: "Allow thread/resume before messaging a not-loaded target. Defaults to true."
        },
        expectedTurnId: {
          type: "string",
          description: "Required by app-server when steering an active turn unless Agent Link can infer the active turn."
        },
        cwd: {
          type: "string",
          description: "Optional cwd override for the target turn. Rejected when it differs from the thread's own cwd unless allowTargetOverride is true."
        },
        model: {
          type: "string",
          description: "Optional model override for the target turn. Rejected when it differs from (or cannot be compared with) the thread's own model unless allowTargetOverride is true."
        },
        effort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh"],
          description: "Optional reasoning effort override for the target turn. Rejected when it differs from (or cannot be compared with) the thread's own effort unless allowTargetOverride is true."
        },
        allowParallelTurn: {
          type: "boolean",
          description: "Allow mode=start_turn even when the target appears active or waiting. Defaults to false."
        },
        waitForReply: {
          type: "boolean",
          description: "After delivery, wait for the target thread to become idle and return a final response summary. Defaults to false."
        },
        timeoutMs: {
          type: "number",
          description: "Maximum wait when waitForReply is true. Defaults to 30000; caps at 600000."
        },
        pollIntervalMs: {
          type: "number",
          description: "Polling interval when waitForReply is true. Defaults to 1000."
        },
        recentItems: {
          type: "number",
          description: "When waitForReply is true, include up to this many recent ITEMS (not turns) of the target thread in replyConfirmation.recentItems, oldest first, each with its turnId. Defaults to 10; caps at 100."
        },
        allowTargetOverride: {
          type: "boolean",
          description: "Messaging an existing thread normally runs the turn with that thread's own cwd, model, and reasoning effort; a cwd/model/effort here that differs from the thread's own (or that cannot be compared because app-server does not report it) is rejected. Set true only when you intend to change the target thread's working directory, model, or effort. Defaults to false."
        },
        receipt: receiptInputSchema
      },
      additionalProperties: false
    }
  },
  {
    name: "resolve_project_orchestrator",
    description: "Resolve a project's source-owned orchestrator binding or fall back to ranked thread search by project cwd/name/preview.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: {
          type: "string",
          description: "Source project root containing .codex/project-orchestrator.json."
        },
        projectId: {
          type: "string",
          description: "Stable project identifier used as a fallback search signal."
        },
        orchestratorThreadId: {
          type: "string",
          description: "Explicit orchestrator thread ID. Skips binding/search ambiguity but still attempts readability verification."
        },
        threadId: {
          type: "string",
          description: "Alias for orchestratorThreadId."
        },
        query: {
          type: "string",
          description: "Fallback search query when no readable source-owned binding is available."
        },
        cwd: {
          type: "string",
          description: "Optional cwd filter for fallback search. Defaults to projectRoot when supplied."
        },
        limit: {
          type: "number",
          description: "Maximum ranked fallback candidates to return. Defaults to 5; caps at 20."
        },
        archiveScope: {
          type: "string",
          enum: ["active", "archived", "all"],
          description: "Which persisted thread scope to search. Defaults to all."
        },
        useLocalFallback: {
          type: "boolean",
          description: "Use local JSONL fallback when app-server read/search is unavailable. Defaults to true."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "register_dependency_handoff",
    description: "Send a standardized Agent Link callback request to a thread or project orchestrator that owns a dependency for the caller.",
    inputSchema: {
      type: "object",
      required: ["dependencyName", "readinessContract"],
      properties: {
        targetThreadId: {
          type: "string",
          description: "Exact Codex thread ID that owns the dependency."
        },
        targetQuery: {
          type: "string",
          description: "Search query for the dependency-owner thread when targetThreadId is not known."
        },
        targetCwd: {
          type: "string",
          description: "Optional cwd filter for targetQuery."
        },
        projectRoot: {
          type: "string",
          description: "Project root used to resolve a source-owned project orchestrator."
        },
        projectId: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
          description: "Stable project identifier (a slug: letters, digits, '.', '_', '-') used as a project-orchestrator fallback search signal."
        },
        orchestratorThreadId: {
          type: "string",
          description: "Explicit project orchestrator thread ID."
        },
        threadId: {
          type: "string",
          description: "Alias for targetThreadId when project fields are absent, or orchestratorThreadId when project fields are present."
        },
        query: {
          type: "string",
          description: "Alias for targetQuery or project-orchestrator fallback query."
        },
        cwd: { type: "string" },
        dependencyName: {
          type: "string",
          description: "Short human-readable dependency name."
        },
        readinessContract: {
          type: "string",
          description: "Exact condition that makes the dependency ready or blocked."
        },
        callbackThreadId: {
          type: "string",
          description: "Thread to message when ready or blocked. The caller's own thread (from runtime caller context) wins when it is available; a different value here is ignored and flagged in the handoff message. Used as given only when caller context is unavailable."
        },
        deadline: {
          type: "string",
          description: "Optional deadline or timebox for the dependency callback."
        },
        evidenceRequirements: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } }
          ],
          description: "Optional verification or artifact evidence the dependency owner should return."
        },
        context: {
          type: "string",
          description: "Optional concise context for why this dependency matters."
        },
        mode: {
          type: "string",
          enum: ["auto", "start_turn", "steer_active"]
        },
        resumeIfNeeded: { type: "boolean" },
        expectedTurnId: { type: "string" },
        model: { type: "string" },
        effort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh"]
        },
        allowParallelTurn: { type: "boolean" },
        waitForReply: { type: "boolean" },
        timeoutMs: { type: "number" },
        pollIntervalMs: { type: "number" },
        recentItems: {
          type: "number",
          description: "When waitForReply is true, include up to this many recent ITEMS (not turns) of the target thread in replyConfirmation.recentItems, oldest first, each with its turnId. Defaults to 10; caps at 100."
        },
        allowTargetOverride: {
          type: "boolean",
          description: "Allow cwd/model/effort values that differ from the target thread's own. Defaults to false; see message_codex_thread."
        },
        archiveScope: {
          type: "string",
          enum: ["active", "archived", "all"]
        },
        limit: { type: "number" },
        useLocalFallback: { type: "boolean" },
        receipt: receiptInputSchema
      },
      additionalProperties: false
    }
  },
  {
    name: "check_coordination_obligations",
    description: "Check whether text that mentions cross-thread dependency readiness has a dependency-handoff receipt from the origin thread.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Current or final response text to inspect for dependency callback obligations."
        },
        finalText: { type: "string" },
        currentText: { type: "string" },
        originThreadId: {
          type: "string",
          description: "Origin thread whose Agent Link receipts should satisfy the obligation. Defaults to caller thread context."
        },
        threadId: {
          type: "string",
          description: "Alias for originThreadId."
        },
        receiptLimit: {
          type: "number",
          description: "Maximum recent dependency-handoff receipts to inspect. Defaults to 20."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "message_project_orchestrator",
    description: "Resolve or target a project orchestrator thread and send it a direct app-server message without GUI routing.",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        projectRoot: { type: "string" },
        projectId: { type: "string" },
        orchestratorThreadId: { type: "string" },
        threadId: {
          type: "string",
          description: "Alias for orchestratorThreadId."
        },
        query: { type: "string" },
        cwd: { type: "string" },
        message: {
          type: "string",
          description: "Message to send to the project orchestrator."
        },
        mode: {
          type: "string",
          enum: ["auto", "start_turn", "steer_active"]
        },
        resumeIfNeeded: { type: "boolean" },
        expectedTurnId: { type: "string" },
        model: { type: "string" },
        effort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh"]
        },
        allowParallelTurn: { type: "boolean" },
        waitForReply: { type: "boolean" },
        timeoutMs: { type: "number" },
        pollIntervalMs: { type: "number" },
        recentItems: {
          type: "number",
          description: "When waitForReply is true, include up to this many recent ITEMS (not turns) of the target thread in replyConfirmation.recentItems, oldest first, each with its turnId. Defaults to 10; caps at 100."
        },
        allowTargetOverride: {
          type: "boolean",
          description: "Allow cwd/model/effort values that differ from the target thread's own. Defaults to false; see message_codex_thread."
        },
        archiveScope: {
          type: "string",
          enum: ["active", "archived", "all"]
        },
        useLocalFallback: { type: "boolean" },
        receipt: receiptInputSchema
      },
      additionalProperties: false
    }
  },
  {
    name: "launch_project_worker",
    description: "Create a non-ephemeral project worker thread by default, with return-path instructions back to the resolved orchestrator and no GUI routing.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        projectRoot: { type: "string" },
        projectId: { type: "string" },
        orchestratorThreadId: { type: "string" },
        threadId: {
          type: "string",
          description: "Alias for orchestratorThreadId."
        },
        query: { type: "string" },
        cwd: { type: "string" },
        name: {
          type: "string",
          description: "Name/title for the worker thread."
        },
        workerRole: {
          type: "string",
          description: "Role label injected into the worker prompt."
        },
        role: {
          type: "string",
          description: "Alias for workerRole."
        },
        task: {
          type: "string",
          description: "Worker task to inject into the new thread prompt."
        },
        instructions: {
          type: "string",
          description: "Optional extra worker instructions."
        },
        model: { type: "string" },
        modelProvider: { type: "string" },
        serviceTier: { type: "string" },
        effort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh"]
        },
        ephemeral: {
          type: "boolean",
          description: "Defaults to false so worker threads persist unless explicitly requested otherwise."
        },
        archiveScope: {
          type: "string",
          enum: ["active", "archived", "all"]
        },
        useLocalFallback: { type: "boolean" },
        receipt: receiptInputSchema
      },
      additionalProperties: false
    }
  },
  {
    name: "return_project_work_result",
    description: "Send a structured worker status/result payload back to the resolved project orchestrator thread.",
    inputSchema: {
      type: "object",
      required: ["status"],
      properties: {
        projectRoot: { type: "string" },
        projectId: { type: "string" },
        orchestratorThreadId: { type: "string" },
        threadId: {
          type: "string",
          description: "Alias for orchestratorThreadId when resolving the orchestrator."
        },
        query: { type: "string" },
        cwd: { type: "string" },
        workerThreadId: {
          type: "string",
          description: "Thread ID of the worker returning the result."
        },
        status: {
          type: "string",
          enum: ["done", "done_with_concerns", "blocked"]
        },
        summary: {
          type: "string",
          description: "Concise worker result summary."
        },
        result: {
          type: "string",
          description: "Alias for summary."
        },
        changedPaths: {
          type: "array",
          items: { type: "string" }
        },
        testsRun: {
          type: "array",
          items: { type: "string" }
        },
        blockers: {
          type: "array",
          items: { type: "string" }
        },
        nextSteps: {
          type: "array",
          items: { type: "string" }
        },
        details: {
          type: "object",
          additionalProperties: true
        },
        mode: {
          type: "string",
          enum: ["auto", "start_turn", "steer_active"]
        },
        resumeIfNeeded: { type: "boolean" },
        expectedTurnId: { type: "string" },
        model: { type: "string" },
        effort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh"]
        },
        allowParallelTurn: { type: "boolean" },
        waitForReply: { type: "boolean" },
        timeoutMs: { type: "number" },
        pollIntervalMs: { type: "number" },
        recentItems: {
          type: "number",
          description: "When waitForReply is true, include up to this many recent ITEMS (not turns) of the target thread in replyConfirmation.recentItems, oldest first, each with its turnId. Defaults to 10; caps at 100."
        },
        allowTargetOverride: {
          type: "boolean",
          description: "Allow cwd/model/effort values that differ from the target thread's own. Defaults to false; see message_codex_thread."
        },
        archiveScope: {
          type: "string",
          enum: ["active", "archived", "all"]
        },
        useLocalFallback: { type: "boolean" },
        receipt: receiptInputSchema
      },
      additionalProperties: false
    }
  },
  {
    name: "wait_for_codex_thread",
    description: "Poll a reachable app-server thread until it is no longer active or the timeout expires, then return status and recent items.",
    inputSchema: {
      type: "object",
      required: ["threadId"],
      properties: {
        threadId: {
          type: "string",
          description: "Codex thread ID to poll."
        },
        timeoutMs: {
          type: "number",
          description: "Maximum time to wait. Defaults to 30000; caps at 600000."
        },
        pollIntervalMs: {
          type: "number",
          description: "Polling interval. Defaults to 1000."
        },
        recentItems: {
          type: "number",
          description: "Number of recent ITEMS (not turns) to return as thread.recentItems, oldest first, each with its turnId; thread.turns is trimmed to the turns those items belong to. Defaults to 10; caps at 100."
        }
      },
      additionalProperties: false
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...tools, mailboxInspectTool, claudeSendTool, claudeWaitTool, readInboxTool, replyAgentLinkMessageTool, ...claudeToolDefs]
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args = {} } = request.params;
  const toolContext = {
    callerContext: extractRuntimeCallerContext(request, extra)
  };

  try {
    if (claudeHandlers && Object.prototype.hasOwnProperty.call(claudeHandlers, name)) {
      return jsonResult(await claudeHandlers[name](args));
    }
    if (Object.prototype.hasOwnProperty.call(mailboxInspectHandlers, name)) {
      return jsonResult(await mailboxInspectHandlers[name](args, {
        runtimeCallerContext: toolContext.callerContext
      }));
    }
    if (Object.prototype.hasOwnProperty.call(messageClaudeSessionHandlers, name)) {
      return jsonResult(await messageClaudeSessionHandlers[name](args, {
        runtimeCallerContext: toolContext.callerContext
      }));
    }
    if (Object.prototype.hasOwnProperty.call(waitClaudeSessionHandlers, name)) {
      return jsonResult(await waitClaudeSessionHandlers[name](args, {
        runtimeCallerContext: toolContext.callerContext
      }));
    }
    if (Object.prototype.hasOwnProperty.call(readInboxHandlers, name)) {
      return jsonResult(await readInboxHandlers[name](args));
    }
    if (Object.prototype.hasOwnProperty.call(replyAgentLinkMessageHandlers, name)) {
      return jsonResult(await replyAgentLinkMessageHandlers[name](args, {
        runtimeCallerContext: toolContext.callerContext
      }));
    }
    switch (name) {
      case "agent_link_health":
        return jsonResult(await health(args, toolContext));
      case "list_codex_threads":
        return jsonResult(await listThreads(args));
      case "resolve_codex_thread":
        return jsonResult(await resolveThread(args));
      case "resolve_project_orchestrator":
        return jsonResult(await resolveProjectOrchestrator(args, projectOrchestratorDeps(args)));
      case "register_dependency_handoff":
        return jsonResult(await registerDependencyHandoff(args, dependencyHandoffDeps(args), toolContext));
      case "check_coordination_obligations":
        return jsonResult(await checkCoordinationObligations(args, dependencyHandoffDeps(args), toolContext));
      case "list_loaded_codex_threads":
        return jsonResult(await listLoadedThreads(args));
      case "get_codex_sidebar_state":
        return jsonResult(await getSidebarState(args));
      case "get_codex_thread":
        return jsonResult(await getThread(args));
      case "launch_codex_thread":
        return jsonResult(await launchThread(args, toolContext));
      case "archive_codex_thread":
        return jsonResult(await archiveThread(args, toolContext));
      case "list_agent_link_receipts":
        return jsonResult(await listAgentLinkReceipts(args));
      case "message_project_orchestrator":
        return jsonResult(await messageProjectOrchestrator(args, projectOrchestratorDeps(args), toolContext));
      case "launch_project_worker":
        return jsonResult(await launchProjectWorker(args, projectOrchestratorDeps(args), toolContext));
      case "return_project_work_result":
        return jsonResult(await returnProjectWorkResult(args, projectOrchestratorDeps(args), toolContext));
      case "message_codex_thread":
        return jsonResult(await messageThread(args, toolContext));
      case "wait_for_codex_thread":
        return jsonResult(await waitForThread(args));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return jsonResult({
      ok: false,
      error: error.message,
      details: error.details ?? null,
      hint: appServerErrorHint(error)
    }, true);
  }
});

function projectOrchestratorDeps(args = {}) {
  return {
    readThread: async (threadId) => await getThread({
      threadId,
      includeTurns: false,
      useLocalFallback: args.useLocalFallback
    }),
    listThreads,
    messageThread,
    launchThread
  };
}

function dependencyHandoffDeps(args = {}) {
  return {
    readThread: async (threadId) => await getThread({
      threadId,
      includeTurns: false,
      useLocalFallback: args.useLocalFallback
    }),
    resolveThread,
    resolveProjectOrchestrator: async (resolveArgs) => await resolveProjectOrchestrator(resolveArgs, projectOrchestratorDeps(resolveArgs)),
    messageThread,
    listReceipts
  };
}

async function health(args, toolContext = {}) {
  const callerContext = args.includeCallerContext === true
    ? summarizeRuntimeCallerContext(toolContext.callerContext)
    : null;
  const configuredEndpoint = configuredEndpointSummary();
  const usesManagedAppServer = !Object.values(configuredEndpoint).some(Boolean);
  const autoStartEnabled = process.env.CODEX_AGENT_LINK_AUTOSTART !== "0";
  const codex = {
    ...describeCodexInstall(),
    usedForManagedAppServer: usesManagedAppServer
  };
  const common = {
    host: HOST_INFO.host,
    hostDetection: HOST_INFO.reason,
    stateSemantics: loadedStateSemantics(),
    receiptIndex: receiptIndexSummary(),
    claude: claudeHealthSummary(),
    callerContextContract: callerContextContract(),
    ...(callerContext ? { callerContext } : {}),
    configuredEndpoint,
    autoStartEnabled
  };

  if (args.startAppServer === false) {
    return { ok: true, codex, appServer: appServer.getConnectionSummary(), ...common };
  }

  // No Codex on this machine is a normal state (for example a Claude-only
  // install), not a health failure.
  if (usesManagedAppServer && autoStartEnabled && !codex.available) {
    return {
      ok: true,
      codex: { ...codex, available: false },
      appServer: appServer.getConnectionSummary(),
      hint: appServerErrorHint(new AppServerError(codex.reason ?? "Codex binary not found", { code: "codex-binary-not-found" })),
      ...common
    };
  }

  let init;
  try {
    init = await appServer.request("thread/loaded/list", { limit: 1 });
  } catch (error) {
    const code = error?.code === "startup-failure-cached" ? error.details?.cachedCode : error?.code;
    if (code === "codex-binary-not-found") {
      return {
        ok: true,
        codex: {
          ...codex,
          available: false,
          reason: error.details?.reason ?? error.message,
          searched: error.details?.searched ?? codex.searched
        },
        appServer: appServer.getConnectionSummary(),
        hint: appServerErrorHint(error),
        ...common
      };
    }
    throw error;
  }
  return {
    ok: true,
    codex,
    appServer: appServer.getConnectionSummary(),
    loadedThreadProbe: init,
    ...common
  };
}

// Specific next steps for the ways reaching Codex fails. App-server JSON-RPC
// errors (unknown thread, bad params) get no transport hint.
function appServerErrorHint(error) {
  if (!(error instanceof AppServerError)) {
    return null;
  }
  const cached = error.code === "startup-failure-cached";
  const code = cached ? error.details?.cachedCode : error.code;
  const hints = {
    "codex-binary-not-found": "No Codex binary was found (details.searched lists where Agent Link looked). Install Codex Desktop (ChatGPT.app) or the codex CLI, or set CODEX_AGENT_LINK_CODEX_BIN to the binary's absolute path.",
    "spawn-failed": "The Codex binary could not be executed. Check its permissions, or set CODEX_AGENT_LINK_CODEX_BIN to a working binary.",
    "app-server-exited-during-startup": "The Codex binary exited while starting `app-server` (see details.command and details.logs). If it is an old install, point CODEX_AGENT_LINK_CODEX_BIN at a current Codex.",
    "readiness-timeout": "The managed Codex app-server did not accept connections before the startup timeout. Raise CODEX_AGENT_LINK_APP_SERVER_STARTUP_MS (milliseconds) or check details.logs.",
    "autostart-disabled": "CODEX_AGENT_LINK_AUTOSTART=0 turns off the managed app-server. Unset it, or set CODEX_AGENT_LINK_URL / CODEX_AGENT_LINK_SOCK to a running Codex app-server.",
    "state-dir-unsafe": "The managed app-server state directory is not private to this user. Fix its ownership or set CODEX_AGENT_LINK_STATE_DIR to a directory you own.",
    "client-closed": "Agent Link is shutting down; retry once the MCP server has restarted.",
    "open-failed": "Could not connect to the Codex app-server. Check CODEX_AGENT_LINK_URL / CODEX_AGENT_LINK_SOCK, or unset them to let Agent Link manage its own app-server.",
    "open-timeout": "Timed out connecting to the Codex app-server. Check CODEX_AGENT_LINK_URL / CODEX_AGENT_LINK_SOCK, or unset them to let Agent Link manage its own app-server.",
    "connection-lost": "The Codex app-server connection dropped. Retry; a managed app-server is restarted on the next call.",
    "request-timeout": "The Codex app-server did not answer in time. Retry, or check that the app-server is not overloaded."
  };
  const hint = hints[code] ?? null;
  if (!hint) {
    return null;
  }
  return cached
    ? `${hint} This startup failure is cached; Agent Link will try again after details.retryAfterMs.`
    : hint;
}

function claudeHealthSummary() {
  let sessions = [];
  try {
    sessions = listClaudeSessions();
  } catch {
    sessions = [];
  }
  // Read-only: a health check must not create ~/.claude/agent-link.
  let status = { path: null, writable: false, pendingMessagesCount: null };
  try {
    status = mailboxStatus();
  } catch {
    // keep defaults
  }

  const current = currentClaudeSession();
  return {
    sessionIndex: {
      total: sessions.length,
      desktop: sessions.filter((s) => s.surface === "desktop").length,
      code: sessions.filter((s) => s.surface === "code").length,
      loaded: sessions.filter((s) => s.loaded).length
    },
    mailbox: {
      path: status.path,
      writable: status.writable,
      pendingMessagesCount: status.pendingMessagesCount
    },
    channel: {
      enabled: HOST_INFO.host === "claude" && process.env.AGENT_LINK_DISABLE_CHANNEL !== "1",
      currentSession: current
        ? {
            sessionId: current.sessionId,
            surface: current.surface,
            supportsChannel: current.supportsChannel
          }
        : null
    }
  };
}

async function listThreads(args) {
  const limit = clamp(args.limit ?? 20, 1, 100);
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
    // Spread first: local.source ("local-jsonl") must not replace the
    // fallback label.
    return {
      ...local,
      ok: true,
      source: "local-jsonl-fallback",
      appServerError: error.message,
      stateSemantics: loadedStateSemantics(),
      data
    };
  }
}

async function resolveThread(args) {
  const query = requiredString(args.query, "query").trim();
  const limit = clamp(args.limit ?? 5, 1, 20);
  const archiveScope = args.archiveScope ?? "all";

  const response = await listThreads({
    archiveScope,
    limit: 100,
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

function finalizeThreadResults(threads, { limit, searchTerm }) {
  if (searchTerm) {
    return rankThreadSummaries(threads, searchTerm, limit);
  }
  return threads.slice(0, limit);
}

function dedupeThreads(threads) {
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

function buildResolveSelection(candidates) {
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

async function listLoadedThreads(args) {
  const response = await appServer.request("thread/loaded/list", {
    limit: args.limit ? clamp(args.limit, 1, 1000) : null
  });
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
    ...response,
    sidebarState,
    sidebarStateError: sidebarProbe.error,
    sidebarMembershipSemantics: sidebarMembershipSemantics(),
    threadIds: Array.isArray(response.threadIds) ? response.threadIds : loadedThreadIds,
    loadedThreads,
    sidebarMembershipByThreadId,
    subagentRegistry
  };
}

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

function buildSubagentRegistryEntry(thread, sidebarMembership) {
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

function extractThreadSpawnSource(source) {
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

function groupSubagentsByParentThreadId(subagents) {
  const grouped = {};
  for (const subagent of subagents) {
    const parentThreadId = subagent.parentThreadId ?? "unknown";
    grouped[parentThreadId] ??= [];
    grouped[parentThreadId].push(subagent);
  }
  return grouped;
}

async function getSidebarState(_args = {}) {
  let response;
  let appServerError = null;
  try {
    response = await appServer.request("desktop/sidebar/state/read", {});
  } catch (error) {
    appServerError = {
      message: error.message,
      details: error.details ?? null
    };
    response = unsupportedSidebarStateResponse(
      "desktop/sidebar/state/read failed; Agent Link will not infer GUI sidebar membership from runtime-loaded state",
      { appServerError }
    );
  }
  return {
    ok: true,
    source: "app-server",
    appServer: appServer.getConnectionSummary(),
    sidebarState: normalizeSidebarStateResponse(response),
    sidebarMembershipSemantics: sidebarMembershipSemantics(),
    appServerError
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

function normalizeLoadedThreadEntries(response = {}, loadedThreadIds = []) {
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

async function listAgentLinkReceipts(args) {
  return await listReceipts({
    targetThreadId: args.targetThreadId,
    originThreadId: args.originThreadId,
    action: args.action,
    targetKind: args.targetKind,
    host: args.host,
    targetSessionId: args.targetSessionId,
    searchTerm: args.searchTerm,
    limit: args.limit
  });
}

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
        recentItems: args.recentItems ?? 20
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
      const enriched = new Error(`Thread ${threadId} was not found by app-server or local transcript fallback`);
      enriched.details = {
        appServerError: error.message,
        localError: localError.message,
        didYouMean: await getThreadIdSuggestions(threadId)
      };
      throw enriched;
    }
  }
}

async function withOptionalReceipts(payload, args, threadId) {
  if (args.includeReceipts !== true) {
    return payload;
  }
  return {
    ...payload,
    agentLinkReceipts: await listReceipts({
      targetThreadId: threadId,
      limit: args.receiptLimit ?? 10
    })
  };
}

async function launchThread(args, toolContext = {}) {
  const startParams = {};
  copyOptionalString(args, startParams, "cwd");
  copyOptionalString(args, startParams, "model");
  copyOptionalString(args, startParams, "modelProvider");
  copyOptionalString(args, startParams, "serviceTier");
  if (typeof args.ephemeral === "boolean") {
    startParams.ephemeral = args.ephemeral;
  }

  const response = await appServer.request("thread/start", startParams);
  const threadId = requiredString(response.thread?.id, "thread.id");
  const message = optionalString(args.message).trim();
  const requestedName = optionalString(args.name).trim();
  const shouldPersistBlankThread = !message && args.ephemeral !== true;
  const threadName = requestedName || (shouldPersistBlankThread ? "New thread" : "");
  let turn = null;
  let nameUpdate = null;

  if (threadName) {
    await appServer.request("thread/name/set", { threadId, name: threadName });
    nameUpdate = {
      name: threadName,
      reason: requestedName
        ? "name was supplied by caller"
        : "blank non-ephemeral thread was named so Codex can persist and later reopen it"
    };
  }

  if (message) {
    const turnParams = {
      threadId,
      input: asUserTextInput(message)
    };
    copyOptionalString(args, turnParams, "cwd");
    copyOptionalString(args, turnParams, "model");
    copyOptionalString(args, turnParams, "effort");
    const turnResponse = await appServer.request("turn/start", turnParams);
    turn = summarizeTurn(turnResponse.turn);
  }

  const shouldOpenGui = args.openInGui === true;
  const gui = shouldOpenGui
    ? await openCodexDesktopThread({ threadId, ephemeral: args.ephemeral === true })
    : {
        attempted: false,
        threadId,
        deepLink: codexThreadDeepLink(threadId),
        reason: "openInGui was false; thread was created through app-server without routing or focusing Codex Desktop.",
        behavior: "Deep link is returned as data only; no GUI process was contacted.",
        focusPolicy: "No keyboard, mouse, menu, window automation, or LaunchServices route was used."
      };
  const deepLink = codexThreadDeepLink(threadId);

  const appServerSummary = appServer.getConnectionSummary();
  const action = message
    ? (nameUpdate ? "started_thread+named_thread+started_turn" : "started_thread+started_turn")
    : (nameUpdate ? "started_thread+named_thread" : "started_thread");
  const result = {
    ok: true,
    source: "app-server",
    action,
    thread: {
      ...summarizeThread(response.thread),
      name: nameUpdate?.name ?? response.thread?.name ?? null
    },
    nameUpdate,
    turn,
    warnings: launchWarnings(args),
    gui,
    appServer: appServerSummary
  };
  result.receipt = await recordActionReceipt({
    action: "launch_thread",
    receipt: args.receipt,
    target: {
      threadId,
      turnId: turn?.id ?? null,
      name: result.thread.name,
      cwd: result.thread.cwd,
      archiveState: result.thread.archiveState,
      status: result.thread.status,
      deepLink
    },
    message,
    finalResponse: null,
    delivery: {
      state: "accepted_by_app_server",
      action,
      turnId: turn?.id ?? null
    },
    replyConfirmation: null,
    runtimeCallerContext: toolContext.callerContext,
    appServer: appServerSummary
  });
  return result;
}

async function archiveThread(args, toolContext = {}) {
  const threadId = optionalString(args.threadId).trim() || optionalString(toolContext.callerContext?.threadId).trim();
  if (!threadId) {
    throw new Error("threadId is required when caller thread context is unavailable");
  }
  const reason = optionalString(args.reason).trim();
  const loadedCheck = await checkLoadedForArchive(threadId, {
    useLocalFallback: args.useLocalFallback
  });

  if (loadedCheck.checked) {
    try {
      const archive = await archiveThreadViaAppServer(threadId);
      const action = archive.alreadyArchived ? "already_archived" : "app_server_archive";
      return await buildArchiveThreadResult({
        source: "app-server",
        action,
        threadId,
        reason,
        loadedCheck,
        archive,
        args,
        toolContext
      });
    } catch (error) {
      if (loadedCheck.loaded && args.forceLoaded !== true) {
        error.details = {
          ...(error.details ?? {}),
          loadedCheck,
          stateSemantics: loadedStateSemantics(),
          hint: "Native app-server archive failed while the thread was loaded; refusing local fallback without forceLoaded=true."
        };
        throw error;
      }
    }
  }

  if (loadedCheck.loaded && args.forceLoaded !== true) {
    const error = new Error(`Thread ${threadId} is currently loaded; refusing to archive without forceLoaded=true`);
    error.details = {
      loadedCheck,
      stateSemantics: loadedStateSemantics(),
      hint: "Ask the active thread to finish or switch away before archiving, or set forceLoaded=true only when you intentionally accept that risk."
    };
    throw error;
  }

  const archive = await archiveLocalThread(threadId);
  const action = archive.alreadyArchived ? "already_archived" : "local_archive_moved";
  return await buildArchiveThreadResult({
    source: "local-jsonl",
    action,
    threadId,
    reason,
    loadedCheck,
    archive,
    args,
    toolContext
  });
}

async function archiveThreadViaAppServer(threadId) {
  const before = await readArchiveSnapshot(threadId);
  const response = await appServer.request("thread/archive", { threadId });
  const after = await readArchiveSnapshot(threadId);
  return {
    ok: true,
    source: "app-server",
    response,
    threadId,
    alreadyArchived: before?.archiveState?.scope === "archived",
    from: before?.path ?? null,
    to: after?.path ?? null,
    thread: after ?? before ?? { id: threadId, status: { type: "unknown" } },
    archiveStateBefore: before?.archiveState ?? null,
    archiveStateAfter: after?.archiveState ?? null,
    codexHome: appServer.getConnectionSummary().codexHome ?? null
  };
}

// Prefer the app-server's view. Look on disk only when the app-server cannot
// read the thread or does not report its transcript path, and then by
// filename rather than by scanning transcripts.
async function readArchiveSnapshot(threadId) {
  let fromAppServer = null;
  try {
    const read = await appServer.request("thread/read", { threadId, includeTurns: false });
    fromAppServer = summarizeThread(read.thread);
  } catch {
    fromAppServer = null;
  }
  if (fromAppServer?.path) {
    return fromAppServer;
  }
  if (fromAppServer) {
    const located = await findLocalThreadFile(threadId).catch(() => null);
    return located
      ? { ...fromAppServer, path: located.file, archiveState: inferArchiveState(located.file) }
      : fromAppServer;
  }
  try {
    const local = await readLocalThread(threadId);
    return summarizeThread(local.thread);
  } catch {
    return null;
  }
}

async function buildArchiveThreadResult({ source, action, threadId, reason, loadedCheck, archive, args, toolContext }) {
  const appServerSummary = appServer.getConnectionSummary();
  const result = {
    ok: true,
    source,
    action,
    threadId,
    reason: reason || null,
    loadedCheck,
    archive,
    stateSemantics: loadedStateSemantics(),
    appServer: appServerSummary
  };

  result.receipt = await recordActionReceipt({
    action: "archive_thread",
    receipt: args.receipt,
    target: {
      threadId,
      turnId: null,
      name: archive.thread.name,
      cwd: archive.thread.cwd,
      archiveState: archive.archiveStateAfter,
      status: archive.thread.status,
      deepLink: codexThreadDeepLink(threadId)
    },
    message: reason || null,
    finalResponse: null,
    delivery: {
      state: action,
      action: "archive_thread",
      from: archive.from,
      to: archive.to,
      loadedCheck
    },
    evidence: archiveReceiptEvidence({ loadedCheck, archive, action }),
    replyConfirmation: null,
    runtimeCallerContext: toolContext.callerContext,
    appServer: appServerSummary
  });

  return result;
}

function archiveReceiptEvidence({ loadedCheck, archive, action }) {
  const checked = loadedCheck.checked === true;
  const loaded = loadedCheck.loaded === true;
  const status = checked
    ? (loaded ? "loaded_thread_detected" : "loaded_thread_guard_passed")
    : "loaded_thread_guard_unchecked";
  return {
    primaryStatus: action,
    loadedThreadGuard: {
      status,
      checked,
      loaded: loadedCheck.loaded ?? null,
      source: loadedCheck.source ?? null,
      loadedThreadIdsCount: Array.isArray(loadedCheck.loadedThreadIds) ? loadedCheck.loadedThreadIds.length : null,
      note: loadedCheck.note ?? null,
      error: loadedCheck.error ?? null
    },
    archiveMove: {
      source: archive.source ?? "local-jsonl",
      alreadyArchived: archive.alreadyArchived,
      from: archive.from,
      to: archive.to,
      before: archive.archiveStateBefore,
      after: archive.archiveStateAfter,
      appServerResponse: archive.response ?? null
    },
    interpretation: "For archive receipts, loadedThreadGuard is the primary active-safety evidence. target.status may come from local JSONL and can be unknown even when the app-server loaded-thread guard passed."
  };
}

async function checkLoadedForArchive(threadId, args = {}) {
  try {
    const response = await appServer.request("thread/loaded/list", { limit: 1000 });
    const loadedThreadIds = extractLoadedThreadIds(response);
    return {
      ok: true,
      source: "app-server",
      checked: true,
      loaded: loadedThreadIds.includes(threadId),
      loadedThreadIds,
      appServer: appServer.getConnectionSummary()
    };
  } catch (error) {
    if (args.useLocalFallback === false) {
      throw error;
    }
    return {
      ok: false,
      source: "app-server",
      checked: false,
      loaded: null,
      error: error.message,
      fallback: "local-jsonl",
      appServer: appServer.getConnectionSummary(),
      note: "App-server loaded-state check was unavailable; proceeding because useLocalFallback was not false."
    };
  }
}

function extractLoadedThreadIds(response = {}) {
  const values = Array.isArray(response.data)
    ? response.data
    : (Array.isArray(response.threadIds) ? response.threadIds : []);
  return values
    .map((entry) => typeof entry === "string" ? entry : entry?.id ?? entry?.threadId ?? entry?.localThreadId)
    .filter(Boolean);
}

async function messageThread(args, toolContext = {}) {
  const threadId = requiredString(args.threadId, "threadId");
  const message = requiredString(args.message, "message").trim();
  if (!message) {
    throw new Error("message must not be empty");
  }

  const mode = args.mode ?? "auto";
  const resumeIfNeeded = args.resumeIfNeeded ?? true;
  const allowParallelTurn = args.allowParallelTurn === true;
  let read;
  try {
    read = await appServer.request("thread/read", { threadId, includeTurns: false });
  } catch (error) {
    throw await enrichThreadLookupError(error, threadId);
  }
  const initialThread = read.thread;
  const targetOverrides = checkTargetOverrides(initialThread, args);
  if (targetOverrides.conflicts.length > 0 && args.allowTargetOverride !== true) {
    const error = new Error(`Refusing to change ${targetOverrides.conflicts.map((conflict) => conflict.field).join(", ")} of existing thread ${threadId}; pass allowTargetOverride=true to do it intentionally`);
    error.details = {
      code: "target-override-rejected",
      conflicts: targetOverrides.conflicts,
      hint: "Omit cwd/model/effort to run the turn with the thread's own settings, or set allowTargetOverride=true when changing them is intended."
    };
    throw error;
  }
  let status = read.thread.status;
  let action = null;
  const warnings = warningsForMessageTarget(status, mode);

  if (status.type === "notLoaded") {
    if (!resumeIfNeeded) {
      throw new Error(`Thread ${threadId} is not loaded and resumeIfNeeded is false`);
    }
    const resumeParams = {
      threadId,
      excludeTurns: true,
      persistExtendedHistory: true
    };
    if (args.cwd) {
      resumeParams.cwd = args.cwd;
    }
    if (args.model) {
      resumeParams.model = args.model;
    }
    if (args.effort) {
      resumeParams.reasoningEffort = args.effort;
    }
    read = await appServer.request("thread/resume", resumeParams);
    status = read.thread.status;
    action = "resumed";
    warnings.push(...warningsForMessageTarget(status, mode));
  }

  const input = asUserTextInput(message);
  if (mode === "steer_active" || (mode === "auto" && status.type === "active")) {
    const expectedTurnId = args.expectedTurnId || await inferActiveTurnId(threadId);
    if (!expectedTurnId) {
      throw new Error("Cannot steer active thread without expectedTurnId or an inferable in-progress turn");
    }
    const response = await appServer.request("turn/steer", {
      threadId,
      input,
      expectedTurnId
    });
    const wait = args.waitForReply
      ? await tryWaitForReply({
          threadId,
          targetTurnId: response.turnId,
          timeoutMs: args.timeoutMs,
          pollIntervalMs: args.pollIntervalMs
        })
      : null;
    const appServerSummary = appServer.getConnectionSummary();
    const actionName = action ? `${action}+steered_active_turn` : "steered_active_turn";
    const replyConfirmation = buildReplyConfirmation(wait, response.turnId, args.recentItems ?? 10);
    const result = {
      ok: true,
      source: "app-server",
      action: actionName,
      previousStatus: status,
      threadId,
      turnId: response.turnId,
      warnings,
      ...buildStateContract({
        action: actionName,
        initialThread,
        beforeSendThread: read.thread,
        turnId: response.turnId,
        appServer: appServerSummary
      }),
      replyConfirmation,
      appServer: appServerSummary
    };
    result.receipt = await recordActionReceipt({
      action: "message_thread",
      receipt: args.receipt,
      target: {
        threadId,
        turnId: response.turnId,
        name: read.thread.name,
        cwd: read.thread.cwd,
        archiveState: inferArchiveState(read.thread),
        status: read.thread.status,
        deepLink: codexThreadDeepLink(threadId)
      },
      message,
      finalResponse: replyConfirmation.finalResponse,
      delivery: result.delivery,
      replyConfirmation,
      runtimeCallerContext: toolContext.callerContext,
      appServer: appServerSummary
    });
    return result;
  }

  if (isRiskyParallelStatus(status) && !allowParallelTurn) {
    const error = new Error("Target thread has an active or waiting turn, and this request would start another turn. Use mode=steer_active when possible, or set allowParallelTurn=true to intentionally start a parallel turn.");
    error.details = {
      warnings,
      previousStatus: status
    };
    throw error;
  }

  const startParams = { threadId, input };
  if (args.cwd) {
    startParams.cwd = args.cwd;
  }
  if (args.model) {
    startParams.model = args.model;
  }
  if (args.effort) {
    startParams.effort = args.effort;
  }

  const response = await appServer.request("turn/start", startParams);
  const summarizedTurn = summarizeTurn(response.turn);
  const wait = args.waitForReply
    ? await tryWaitForReply({
        threadId,
        targetTurnId: summarizedTurn.id,
        timeoutMs: args.timeoutMs,
        pollIntervalMs: args.pollIntervalMs
      })
    : null;
  const appServerSummary = appServer.getConnectionSummary();
  const actionName = action ? `${action}+started_turn` : "started_turn";
  const replyConfirmation = buildReplyConfirmation(wait, summarizedTurn.id, args.recentItems ?? 10);
  const result = {
    ok: true,
    source: "app-server",
    action: actionName,
    previousStatus: status,
    threadId,
    turn: summarizedTurn,
    warnings,
    ...buildStateContract({
      action: actionName,
      initialThread,
      beforeSendThread: read.thread,
      turn: summarizedTurn,
      appServer: appServerSummary
    }),
    replyConfirmation,
    appServer: appServerSummary
  };
  result.receipt = await recordActionReceipt({
    action: "message_thread",
    receipt: args.receipt,
    target: {
      threadId,
      turnId: summarizedTurn.id,
      name: read.thread.name,
      cwd: read.thread.cwd,
      archiveState: inferArchiveState(read.thread),
      status: read.thread.status,
      deepLink: codexThreadDeepLink(threadId)
    },
    message,
    finalResponse: replyConfirmation.finalResponse,
    delivery: result.delivery,
    replyConfirmation,
    runtimeCallerContext: toolContext.callerContext,
    appServer: appServerSummary
  });
  return result;
}

async function waitForThread(args) {
  const threadId = requiredString(args.threadId, "threadId");
  const latest = await waitForThreadRead({
    threadId,
    timeoutMs: args.timeoutMs,
    pollIntervalMs: args.pollIntervalMs
  });

  return {
    ok: true,
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

async function waitForThreadRead(args) {
  const threadId = requiredString(args.threadId, "threadId");
  const timeoutMs = clamp(args.timeoutMs ?? 30000, 1000, 600000);
  const pollIntervalMs = clamp(args.pollIntervalMs ?? 1000, 250, 10000);
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let lastRetryableError = null;

  while (Date.now() < deadline) {
    try {
      latest = await appServer.request("thread/read", { threadId, includeTurns: true });
      lastRetryableError = null;
    } catch (error) {
      if (isTransientIncludeTurnsUnavailable(error)) {
        lastRetryableError = error;
        await sleep(pollIntervalMs);
        continue;
      }
      throw error;
    }
    const waitState = analyzeThreadWaitState(latest.thread, args.targetTurnId ?? null);
    if (!waitState.shouldContinueWaiting) {
      break;
    }
    await sleep(pollIntervalMs);
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
    thread: latest.thread,
    waitState
  };
}

async function openCodexDesktopThread({ threadId, ephemeral }) {
  if (process.platform !== "darwin") {
    return {
      attempted: false,
      reason: "Codex Desktop thread routing is currently implemented for macOS only",
      deepLink: codexThreadDeepLink(threadId),
      threadId
    };
  }

  const deepLink = codexThreadDeepLink(threadId);
  const command = "open";
  const args = ["-g", deepLink];
  const commandDisplay = `${command} ${args.map(shellQuoteForDisplay).join(" ")}`;

  if (process.env.CODEX_AGENT_LINK_GUI_OPEN_DRY_RUN === "1") {
    return {
      attempted: true,
      ok: true,
      dryRun: true,
      command: commandDisplay,
      deepLink,
      threadId,
      behavior: "Dry run only; no GUI process was contacted.",
      focusPolicy: "No keyboard, mouse, menu, or window automation is used. The real path uses LaunchServices with -g, but Codex Desktop may still focus itself while handling valid deep links.",
      warnings: guiRoutingWarnings({ ephemeral })
    };
  }

  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "ignore"
    });

    child.on("error", (error) => {
      resolve({
        attempted: true,
        ok: false,
        command: commandDisplay,
        deepLink,
        error: error.message,
        threadId,
        warnings: guiRoutingWarnings({ ephemeral })
      });
    });

    child.on("exit", (code, signal) => {
      resolve({
        attempted: true,
        ok: code === 0,
        command: commandDisplay,
        deepLink,
        exitCode: code,
        signal,
        threadId,
        behavior: "Routed Codex Desktop to the created thread via the official codex://threads/<id> deep link. No keyboard, mouse, menu, or window automation was used.",
        focusPolicy: "LaunchServices was invoked with -g. Codex Desktop currently focuses its primary window while handling valid deep links, so callers should keep openInGui false when they need a strictly quiet launch.",
        warnings: guiRoutingWarnings({ ephemeral })
      });
    });
  });
}

function codexThreadDeepLink(threadId) {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

function guiRoutingWarnings({ ephemeral }) {
  const warnings = [];
  if (ephemeral) {
    warnings.push("The thread was created as ephemeral; Codex Desktop may not be able to reload it from persisted session history.");
  }
  const appServerSummary = appServer.getConnectionSummary();
  if (appServerSummary.managed) {
    warnings.push("Agent Link is connected to a managed app-server, not the Codex Desktop stdio app-server. The deep link targets the persisted thread id, but runtime-loaded state is not shared.");
  }
  return warnings;
}

function shellQuoteForDisplay(value) {
  if (/^[A-Za-z0-9_/:.=+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function warningsForMessageTarget(status, mode) {
  if (!isRiskyParallelStatus(status)) {
    return [];
  }
  return [activeTurnWarning(status, mode)];
}

function launchWarnings(args) {
  if (args.ephemeral !== true) {
    return [];
  }
  return [
    {
      code: "ephemeral-thread-limited-history",
      severity: "warning",
      message: "This thread was created as ephemeral. Some app-server read paths, including includeTurns-based reply confirmation, may be unavailable; use ephemeral=false for WF tests that need waitForReply evidence."
    }
  ];
}

async function recordActionReceipt({ action, receipt, target, message, finalResponse, delivery, replyConfirmation, evidence, runtimeCallerContext, appServer }) {
  const receiptInput = normalizeReceiptInput(receipt, { runtimeCallerContext });
  if (receiptInput.record === false) {
    return {
      ok: true,
      recorded: false,
      reason: "receipt.record was false"
    };
  }

  // Codex thread tools (launch/message/archive) all target Codex sessions.
  // Stamp host=HOST_INFO.host so Claude-host callers' receipts identify
  // their origin host, and target.kind=codex so receipts can be queried by
  // the kind of session the action reached. Existing fields on `target`
  // win when explicitly supplied.
  const targetWithKind = { kind: "codex", ...(target ?? {}) };

  const built = buildReceipt({
    action,
    receipt: receiptInput,
    host: HOST_INFO.host,
    target: targetWithKind,
    message,
    finalResponse,
    delivery,
    replyConfirmation,
    evidence,
    runtimeCallerContext,
    appServer
  });
  return {
    recorded: true,
    ...await safeAppendReceipt(built)
  };
}

async function tryWaitForReply(args) {
  try {
    const wait = await waitForThreadRead(args);
    return {
      ok: true,
      ...wait
    };
  } catch (error) {
    const unsupportedEphemeral = /ephemeral threads do not support includeTurns/i.test(error.message);
    return {
      ok: false,
      timedOut: null,
      thread: null,
      error: error.message,
      details: error.details ?? null,
      unsupported: unsupportedEphemeral,
      hint: unsupportedEphemeral
        ? "The message was delivered, but reply confirmation could not inspect this ephemeral thread. Use a non-ephemeral disposable thread when waitForReply evidence is required."
        : null
    };
  }
}

function buildReplyConfirmation(wait, targetTurnId, recentItemsLimit = 10) {
  if (!wait) {
    return {
      waited: false
    };
  }
  if (wait.ok === false) {
    return {
      waited: true,
      ok: false,
      timedOut: wait.timedOut,
      turnStatus: null,
      finalResponse: null,
      finalResponseItem: null,
      error: wait.error,
      details: wait.details,
      unsupported: wait.unsupported,
      hint: wait.hint
    };
  }
  const finalResponse = extractFinalResponse(wait.thread, targetTurnId);
  const hasFinalResponse = typeof finalResponse.text === "string" && finalResponse.text.trim().length > 0;
  return {
    waited: true,
    ok: hasFinalResponse,
    timedOut: wait.timedOut,
    turnStatus: finalResponse.turnStatus,
    finalResponse: finalResponse.text,
    finalResponseItem: finalResponse,
    waitState: wait.waitState ?? null,
    warnings: wait.waitState?.warnings ?? [],
    recentItems: recentItemWindow(wait.thread?.turns ?? [], clamp(recentItemsLimit, 1, 100)).items,
    error: hasFinalResponse ? null : "No final agent response text was found in the completed target turn.",
    hint: hasFinalResponse
      ? null
      : "Delivery/completion was observed, but this does not prove the target agent responded with text. Inspect the target turn or retry with a prompt that requires a final answer."
  };
}

function isTransientIncludeTurnsUnavailable(error) {
  const message = String(error?.message ?? "");
  return /not materialized yet/i.test(message)
    || /includeTurns is unavailable before first user message/i.test(message);
}

async function enrichThreadLookupError(error, threadId) {
  error.details = {
    ...(error.details ?? {}),
    didYouMean: await getThreadIdSuggestions(threadId)
  };
  return error;
}

// Rank by id similarity using transcript filenames only, then read just the
// few winners for their names and previews.
async function getThreadIdSuggestions(threadId) {
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

async function inferActiveTurnId(threadId) {
  const response = await appServer.request("thread/read", { threadId, includeTurns: true });
  const turns = response.thread.turns ?? [];
  const active = [...turns].reverse().find((turn) => turn.status === "inProgress");
  return active?.id ?? null;
}

function summarizeThread(thread, options = {}) {
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
    const limit = clamp(options.recentItems ?? 20, 1, 100);
    if (thread.recentItems) {
      summary.recentItems = thread.recentItems.slice(-limit);
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
function recentItemWindow(turns, limit) {
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

// cwd/model/effort a caller asks for that differ from what the existing
// thread already uses. A value the app-server does not report cannot be
// compared and counts as a change.
function checkTargetOverrides(thread, args) {
  const conflicts = [];
  const requestedCwd = optionalString(args.cwd).trim();
  if (requestedCwd) {
    const own = optionalString(thread?.cwd).trim();
    if (!own || path.resolve(own) !== path.resolve(requestedCwd)) {
      conflicts.push({ field: "cwd", requested: requestedCwd, threadValue: own || null });
    }
  }
  const requestedModel = optionalString(args.model).trim();
  if (requestedModel) {
    const own = optionalString(thread?.model).trim();
    if (own !== requestedModel) {
      conflicts.push({ field: "model", requested: requestedModel, threadValue: own || null });
    }
  }
  const requestedEffort = optionalString(args.effort).trim();
  if (requestedEffort) {
    const own = optionalString(thread?.reasoningEffort ?? thread?.effort).trim();
    if (own !== requestedEffort) {
      conflicts.push({ field: "effort", requested: requestedEffort, threadValue: own || null });
    }
  }
  return { conflicts };
}

function summarizeTurn(turn) {
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

function summarizeItem(item) {
  switch (item.type) {
    case "userMessage":
      return { type: item.type, id: item.id, text: summarizeUserContent(item.content) };
    case "agentMessage":
      return { type: item.type, id: item.id, text: truncate(item.text ?? "", 1000), phase: item.phase ?? null };
    case "reasoning":
      return { type: item.type, id: item.id, summary: (item.summary ?? []).map((text) => truncate(text, 500)) };
    case "commandExecution":
      return {
        type: item.type,
        id: item.id,
        command: truncate(item.command ?? "", 500),
        status: item.status,
        exitCode: item.exitCode ?? null,
        durationMs: item.durationMs ?? null
      };
    case "mcpToolCall":
      return {
        type: item.type,
        id: item.id,
        server: item.server,
        tool: item.tool,
        status: item.status,
        durationMs: item.durationMs ?? null
      };
    case "collabAgentToolCall":
      return {
        type: item.type,
        id: item.id,
        tool: item.tool,
        status: item.status,
        receiverThreadIds: item.receiverThreadIds ?? [],
        agentsStates: item.agentsStates ?? {}
      };
    default:
      return { type: item.type, id: item.id ?? null };
  }
}

function summarizeUserContent(content) {
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

function configuredEndpointSummary() {
  return {
    CODEX_AGENT_LINK_URL: Boolean(process.env.CODEX_AGENT_LINK_URL),
    CODEX_APP_SERVER_URL: Boolean(process.env.CODEX_APP_SERVER_URL),
    CODEX_AGENT_LINK_SOCK: Boolean(process.env.CODEX_AGENT_LINK_SOCK),
    CODEX_APP_SERVER_SOCK: Boolean(process.env.CODEX_APP_SERVER_SOCK)
  };
}

function jsonResult(value, isError = false) {
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" ? value : "";
}

function copyOptionalString(source, target, key) {
  const value = optionalString(source[key]).trim();
  if (value) {
    target[key] = value;
  }
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function truncate(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

function toIso(seconds) {
  if (!seconds) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const transport = new StdioServerTransport();
await server.connect(transport);

// Cheap, file-based: kill app-servers orphaned by an agent-link server that
// was SIGKILLed or crashed. Never starts anything.
try {
  reapOrphanedManagedAppServers();
} catch {
  // best effort
}

const channelBridge = HOST_INFO.host === "claude" && process.env.AGENT_LINK_DISABLE_CHANNEL !== "1"
  ? makeAgentLinkChannelBridge({
      resolveCurrentSession: currentClaudeSession,
      notify: async (notification) => {
        if (typeof server.notification !== "function") {
          throw new Error("MCP server notification API unavailable");
        }
        await server.notification(notification);
      }
    })
  : null;
channelBridge?.start();

// Shutdown must take the managed app-server (and its whole process group)
// down with this server. Previously SIGTERM/SIGINT called the async close()
// and exited immediately, stdin end never exited at all, and SIGHUP had no
// handler, so app-servers were routinely left behind with parent = launchd.
const SHUTDOWN_HARD_LIMIT_MS = 4000;
let shutdownPromise = null;
function shutdown(exitCode) {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  channelBridge?.stop();
  const hardStop = setTimeout(() => {
    appServer.killManagedSync("SIGKILL");
    process.exit(exitCode);
  }, SHUTDOWN_HARD_LIMIT_MS);
  shutdownPromise = appServer.close()
    .catch((error) => {
      process.stderr.write(`agent-link: shutdown cleanup failed: ${error.message}\n`);
    })
    .finally(() => {
      clearTimeout(hardStop);
      process.exit(exitCode);
    });
  return shutdownPromise;
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.on("SIGHUP", () => shutdown(129));
process.stdin.once("end", () => shutdown(0));
process.stdin.once("close", () => shutdown(0));
process.once("exit", () => {
  channelBridge?.stop();
  appServer.killManagedSync("SIGTERM");
});
