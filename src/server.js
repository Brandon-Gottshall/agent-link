#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRegistry } from "./server/registry.js";
import { loadConfig } from "./server/config.js";
import { LIMITS } from "./server/schemas.js";
import { healthExtras, healthTool } from "./tools/health.js";
import { codexThreadEntries } from "./tools/codex-threads.js";
import { codexActionEntries } from "./tools/codex-actions.js";
import { orchestrationEntries } from "./tools/orchestration.js";
import { receiptEntries } from "./tools/receipts.js";
import {
  AppServerError,
  CodexAppServerClient,
  asUserTextInput,
  describeCodexInstall,
  managedAppServerReapDirs,
  reapOrphanedManagedAppServers
} from "./codex/app-server-client.js";
import {
  callerContextContract,
  extractRuntimeCallerContext,
  summarizeRuntimeCallerContext
} from "./shared/caller-context.js";
import { currentClaudeSessionId } from "./shared/host-detect.js";
import { claudeListingEntries } from "./tools/claude-listing.js";
import { claudeSendEntries } from "./tools/claude-send.js";
import { claudeWaitEntries } from "./tools/claude-wait.js";
import { mailboxInspectEntries } from "./tools/mailbox-inspect.js";
import { readInboxEntries } from "./tools/read-inbox.js";
import { replyAgentLinkMessageEntries } from "./tools/claude-reply.js";
import { makeAgentLinkChannelBridge } from "./claude/channel-bridge.js";
import { listClaudeSessions, resolveCurrentClaudeSession } from "./claude/session-index.js";
import { mailboxReadPaths, mailboxStatus } from "./claude/mailbox.js";
import {
  buildReceipt,
  listReceipts,
  normalizeReceiptInput,
  receiptIndexSummary,
  safeAppendReceipt
} from "./shared/receipt-index.js";
import { AgentLinkError } from "./shared/errors.js";
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
  suggestThreadIds
} from "./codex/thread-utils.js";
import { clampInt as clamp, optionalString, requiredString } from "./shared/args.js";
import { env, envFlag } from "./shared/env.js";
import { getLogger } from "./shared/log.js";
import { toIso, truncate } from "./shared/text.js";
import { resolveCallerIdentity } from "./claude/identity.js";
import {
  assertPeerBodyWithinLimit,
  isRuntimeIdentitySource,
  newPeerMessageId,
  normalizePeerMessage,
  peerMessageResult,
  renderPeerEnvelope
} from "./shared/envelope.js";

const CONFIG = loadConfig();
const HOST_INFO = CONFIG.hostInfo;

// The Claude channel bridge resolves the mailbox paths when it starts. A
// misconfigured path (relative AGENT_LINK_STATE_DIR or AGENT_LINK_MAILBOX_PATH)
// turns the channel off with a logged error instead of crashing the server;
// health reports it as claude.channel.error.
const CHANNEL_REQUESTED = CONFIG.channelRequested;
let channelError = null;
if (CHANNEL_REQUESTED) {
  try {
    mailboxReadPaths();
  } catch (error) {
    channelError = error?.message ?? String(error);
    getLogger().error("channel.disabled", { reason: channelError });
  }
}
const CHANNEL_ENABLED = CHANNEL_REQUESTED && channelError === null;


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
const server = new Server(
  {
    name: CONFIG.name,
    version: CONFIG.version
  },
  {
    instructions:
      "Agent Link messages may arrive as <agent-link-message> channel events. " +
      "Use reply_agent_link_message with the messageId to reply to an inbound Agent Link message.",
    capabilities: {
      tools: {},
      experimental: CHANNEL_ENABLED
        ? { "claude/channel": {} }
        : {}
    }
  }
);

const appServer = new CodexAppServerClient();

// Installed before anything else can fail asynchronously (module loading from
// source can be slow), so a stray rejection during startup still shuts down
// cleanly. The channel bridge is assigned once the transport is connected.
let channelBridge = null;

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
      getLogger().warn("server.shutdown_cleanup_failed", { error });
    })
    .finally(() => {
      clearTimeout(hardStop);
      process.exit(exitCode);
    });
  return shutdownPromise;
}

