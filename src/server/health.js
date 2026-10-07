// src/server/health.js
//
// The agent_link_health handler and the app-server error hints the registry
// attaches to failures (moved from src/server.js in PR B5, unchanged). The
// tool definition and the B4 health extras live in src/tools/health.js.
// Built by a factory; nothing runs at import time.

import { listClaudeSessions } from "../claude/session-index.js";
import { mailboxStatus } from "../claude/mailbox.js";
import { AppServerError, describeCodexInstall } from "../codex/app-server-client.js";
import { loadedStateSemantics } from "../codex/thread-utils.js";
import { overrideCostsHealth } from "../codex/override-costs.js";
import { callerContextContract, summarizeRuntimeCallerContext } from "../shared/caller-context.js";
import { env, envFlag } from "../shared/env.js";
import { hostIdentity } from "../shared/identity.js";
import { receiptIndexSummary } from "../shared/receipt-index.js";
import { healthExtras } from "../tools/health.js";

/** @typedef {import("../codex/thread-queries.js").AppServerLike} AppServerLike */

/**
 * @typedef {{
 *   appServer: AppServerLike,
 *   hostInfo: {host: string, reason?: string | null},
 *   resolveCurrentSession: () => any,
 *   channelState: () => {enabled: boolean, error: string | null},
 *   roles?: import("../registry/roles.js").RoleStore | null,
 *   roleAdmin?: boolean,
 *   forkJobs?: (() => {pending: number, running: number, stuck: number}) | null
 * }} HealthDeps
 */

// Specific next steps for the ways reaching Codex fails. App-server JSON-RPC
// errors (unknown thread, bad params) get no transport hint.
/**
 * @param {unknown} error
 * @returns {string | null}
 */
export function appServerErrorHint(error) {
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

/**
 * The variable (canonical AGENT_LINK_* or a legacy alias) that points Agent
 * Link at an existing app-server, or null. Values are never reported.
 * @returns {{url: string | null, socket: string | null}}
 */
export function configuredEndpointSummary() {
  return {
    url: env("AGENT_LINK_CODEX_URL").source,
    socket: env("AGENT_LINK_CODEX_SOCK").source
  };
}

/**
 * @param {HealthDeps} deps
 */
export function makeHealth({ appServer, hostInfo, resolveCurrentSession, channelState, roles = null, roleAdmin = false, forkJobs = null }) {
  /**
   * @param {Record<string, any>} args
   * @param {{callerContext?: any}} [toolContext]
   */
  async function health(args, toolContext = {}) {
    const report = await healthReport(args, toolContext);
    // The caller's own address from runtime identity (R1.4).
    const caller = hostIdentity({ host: hostInfo.host, callerContext: toolContext.callerContext ?? null, currentSession: resolveCurrentSession });
    // R9.12: the recorded override costs, and a warning when they were
    // measured on another Codex version.
    const overrideCosts = overrideCostsHealth(report.codex?.version ?? null);
    return {
      ...report,
      codex: { ...report.codex, overrideCosts },
      ...(forkJobs ? { forkJobs: forkJobCounts(forkJobs) } : {}),
      ...(overrideCosts.warning ? { warnings: [overrideCosts.warning] } : {}),
      address: caller.address,
      addressSource: caller.source,
      ...healthExtras({ codex: report.codex }),
      ...(roles ? { roles: rolesHealth(roles, roleAdmin) } : {})
    };
  }

  /**
   * @param {Record<string, any>} args
   * @param {{callerContext?: any}} [toolContext]
   */
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
      host: hostInfo.host,
      hostDetection: hostInfo.reason,
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

    const current = resolveCurrentSession();
    const channel = channelState();
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
        enabled: channel.enabled && channel.error === null,
        ...(channel.error ? { error: channel.error } : {}),
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

  return { health, healthReport, claudeHealthSummary };
}

/**
 * Fork job counts for health (read-only, from the job log): the same shape
 * on error, with null counts.
 * @param {() => {pending: number, running: number, stuck: number}} counts
 */
export function forkJobCounts(counts) {
  try {
    return { ...counts(), error: null };
  } catch (error) {
    return { pending: null, running: null, stuck: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * health.roles (design doc R1.25): the role table, the enforcement mode and
 * where it came from, and whether this server allows role administration.
 * Never fails the health call.
 * @param {import("../registry/roles.js").RoleStore} roles
 * @param {boolean} roleAdmin
 */
export function rolesHealth(roles, roleAdmin) {
  try {
    const read = roles.read();
    return {
      path: read.path,
      exists: read.exists,
      count: Object.keys(read.table.roles).length,
      assigned: Object.values(read.table.roles).filter((role) => typeof role.address === "string").length,
      policyTargets: Object.keys(read.table.overridePolicy).length,
      enforcement: roles.enforcement(read),
      admin: roleAdmin,
      problems: read.problems.length,
      error: read.error
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), admin: roleAdmin };
  }
}
