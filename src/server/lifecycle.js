// src/server/lifecycle.js
//
// Server lifecycle: shutdown (which takes the managed app-server down with
// the server), the fatal-error route, the Claude channel bridge, the orphan
// reaper, and the signal/stdin handlers (moved from src/server.js in PR B5,
// unchanged). Nothing runs at import time; src/server/index.js wires these
// up in the same order the unsplit server did.

import { makeAgentLinkChannelBridge } from "../claude/channel-bridge.js";
import { managedAppServerReapDirs, reapOrphanedManagedAppServers } from "../codex/app-server-client.js";
import { getLogger } from "../shared/log.js";

/** @typedef {import("../codex/app-server-client.js").CodexAppServerClient} CodexAppServerClient */
/** @typedef {{stop: () => void}} StoppableBridge */

// Shutdown must take the managed app-server (and its whole process group)
// down with this server. Previously SIGTERM/SIGINT called the async close()
// and exited immediately, stdin end never exited at all, and SIGHUP had no
// handler, so app-servers were routinely left behind with parent = launchd.
export const SHUTDOWN_HARD_LIMIT_MS = 4000;

/**
 * @typedef {{
 *   appServer: Pick<CodexAppServerClient, "close" | "killManagedSync">,
 *   exit?: (code: number) => void,
 *   hardLimitMs?: number
 * }} LifecycleDeps
 */

/**
 * @param {LifecycleDeps} deps
 */
export function createLifecycle({ appServer, exit = (code) => process.exit(code), hardLimitMs = SHUTDOWN_HARD_LIMIT_MS }) {
  /** @type {StoppableBridge | null} */
  let channelBridge = null;
  /** @type {Promise<void> | null} */
  let shutdownPromise = null;

  /**
   * @param {number} exitCode
   */
  function shutdown(exitCode) {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    channelBridge?.stop();
    const hardStop = setTimeout(() => {
      appServer.killManagedSync("SIGKILL");
      exit(exitCode);
    }, hardLimitMs);
    shutdownPromise = appServer.close()
      .catch((error) => {
        getLogger().warn("server.shutdown_cleanup_failed", { error });
      })
      .finally(() => {
        clearTimeout(hardStop);
        exit(exitCode);
      });
    return shutdownPromise;
  }

  // A stray rejection or exception must not leave the managed app-server behind
  // or kill the process mid-write: log it, then run the normal shutdown.
  /**
   * @param {string} event
   * @param {unknown} error
   */
  function fatal(event, error) {
    getLogger().error(event, {
      error: error instanceof Error ? error : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    shutdown(1);
  }

  /**
   * @param {StoppableBridge | null} bridge
   */
  function setChannelBridge(bridge) {
    channelBridge = bridge;
  }

  /**
   * SIGINT/SIGTERM/SIGHUP and the end of stdin shut down; process exit kills
   * the managed app-server synchronously as a last resort.
   * @param {NodeJS.Process} [proc]
   */
  function installSignalHandlers(proc = process) {
    proc.on("SIGINT", () => shutdown(130));
    proc.on("SIGTERM", () => shutdown(143));
    proc.on("SIGHUP", () => shutdown(129));
    proc.stdin.once("end", () => shutdown(0));
    proc.stdin.once("close", () => shutdown(0));
    proc.once("exit", () => {
      channelBridge?.stop();
      appServer.killManagedSync("SIGTERM");
    });
  }

  return { shutdown, fatal, setChannelBridge, installSignalHandlers };
}

// Cheap, file-based: kill app-servers orphaned by an agent-link server that
// was SIGKILLed or crashed. Never starts anything.
export function reapOrphanedAppServers() {
  try {
    for (const stateDir of managedAppServerReapDirs()) reapOrphanedManagedAppServers({ stateDir });
  } catch {
    // best effort
  }
}

/**
 * Starts the Claude channel bridge when the channel is enabled. Never lets the
 * channel take the server down: a failure is logged and returned as `error`,
 * and tools keep working.
 * @param {{
 *   enabled: boolean,
 *   server: {notification?: (notification: any) => Promise<void>},
 *   resolveCurrentSession: () => any,
 *   roles?: import("../registry/roles.js").RoleStore | null
 * }} options
 * @returns {{bridge: StoppableBridge | null, error: string | null}}
 */
export function startChannelBridge({ enabled, server, resolveCurrentSession, roles = null }) {
  if (!enabled) return { bridge: null, error: null };
  try {
    const bridge = makeAgentLinkChannelBridge({
      resolveCurrentSession,
      roles,
      notify: async (notification) => {
        if (typeof server.notification !== "function") {
          throw new Error("MCP server notification API unavailable");
        }
        await server.notification(notification);
      }
    });
    bridge.start();
    return { bridge, error: null };
  } catch (error) {
    const reason = error?.message ?? String(error);
    getLogger().error("channel.disabled", { reason });
    return { bridge: null, error: reason };
  }
}