// A stray rejection or exception must not leave the managed app-server behind
// or kill the process mid-write: log it, then run the normal shutdown.
function fatal(event, error) {
  getLogger().error(event, {
    error: error instanceof Error ? error : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  shutdown(1);
}
process.on("unhandledRejection", (reason) => fatal("process.unhandled_rejection", reason));
process.on("uncaughtException", (error) => fatal("process.uncaught_exception", error));

// Local transcript fallbacks read at most this many of the newest transcripts
// when a search has to be answered from disk (they used to read up to 2,000).
const LOCAL_SEARCH_SCAN_LIMIT = 300;

// Every tool, in tools/list order. tools/list and tools/call both come from
// this one list (src/server/registry.js); handlers return payloads or throw
// AgentLinkError, and the registry builds the section 3.1 envelope.
const claudeDeps = { host: HOST_INFO.host, resolveCurrentSession: currentClaudeSession };
const registry = createRegistry([
  { definition: healthTool, handler: health },
  ...codexThreadEntries({
    list_codex_threads: listThreadsTool,
    resolve_codex_thread: resolveThreadTool,
    list_loaded_codex_threads: listLoadedThreads,
    get_codex_sidebar_state: getSidebarState,
    get_codex_thread: getThread,
    wait_for_codex_thread: waitForThread
  }),
  ...codexActionEntries({
    launch_codex_thread: launchThreadTool,
    archive_codex_thread: archiveThreadTool,
    message_codex_thread: messageThreadTool
  }),
  ...receiptEntries(),
  ...orchestrationEntries({
    resolve_project_orchestrator: resolveProjectOrchestratorTool,
    message_project_orchestrator: (args, ctx) => messageProjectOrchestrator(args, projectOrchestratorDeps(args), ctx),
    launch_project_worker: (args, ctx) => launchProjectWorker(args, projectOrchestratorDeps(args), ctx),
    return_project_work_result: (args, ctx) => returnProjectWorkResult({ ...args, status: args.resultStatus }, projectOrchestratorDeps(args), ctx),
    register_dependency_handoff: (args, ctx) => registerDependencyHandoff(args, dependencyHandoffDeps(args), ctx),
    check_coordination_obligations: (args, ctx) => checkCoordinationObligations(args, dependencyHandoffDeps(args), ctx)
  }),
  ...mailboxInspectEntries({ ...claudeDeps, inspectAll: CONFIG.inspectAll }),
  ...claudeSendEntries(claudeDeps),
  ...claudeWaitEntries(claudeDeps),
  ...readInboxEntries({ resolveCurrentSession: currentClaudeSession }),
  ...replyAgentLinkMessageEntries(claudeDeps),
  ...(HOST_INFO.host === "claude" ? claudeListingEntries() : [])
], { hintFor: appServerErrorHint });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.listTools() }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  return await registry.callTool(name, args, {
    callerContext: extractRuntimeCallerContext(request, extra)
  });
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
  const report = await healthReport(args, toolContext);
  return { ...report, ...healthExtras({ codex: report.codex }) };
}

