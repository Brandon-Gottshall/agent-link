// src/server/index.js
//
// Server bootstrap (design doc section 5.1, R5.1). Importing this module has
// no side effects: createAgentLinkServer() builds the MCP server, the Codex
// app-server client and every tool handler; main() connects stdio and starts
// the background pieces, in the same order the unsplit src/server.js did.
// src/server.js stays the entry path (its first import installs the process
// error handlers) and calls main().

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRegistry } from "./registry.js";
import { loadConfig } from "./config.js";
import { appServerErrorHint, makeHealth } from "./health.js";
import { createLifecycle, reapOrphanedAppServers, startChannelBridge } from "./lifecycle.js";
import { healthTool } from "../tools/health.js";
import { codexThreadEntries } from "../tools/codex-threads.js";
import { codexActionEntries } from "../tools/codex-actions.js";
import { orchestrationEntries } from "../tools/orchestration.js";
import { receiptEntries } from "../tools/receipts.js";
import { claudeListingEntries } from "../tools/claude-listing.js";
import { claudeSendEntries } from "../tools/claude-send.js";
import { claudeWaitEntries } from "../tools/claude-wait.js";
import { mailboxInspectEntries } from "../tools/mailbox-inspect.js";
import { readInboxEntries } from "../tools/read-inbox.js";
import { replyAgentLinkMessageEntries } from "../tools/claude-reply.js";
import { messageStatusEntries } from "../tools/message-status.js";
import { deliverCodexReminders } from "../delivery/reminders.js";
import { reminderSettings } from "../delivery/message-status.js";
import { agentEntries } from "../tools/agents.js";
import { createSessionRegistry } from "../registry/index.js";
import { makeClaudeProvider } from "../registry/claude.js";
import { makeCodexProvider } from "../registry/codex.js";
import { CodexAppServerClient } from "../codex/app-server-client.js";
import { makeDesktopRouting } from "../codex/desktop-routing.js";
import { makeLoadedThreads } from "../codex/loaded-threads.js";
import { makeThreadActions } from "../codex/thread-actions.js";
import { makeThreadMessaging } from "../codex/thread-messaging.js";
import { makeThreadQueries } from "../codex/thread-queries.js";
import {
  launchProjectWorker,
  messageProjectOrchestrator,
  resolveProjectOrchestrator,
  returnProjectWorkResult
} from "../codex/project-orchestrator.js";
import { checkCoordinationObligations, registerDependencyHandoff } from "../codex/dependency-handoff.js";
import { resolveCurrentClaudeSession } from "../claude/session-index.js";
import { mailboxReadPaths, openMailbox, resolveMailboxPath } from "../claude/mailbox.js";
import { existsSync } from "node:fs";
import { sweepClaims } from "../delivery/message-wait.js";
import { extractRuntimeCallerContext } from "../shared/caller-context.js";
import { optionalString } from "../shared/args.js";
import { AgentLinkError } from "../shared/errors.js";
import { currentClaudeSessionId } from "../shared/host-detect.js";
import { listReceipts, setReceiptAddressResolver } from "../shared/receipt-index.js";
import { envelopeAddressResolver, receiptAddressResolver } from "../registry/addresses.js";
import { setEnvelopeAddressResolver } from "../shared/envelope.js";
import { getLogger } from "../shared/log.js";

/** @typedef {ReturnType<typeof loadConfig>} AgentLinkConfig */

// The current Claude session never changes for the life of this server.
// Resolve it with the fast lookup (sidecar or transcript by id, no `ps`, no
// full listing) and memoize. A transcript-only result is re-checked at most
// every 30 s, in case the Desktop sidecar (which owns the canonical id)
// appears after startup; a miss is retried at most every 5 s.
const CURRENT_SESSION_RECHECK_MS = 30_000;
const CURRENT_SESSION_MISS_RETRY_MS = 5_000;

/**
 * @param {{
 *   host: string,
 *   now?: () => number,
 *   resolve?: (options: {sessionId: string | null}) => any,
 *   sessionId?: () => string | null
 * }} options
 * @returns {() => any}
 */
export function makeCurrentClaudeSession({
  host,
  now = () => Date.now(),
  resolve = resolveCurrentClaudeSession,
  sessionId = currentClaudeSessionId
}) {
  /** @type {{session: any, at: number} | null} */
  let memo = null;
  return function currentClaudeSession() {
    if (host !== "claude") return null;
    const at = now();
    const previous = memo;
    if (previous) {
      const ttl = !previous.session
        ? CURRENT_SESSION_MISS_RETRY_MS
        : previous.session.source === "transcript" ? CURRENT_SESSION_RECHECK_MS : Infinity;
      if (at - previous.at < ttl) return previous.session;
    }
    let session = null;
    try {
      session = resolve({ sessionId: sessionId() });
    } catch {
      session = null;
    }
    memo = { session: session ?? previous?.session ?? null, at };
    return memo.session;
  };
}

