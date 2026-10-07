// src/server/config.js
//
// Server-wide settings read once at startup: the version, the host this
// server runs in, and feature flags. Every environment lookup goes through
// src/shared/env.js (canonical AGENT_LINK_* names with legacy aliases).

import { readFileSync } from "node:fs";
import { envFlag } from "../shared/env.js";
import { detectHost } from "../shared/host-detect.js";

/**
 * @typedef {object} ServerConfig
 * @property {string} name
 * @property {string} version
 * @property {ReturnType<typeof detectHost>} hostInfo
 * @property {"claude" | "codex" | "unknown"} host
 * @property {boolean} channelRequested   Claude channel push wanted (Claude host, not disabled)
 * @property {boolean} inspectAll         agent_link_mailbox_inspect may use scope "all"
 * @property {boolean} roleAdmin          the role and override-policy write tools are allowed (AGENT_LINK_ROLE_ADMIN=1, set by the user)
 * @property {boolean} codexAutostart     a managed app-server may be started
 * @property {boolean} codexReminders     Codex reminder turns (design 7.5; off until the B7 spike, B7b)
 */

/**
 * The package version. scripts/build.mjs replaces __AGENT_LINK_VERSION__ in
 * dist/server.mjs; running from source reads package.json.
 * @returns {string}
 */
export function serverVersion() {
  if (typeof __AGENT_LINK_VERSION__ === "string") return __AGENT_LINK_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

/**
 * @param {Record<string, string | undefined>} [source]
 * @returns {ServerConfig}
 */
export function loadConfig(source = process.env) {
  const hostInfo = detectHost({ env: source });
  const host = /** @type {"claude" | "codex" | "unknown"} */ (hostInfo.host);
  return {
    name: "agent-link",
    version: serverVersion(),
    hostInfo,
    host,
    channelRequested: host === "claude" && !envFlag("AGENT_LINK_DISABLE_CHANNEL", false, source),
    inspectAll: envFlag("AGENT_LINK_INSPECT_ALL", false, source),
    roleAdmin: envFlag("AGENT_LINK_ROLE_ADMIN", false, source),
    codexAutostart: envFlag("AGENT_LINK_CODEX_AUTOSTART", true, source),
    codexReminders: envFlag("AGENT_LINK_CODEX_REMINDERS", false, source)
  };
}