async function healthReport(args, toolContext = {}) {
  const callerContext = args.includeCallerContext === true
    ? summarizeRuntimeCallerContext(toolContext.callerContext)
    : null;
  const configuredEndpoint = configuredEndpointSummary();
  const usesManagedAppServer = !Object.values(configuredEndpoint).some(Boolean);
  const autoStartEnabled = envFlag("AGENT_LINK_CODEX_AUTOSTART", true);
  const codex = {
    // Skip the blocking `codex --version` when the caller asked for a cheap check.
    ...describeCodexInstall({ probeVersion: args.startAppServer !== false }),
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
    "codex-binary-not-found": "No Codex binary was found (details.searched lists where Agent Link looked). Install Codex Desktop (ChatGPT.app) or the codex CLI, or set AGENT_LINK_CODEX_BIN to the binary's absolute path.",
    "spawn-failed": "The Codex binary could not be executed. Check its permissions, or set AGENT_LINK_CODEX_BIN to a working binary.",
    "app-server-exited-during-startup": "The Codex binary exited while starting `app-server` (see details.command and details.logs). If it is an old install, point AGENT_LINK_CODEX_BIN at a current Codex.",
    "readiness-timeout": "The managed Codex app-server did not accept connections before the startup timeout. Raise AGENT_LINK_CODEX_STARTUP_TIMEOUT_MS (milliseconds) or check details.logs.",
    "autostart-disabled": "AGENT_LINK_CODEX_AUTOSTART=0 turns off the managed app-server. Unset it, or set AGENT_LINK_CODEX_URL / AGENT_LINK_CODEX_SOCK to a running Codex app-server.",
    "state-dir-unsafe": "The managed app-server state directory is not private to this user. Fix its ownership or set AGENT_LINK_MANAGED_DIR to a directory you own.",
    "client-closed": "Agent Link is shutting down; retry once the MCP server has restarted.",
    "open-failed": "Could not connect to the Codex app-server. Check AGENT_LINK_CODEX_URL / AGENT_LINK_CODEX_SOCK, or unset them to let Agent Link manage its own app-server.",
    "open-timeout": "Timed out connecting to the Codex app-server. Check AGENT_LINK_CODEX_URL / AGENT_LINK_CODEX_SOCK, or unset them to let Agent Link manage its own app-server.",
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
  // Read-only: a health check must not create ~/.agent-link.
  /** @type {{path: string | null, writable: boolean, pendingMessagesCount: number | null, error?: string | null}} */
  let status = { path: null, writable: false, pendingMessagesCount: null, error: null };
  try {
    status = mailboxStatus();
  } catch (error) {
    // A misconfigured path (relative AGENT_LINK_MAILBOX_PATH) is reported, not thrown.
    status = { ...status, error: error?.message ?? String(error) };
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
      pendingMessagesCount: status.pendingMessagesCount,
      ...(status.error ? { error: status.error } : {})
    },
    channel: {
      enabled: CHANNEL_ENABLED && channelError === null,
      ...(channelError ? { error: channelError } : {}),
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

// Tool-facing wrappers. The internal functions keep their argument names
// (searchTerm) because other tools call them; the tools take the canonical
// `query` (section 3.3).
async function listThreadsTool(args) {
  const { query, ...rest } = args;
  return await listThreads({ ...rest, searchTerm: query });
}

async function resolveThreadTool(args) {
  const result = await resolveThread(args);
  const status = result.candidates.length === 0
    ? "not_found"
    : result.selection.ambiguous ? "ambiguous" : "resolved";
  return { status, ...result };
}

async function resolveProjectOrchestratorTool(args) {
  try {
    return { status: "resolved", ...await resolveProjectOrchestrator(args, projectOrchestratorDeps(args)) };
  } catch (error) {
    // A search that finds nothing, or several, is a verdict here (R3.4);
    // the tools that act on the orchestrator still fail with the error.
    if (error instanceof AgentLinkError && (error.errorCode === "not_found" || error.errorCode === "ambiguous")) {
      const details = error.details ?? {};
      return {
        status: error.errorCode,
        source: "search",
        threadId: null,
        projectRoot: details.projectRoot ?? null,
        projectId: optionalString(args.projectId).trim() || null,
        binding: details.binding ?? null,
        query: details.query ?? null,
        selection: details.selection ?? null,
        candidates: details.candidates ?? [],
        listSource: details.source ?? null
      };
    }
    throw error;
  }
}

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
    limit: clamp(args.limit ?? LIMITS.list.def, LIMITS.list.min, LIMITS.list.max)
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
    // Named keys only: app-server response fields are not passed through.
    data: response.data ?? null,
    nextCursor: response.nextCursor ?? null,
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
      throw new AgentLinkError("not_found", `Thread ${threadId} was not found by the app-server or the local transcript fallback.`, {
        details: {
          id: threadId,
          candidates: (await getThreadIdSuggestions(threadId)).slice(0, 5),
          appServerError: error.message,
          localError: localError.message
        },
        hint: "Call resolve_codex_thread or list_codex_threads to find the thread id."
      });
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
      limit: args.receiptLimit ?? LIMITS.receiptLimit.def
    })
  };
}

async function launchThreadTool(args, toolContext = {}) {
  const result = await launchThread(args, toolContext);
  // gui.opened: Codex Desktop was actually routed (section 3.7).
  return { ...result, gui: { opened: result.gui?.attempted === true && result.gui?.ok === true, ...result.gui } };
}

async function archiveThreadTool(args, toolContext = {}) {
  const result = await archiveThread(args, toolContext);
  return { status: result.action === "already_archived" ? "already_archived" : "archived", ...result };
}

async function messageThreadTool(args, toolContext = {}) {
  return await messageThread(args, toolContext);
}