/**
 * Builds the MCP server and every tool handler without connecting a
 * transport or starting anything in the background.
 * @param {{
 *   config?: AgentLinkConfig,
 *   appServer?: CodexAppServerClient,
 *   setFatalHandler?: ((fn: (event: string, error: unknown) => void) => void) | null
 * }} [options]
 */
export function createAgentLinkServer({ config = loadConfig(), appServer, setFatalHandler = null } = {}) {
  const hostInfo = config.hostInfo;

  // The Claude channel bridge resolves the mailbox paths when it starts. A
  // misconfigured path (relative AGENT_LINK_STATE_DIR or AGENT_LINK_MAILBOX_PATH)
  // turns the channel off with a logged error instead of crashing the server;
  // health reports it as claude.channel.error.
  const channelRequested = config.channelRequested;
  /** @type {string | null} */
  let channelError = null;
  if (channelRequested) {
    try {
      mailboxReadPaths();
    } catch (error) {
      channelError = error?.message ?? String(error);
      getLogger().error("channel.disabled", { reason: channelError });
    }
  }
  const channelEnabled = channelRequested && channelError === null;

  const currentClaudeSession = makeCurrentClaudeSession({ host: hostInfo.host });

  // Receipts are read with the session-index-aware address resolver, so a
  // target recorded under a sidecar id or a rotated Claude CLI id shows (and
  // matches) the session's current address (R1.6, R1.7).
  setReceiptAddressResolver(receiptAddressResolver);
  // Envelopes render the same current addresses (design 1.3, R7.3).
  setEnvelopeAddressResolver(envelopeAddressResolver);

  const server = new Server(
    {
      name: config.name,
      version: config.version
    },
    {
      instructions:
        "Agent Link messages may arrive as <agent-link-message> channel events. " +
        "Use reply_agent_link_message with the messageId to reply to an inbound Agent Link message.",
      capabilities: {
        tools: {},
        experimental: channelEnabled
          ? { "claude/channel": {} }
          : {}
      }
    }
  );

  const codexAppServer = appServer ?? new CodexAppServerClient();

  // Installed before anything else can fail asynchronously (module loading from
  // source can be slow), so a stray rejection during startup still shuts down
  // cleanly. The channel bridge is assigned once the transport is connected.
  const lifecycle = createLifecycle({ appServer: codexAppServer });
  setFatalHandler?.(lifecycle.fatal);

  // Codex handlers, built from the one app-server client.
  const queries = makeThreadQueries({ appServer: codexAppServer });
  const loaded = makeLoadedThreads({
    appServer: codexAppServer,
    collectAppServerThreadSummaries: queries.collectAppServerThreadSummaries
  });
  const desktop = makeDesktopRouting({ appServer: codexAppServer });
  const messaging = makeThreadMessaging({
    appServer: codexAppServer,
    host: hostInfo.host,
    resolveCurrentSession: currentClaudeSession,
    queries
  });
  const actions = makeThreadActions({ appServer: codexAppServer, messaging, desktop });
  // The session registry (section 1.4): both providers on every host.
  const sessionRegistry = createSessionRegistry({
    claude: makeClaudeProvider(),
    codex: makeCodexProvider({ appServer: codexAppServer, listThreads: queries.listThreads })
  });
  const { health } = makeHealth({
    appServer: codexAppServer,
    hostInfo,
    resolveCurrentSession: currentClaudeSession,
    channelState: () => ({ enabled: channelEnabled, error: channelError })
  });

  /** @param {Record<string, any>} [args] */
  function projectOrchestratorDeps(args = {}) {
    return {
      readThread: async (threadId) => await queries.getThread({
        threadId,
        includeTurns: false,
        useLocalFallback: args.useLocalFallback
      }),
      listThreads: queries.listThreads,
      messageThread: messaging.messageThread,
      launchThread: actions.launchThread
    };
  }

  /** @param {Record<string, any>} [args] */
  function dependencyHandoffDeps(args = {}) {
    return {
      readThread: async (threadId) => await queries.getThread({
        threadId,
        includeTurns: false,
        useLocalFallback: args.useLocalFallback
      }),
      resolveThread: queries.resolveThread,
      resolveProjectOrchestrator: async (resolveArgs) => await resolveProjectOrchestrator(resolveArgs, projectOrchestratorDeps(resolveArgs)),
      messageThread: messaging.messageThread,
      listReceipts
    };
  }

  /** @param {Record<string, any>} args */
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

  // Every tool, in tools/list order. tools/list and tools/call both come from
  // this one list (src/server/registry.js); handlers return payloads or throw
  // AgentLinkError, and the registry builds the section 3.1 envelope.
  const claudeDeps = { host: hostInfo.host, resolveCurrentSession: currentClaudeSession };
  const registry = createRegistry([
    { definition: healthTool, handler: health },
    ...codexThreadEntries({
      list_codex_threads: queries.listThreadsTool,
      resolve_codex_thread: queries.resolveThreadTool,
      list_loaded_codex_threads: loaded.listLoadedThreads,
      get_codex_sidebar_state: loaded.getSidebarState,
      get_codex_thread: queries.getThread,
      wait_for_codex_thread: queries.waitForThread
    }),
    ...codexActionEntries({
      launch_codex_thread: actions.launchThreadTool,
      archive_codex_thread: actions.archiveThreadTool,
      message_codex_thread: messaging.messageThreadTool
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
    ...mailboxInspectEntries({ ...claudeDeps, inspectAll: config.inspectAll }),
    ...claudeSendEntries(claudeDeps),
    ...claudeWaitEntries(claudeDeps),
    ...readInboxEntries({ resolveCurrentSession: currentClaudeSession, host: hostInfo.host }),
    ...replyAgentLinkMessageEntries(claudeDeps),
    ...messageStatusEntries(claudeDeps),
    // Every tool on every host (R1.16): the Claude listing tools are no
    // longer limited to the Claude host.
    ...claudeListingEntries(),
    ...agentEntries({ registry: sessionRegistry, host: hostInfo.host, resolveCurrentSession: currentClaudeSession })
  ], { hintFor: appServerErrorHint });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    return await registry.callTool(name, args, {
      callerContext: extractRuntimeCallerContext(request, extra)
    });
  });

  /**
   * Connects the transport, then reaps orphaned app-servers, starts the
   * channel bridge and installs the shutdown handlers.
   * @param {import("@modelcontextprotocol/sdk/shared/transport.js").Transport} transport
   */
  async function start(transport) {
    await server.connect(transport);

    reapOrphanedAppServers();

    const channel = startChannelBridge({
      enabled: channelEnabled,
      server,
      resolveCurrentSession: currentClaudeSession
    });
    if (channel.error !== null) channelError = channel.error;
    lifecycle.setChannelBridge(channel.bridge);

    if (config.codexReminders) startCodexReminders({ appServer: codexAppServer });
    startClaimSweeper({ host: hostInfo.host });

    lifecycle.installSignalHandlers();
  }

  return { server, appServer: codexAppServer, registry, lifecycle, config, start };
}

