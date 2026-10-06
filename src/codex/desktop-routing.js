// src/codex/desktop-routing.js
//
// Routing Codex Desktop to a thread through the official codex://threads/<id>
// deep link (moved from src/server.js in PR B5, unchanged). Built by a
// factory so tests can inject the app-server client, the platform and the
// command runner; nothing runs at import time.

import { envFlag } from "../shared/env.js";
import { shellQuoteForDisplay, spawnAndWait } from "../shared/process.js";

/** @typedef {import("./app-server-client.js").CodexAppServerClient} CodexAppServerClient */

/**
 * @param {string} threadId
 * @returns {string}
 */
export function codexThreadDeepLink(threadId) {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

/**
 * @typedef {{
 *   appServer: Pick<CodexAppServerClient, "getConnectionSummary">,
 *   platform?: () => string,
 *   dryRun?: () => boolean,
 *   run?: typeof spawnAndWait
 * }} DesktopRoutingDeps
 */

/**
 * @param {DesktopRoutingDeps} deps
 */
export function makeDesktopRouting({
  appServer,
  platform = () => process.platform,
  dryRun = () => envFlag("AGENT_LINK_GUI_OPEN_DRY_RUN", false),
  run = spawnAndWait
}) {
  /**
   * @param {{ephemeral?: boolean}} options
   * @returns {string[]}
   */
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

  /**
   * @param {{threadId: string, ephemeral?: boolean}} options
   */
  async function openCodexDesktopThread({ threadId, ephemeral }) {
    if (platform() !== "darwin") {
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

    if (dryRun()) {
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

    const outcome = await run(command, args);
    if (outcome.error) {
      return {
        attempted: true,
        ok: false,
        command: commandDisplay,
        deepLink,
        error: outcome.error.message,
        threadId,
        warnings: guiRoutingWarnings({ ephemeral })
      };
    }
    return {
      attempted: true,
      ok: outcome.code === 0,
      command: commandDisplay,
      deepLink,
      exitCode: outcome.code,
      signal: outcome.signal,
      threadId,
      behavior: "Routed Codex Desktop to the created thread via the official codex://threads/<id> deep link. No keyboard, mouse, menu, or window automation was used.",
      focusPolicy: "LaunchServices was invoked with -g. Codex Desktop currently focuses its primary window while handling valid deep links, so callers should keep openInGui false when they need a strictly quiet launch.",
      warnings: guiRoutingWarnings({ ephemeral })
    };
  }

  return { openCodexDesktopThread, guiRoutingWarnings };
}