async function launchThread(args, toolContext = {}) {
  // Reject an oversized message before a thread is created for it.
  assertPeerBodyWithinLimit(optionalString(args.message).trim());
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

  let peerMessage = null;
  if (message) {
    const turnParams = { threadId };
    copyOptionalString(args, turnParams, "cwd");
    copyOptionalString(args, turnParams, "model");
    copyOptionalString(args, turnParams, "effort");
    // The sender chose every setting of the new thread and its first turn.
    const overrides = {};
    for (const field of ["cwd", "model", "effort", "modelProvider", "serviceTier"]) {
      copyOptionalString(args, overrides, field);
    }
    const peer = buildPeerTurnInput({ toolContext, threadId, message, overrides });
    peerMessage = peer.summary;
    turnParams.input = peer.input;
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
    peerMessage,
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
    throw new AgentLinkError("invalid_arguments", "threadId is required when caller thread context is unavailable.", {
      details: { errors: [{ path: "threadId", rule: "required", expected: "string (no caller thread context)" }] }
    });
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
    throw new AgentLinkError("active_turn_conflict", `Thread ${threadId} is currently loaded; refusing to archive without forceLoaded=true.`, {
      details: { status: "loaded", activeTurnId: null, loadedCheck },
      hint: "Ask the active thread to finish or switch away before archiving, or set forceLoaded=true only when you intentionally accept that risk."
    });
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
    throw new AgentLinkError("invalid_arguments", "message must not be empty.", {
      details: { errors: [{ path: "message", rule: "required", expected: "non-empty string" }] }
    });
  }
  assertPeerBodyWithinLimit(message);

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
  // turn/steer ignores cwd/model/effort, so a mismatch there is only a warning.
  const willSteer = mode === "steer_active" || (mode === "auto" && initialThread?.status?.type === "active");
  const targetOverrides = checkTargetOverrides(initialThread, args, { steering: willSteer });
  const overrides = targetOverrides.forward;
  if (targetOverrides.conflicts.length > 0) {
    throw new AgentLinkError("permission_denied", `Refusing to change ${targetOverrides.conflicts.map((conflict) => conflict.field).join(", ")} of existing thread ${threadId}; pass allowTargetOverride=true to do it intentionally.`, {
      details: { reason: "target-override-rejected", conflicts: targetOverrides.conflicts },
      hint: "Omit cwd/model/effort to run the turn with the thread's own settings, or set allowTargetOverride=true when changing them is intended."
    });
  }
  let status = read.thread.status;
  let action = null;
  const warnings = [...targetOverrides.warnings, ...warningsForMessageTarget(status, mode)];

  if (status.type === "notLoaded") {
    if (!resumeIfNeeded) {
      throw new AgentLinkError("active_turn_conflict", `Thread ${threadId} is not loaded and resumeIfNeeded is false.`, {
        details: { status: "notLoaded", activeTurnId: null },
        hint: "Pass resumeIfNeeded=true (the default) to resume the thread before messaging it."
      });
    }
    const resumeParams = {
      threadId,
      excludeTurns: true,
      persistExtendedHistory: true
    };
    if (overrides.cwd) {
      resumeParams.cwd = overrides.cwd;
    }
    if (overrides.model) {
      resumeParams.model = overrides.model;
    }
    if (overrides.effort) {
      resumeParams.reasoningEffort = overrides.effort;
    }
    read = await appServer.request("thread/resume", resumeParams);
    status = read.thread.status;
    action = "resumed";
    warnings.push(...warningsForMessageTarget(status, mode));
  }

  const steering = mode === "steer_active" || (mode === "auto" && status.type === "active");
  // turn/steer ignores cwd/model/effort, so only a new turn shows overrides.
  const peer = buildPeerTurnInput({ toolContext, threadId, message, overrides: steering ? null : overrides });
  const input = peer.input;
  if (steering) {
    const expectedTurnId = args.expectedTurnId || await inferActiveTurnId(threadId);
    if (!expectedTurnId) {
      throw new AgentLinkError("active_turn_conflict", "Cannot steer the active thread without expectedTurnId or an inferable in-progress turn.", {
        details: { status: status?.type ?? null, activeTurnId: null },
        hint: "Pass expectedTurnId, or use mode=start_turn with allowParallelTurn=true."
      });
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
    const replyConfirmation = envelopeReplyConfirmation(buildReplyConfirmation(wait, response.turnId, args.recentItems ?? LIMITS.replyRecentItems.def), { threadId, sent: peer.summary });
    const result = {
      ok: true,
      messageId: peer.summary.messageId,
      deliveredVia: "turn/steer",
      target: { threadId },
      turn: { id: response.turnId },
      ...(wait ? { wait: waitOutcome(replyConfirmation, { threadId, turnId: response.turnId, waitedMs: wait.waitedMs }) } : {}),
      source: "app-server",
      action: actionName,
      previousStatus: status,
      threadId,
      turnId: response.turnId,
      peerMessage: peer.summary,
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
    throw new AgentLinkError("active_turn_conflict", "Target thread has an active or waiting turn, and this request would start another turn.", {
      details: { status: status?.type ?? null, activeTurnId: await inferActiveTurnId(threadId).catch(() => null), warnings },
      hint: "Use mode=steer_active when possible, or set allowParallelTurn=true to intentionally start a parallel turn."
    });
  }

  const startParams = { threadId, input };
  if (overrides.cwd) {
    startParams.cwd = overrides.cwd;
  }
  if (overrides.model) {
    startParams.model = overrides.model;
  }
  if (overrides.effort) {
    startParams.effort = overrides.effort;
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
  const replyConfirmation = envelopeReplyConfirmation(buildReplyConfirmation(wait, summarizedTurn.id, args.recentItems ?? LIMITS.replyRecentItems.def), { threadId, sent: peer.summary });
  const result = {
    ok: true,
    messageId: peer.summary.messageId,
    deliveredVia: "turn/start",
    target: { threadId },
    ...(wait ? { wait: waitOutcome(replyConfirmation, { threadId, turnId: summarizedTurn.id, waitedMs: wait.waitedMs }) } : {}),
    source: "app-server",
    action: actionName,
    previousStatus: status,
    threadId,
    turn: summarizedTurn,
    peerMessage: peer.summary,
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

// The single Codex input point for another agent's text (design doc section
// 2): message_codex_thread (turn/start and turn/steer), launch_codex_thread
// with a message, and the project-orchestrator and dependency-handoff tools
// built on those two. The text becomes a user-role turn on the target, so it
// is always wrapped in the peer envelope. The sender comes from runtime
// identity (caller _meta, then host env), never from tool arguments.
/**
 * @param {{toolContext?: {callerContext?: any}, threadId: string, message: string, overrides?: Record<string, any> | null}} options
 */
function buildPeerTurnInput({ toolContext = {}, threadId, message, overrides = null }) {
  const caller = resolveCallerIdentity({
    host: HOST_INFO.host,
    runtimeCallerContext: toolContext.callerContext ?? null,
    currentSession: currentClaudeSession
  });
  const peer = {
    id: newPeerMessageId(),
    from: caller.id,
    fromHarness: caller.kind,
    fromVerified: isRuntimeIdentitySource(caller.source),
    to: threadId,
    sentAt: Date.now(),
    body: message,
    overrides,
    reply: "direct"
  };
  const fields = normalizePeerMessage(peer);
  return {
    input: asUserTextInput(renderPeerEnvelope(peer)),
    summary: {
      messageId: fields.id,
      from: fields.from,
      fromHarness: fields.fromHarness,
      fromVerified: fields.fromVerified,
      sentAt: fields.sentAt,
      enveloped: true
    }
  };
}

async function waitForThread(args) {
  const threadId = requiredString(args.threadId, "threadId");
  const latest = await waitForThreadRead({
    threadId,
    timeoutMs: args.timeoutMs,
    pollIntervalMs: args.pollIntervalMs
  });
  const waitState = latest.waitState;
  const observed = (latest.thread?.turns ?? []).find((turn) => turn.id === waitState.observedTurnId) ?? null;
  const outcome = latest.timedOut ? "timeout" : observed ? "turn_completed" : "idle";

  return {
    ok: true,
    outcome,
    waitedMs: latest.waitedMs,
    target: { threadId },
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

async function waitForThreadRead(args) {
  const threadId = requiredString(args.threadId, "threadId");
  const timeoutMs = clamp(args.timeoutMs ?? LIMITS.timeoutMs.def, LIMITS.timeoutMs.min, LIMITS.timeoutMs.max);
  const pollIntervalMs = clamp(args.pollIntervalMs ?? LIMITS.pollIntervalMs.def, LIMITS.pollIntervalMs.min, LIMITS.pollIntervalMs.max);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
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
    waitedMs: Date.now() - startedAt,
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

  if (envFlag("AGENT_LINK_GUI_OPEN_DRY_RUN", false)) {
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
      waitedMs: null,
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
    recentItems: recentItemWindow(wait.thread?.turns ?? [], clamp(recentItemsLimit, 0, LIMITS.replyRecentItems.max)).items,
    error: hasFinalResponse ? null : "No final agent response text was found in the completed target turn.",
    hint: hasFinalResponse
      ? null
      : "Delivery/completion was observed, but this does not prove the target agent responded with text. Inspect the target turn or retry with a prompt that requires a final answer."
  };
}

// The target thread's answer is another agent's text handed back to the
// caller, so it is enveloped like any peer message (design section 2):
// `finalResponse` becomes the envelope, `finalResponseItem` and `recentItems`
// lose their text fields, and the recent items' text is returned as one
// envelope in `recentItemsEnvelope`. The sender is the target thread as the
// app-server reports it.
const RECENT_ITEM_TEXT_FIELDS = ["text", "summary", "command", "agentsStates"];

function envelopeReplyConfirmation(confirmation, { threadId, sent }) {
  if (!confirmation?.waited) return confirmation;
  const base = {
    from: threadId,
    fromHarness: "codex",
    fromVerified: true,
    to: sent?.from,
    replyTo: sent?.messageId,
    reply: "direct"
  };
  const out = { ...confirmation, enveloped: true };
  if (typeof confirmation.finalResponse === "string" && confirmation.finalResponse) {
    const message = { ...base, id: newPeerMessageId(), sentAt: Date.now(), body: confirmation.finalResponse };
    out.finalResponse = renderPeerEnvelope(message);
    out.reply = peerMessageResult(message, { includeEnvelope: false });
  }
  if (confirmation.finalResponseItem && typeof confirmation.finalResponseItem === "object") {
    const { text: _text, ...rest } = confirmation.finalResponseItem;
    out.finalResponseItem = rest;
  }
  if (confirmation.waitState?.finalResponse && typeof confirmation.waitState.finalResponse === "object") {
    const { text: _text, ...rest } = confirmation.waitState.finalResponse;
    out.waitState = { ...confirmation.waitState, finalResponse: rest };
  }
  if (Array.isArray(confirmation.recentItems)) {
    out.recentItems = confirmation.recentItems.map((item) => {
      const kept = { ...item };
      for (const field of RECENT_ITEM_TEXT_FIELDS) delete kept[field];
      return kept;
    });
    const transcript = confirmation.recentItems.map(recentItemLine).filter(Boolean).join("\n");
    out.recentItemsEnvelope = transcript
      ? renderPeerEnvelope({ ...base, id: newPeerMessageId(), sentAt: Date.now(), body: transcript })
      : null;
  }
  return out;
}

// replyConfirmation in the section 3.4 wait shape. The 0.4 key stays beside
// it until 0.6.0.
function waitOutcome(confirmation, { threadId, turnId, waitedMs }) {
  if (Object.prototype.hasOwnProperty.call(confirmation, "unsupported")) {
    return {
      outcome: "unavailable",
      waitedMs: waitedMs ?? null,
      target: { threadId },
      error: confirmation.error,
      ...(confirmation.hint ? { hint: confirmation.hint } : {})
    };
  }
  if (confirmation.timedOut === true) {
    return { outcome: "timeout", waitedMs: waitedMs ?? null, target: { threadId } };
  }
  return {
    outcome: "turn_completed",
    waitedMs: waitedMs ?? null,
    target: { threadId },
    turn: {
      turnId,
      status: confirmation.turnStatus ?? null,
      finalResponse: confirmation.finalResponse ?? null,
      completedAt: null
    },
    ...(confirmation.reply ? { reply: confirmation.reply } : {}),
    ...(Array.isArray(confirmation.recentItems) ? { recentItems: confirmation.recentItems } : {}),
    ...(confirmation.recentItemsEnvelope !== undefined ? { recentItemsEnvelope: confirmation.recentItemsEnvelope } : {})
  };
}

function recentItemLine(item) {
  const text = typeof item.text === "string" ? item.text
    : Array.isArray(item.summary) ? item.summary.join(" / ")
      : typeof item.command === "string" ? `$ ${item.command}`
        : "";
  return text ? `[${item.type ?? "item"} ${item.id ?? ""}] ${text}` : "";
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

// Decide which caller-supplied cwd/model/effort values reach the existing
// thread. allowTargetOverride forwards everything. Otherwise a value equal to
// the thread's own is forwarded; one that differs from a KNOWN thread value is
// a conflict (only a warning when steering, since turn/steer ignores them);
// one the app-server does not report (null) is not forwarded and is flagged
// with a target-override-unverified warning.
function checkTargetOverrides(thread, args, { steering = false } = {}) {
  const forward = {};
  const conflicts = [];
  const warnings = [];
  const fields = [
    ["cwd", optionalString(args.cwd).trim(), optionalString(thread?.cwd).trim(), sameDirectory],
    ["model", optionalString(args.model).trim(), optionalString(thread?.model).trim(), (a, b) => a === b],
    ["effort", optionalString(args.effort).trim(), optionalString(thread?.reasoningEffort ?? thread?.effort).trim(), (a, b) => a === b]
  ];
  for (const [field, requested, own, same] of fields) {
    if (!requested) {
      continue;
    }
    if (args.allowTargetOverride === true) {
      forward[field] = requested;
      continue;
    }
    if (!own) {
      warnings.push({
        code: "target-override-unverified",
        severity: "warning",
        field,
        requested,
        message: `The app-server does not report this thread's ${field}, so the requested value was not applied. Pass allowTargetOverride=true to apply it anyway.`
      });
      continue;
    }
    if (same(own, requested)) {
      forward[field] = requested;
      continue;
    }
    const conflict = { field, requested, threadValue: own };
    if (steering) {
      warnings.push({
        code: "target-override-ignored-steer",
        severity: "warning",
        ...conflict,
        message: `Steering an active turn does not change ${field}; the requested value was ignored.`
      });
    } else {
      conflicts.push(conflict);
    }
  }
  return { forward, conflicts, warnings };
}

// Compare directories by real path when both exist (macOS /tmp is
// /private/tmp), else lexically.
function sameDirectory(a, b) {
  const canonical = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return canonical(a) === canonical(b);
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

// App-server item fields that are identifiers (tool names, ids, types) are
// passed only when they look like identifiers, so another agent's thread
// cannot smuggle free text into a tool result through them. Free text
// (messages, reasoning, commands) is handled by the peer envelope.
const ITEM_ID_PATTERN = /^[A-Za-z0-9_.:@/+-]{1,128}$/;
function safeId(value) {
  return typeof value === "string" && ITEM_ID_PATTERN.test(value) ? value : null;
}

function safeIdList(value) {
  return Array.isArray(value) ? value.map(safeId).filter(Boolean).slice(0, 50) : [];
}

function summarizeItem(item) {
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
  // The variable (canonical AGENT_LINK_* or a legacy alias) that points Agent
  // Link at an existing app-server, or null. Values are never reported.
  return {
    url: env("AGENT_LINK_CODEX_URL").source,
    socket: env("AGENT_LINK_CODEX_SOCK").source
  };
}

function copyOptionalString(source, target, key) {
  const value = optionalString(source[key]).trim();
  if (value) {
    target[key] = value;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const transport = new StdioServerTransport();
await server.connect(transport);

// Cheap, file-based: kill app-servers orphaned by an agent-link server that
// was SIGKILLed or crashed. Never starts anything.
try {
  for (const stateDir of managedAppServerReapDirs()) reapOrphanedManagedAppServers({ stateDir });
} catch {
  // best effort
}

function startChannelBridge() {
  if (!CHANNEL_ENABLED) return null;
  try {
    const bridge = makeAgentLinkChannelBridge({
      resolveCurrentSession: currentClaudeSession,
      notify: async (notification) => {
        if (typeof server.notification !== "function") {
          throw new Error("MCP server notification API unavailable");
        }
        await server.notification(notification);
      }
    });
    bridge.start();
    return bridge;
  } catch (error) {
    // Never let the channel take the server down; tools keep working.
    channelError = error?.message ?? String(error);
    getLogger().error("channel.disabled", { reason: channelError });
    return null;
  }
}

channelBridge = startChannelBridge();


process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.on("SIGHUP", () => shutdown(129));
process.stdin.once("end", () => shutdown(0));
process.stdin.once("close", () => shutdown(0));
process.once("exit", () => {
  channelBridge?.stop();
  appServer.killManagedSync("SIGTERM");
});