const CLAIM_SWEEP_INTERVAL_MS = 3_600_000;

/**
 * Bounded claim-file collection and status-transition receipts (design
 * R7.17): once shortly after start, then hourly. Only when a mailbox file
 * already exists, so a server on a machine without mail never creates the
 * state directory. The timer never keeps the process alive.
 * @param {{host: string}} options
 */
function startClaimSweeper({ host }) {
  // Where the next bounded pass starts; random per process so restarts do
  // not always rescan the same first entries.
  let offset = Math.floor(Math.random() * 1_000_000);
  const run = async () => {
    let mailbox = null;
    try {
      const file = resolveMailboxPath();
      if (!existsSync(file)) return;
      mailbox = openMailbox();
      const result = await sweepClaims(mailbox, { host, offset });
      offset = result.nextOffset;
      if (result.removed || result.receipts) getLogger().info("claims.swept", result);
    } catch (error) {
      getLogger().warn("claims.sweep_failed", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      mailbox?.close();
    }
  };
  const first = setTimeout(run, 5_000);
  first.unref?.();
  const timer = setInterval(run, CLAIM_SWEEP_INTERVAL_MS);
  timer.unref?.();
}

/**
 * Codex reminder turns (design R7.14), only with AGENT_LINK_CODEX_REMINDERS=1.
 * Off by default until the B7 spike confirms the turn-completion signal
 * (B7b). One pass per reminder interval; the timer never keeps the process
 * alive, and a failed pass is logged and retried on the next tick.
 * @param {{appServer: CodexAppServerClient}} options
 */
function startCodexReminders({ appServer }) {
  const settings = reminderSettings();
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    let mailbox = null;
    try {
      mailbox = openMailbox();
      const results = await deliverCodexReminders({ appServer, mailbox, settings });
      if (results.length) getLogger().info("codex_reminders.pass", { results });
    } catch (error) {
      getLogger().warn("codex_reminders.failed", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      mailbox?.close();
      running = false;
    }
  }, settings.intervalMs);
  timer.unref?.();
  return timer;
}

/**
 * Runs the stdio MCP server.
 * @param {{setFatalHandler?: ((fn: (event: string, error: unknown) => void) => void) | null}} [options]
 */
export async function main({ setFatalHandler = null } = {}) {
  const app = createAgentLinkServer({ setFatalHandler });
  await app.start(new StdioServerTransport());
  return app;
}
