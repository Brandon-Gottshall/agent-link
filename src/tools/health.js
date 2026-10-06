// src/tools/health.js
//
// agent_link_health: definition plus the parts of the report that do not
// need the Codex app-server (state dir, env deprecations, legacy state,
// providers, recent log events). The app-server probe stays with the
// server's handler.

import fs from "node:fs";
import { envReport } from "../shared/env.js";
import { getLogger } from "../shared/log.js";
import { legacyStateReport } from "../shared/legacy-state.js";
import { claudeConfigDir, claudeProjectsRoot } from "../shared/host-detect.js";
import { isConfigured, stateDir } from "../shared/paths.js";
import { bool, commonOut, out, outAny } from "../server/schemas.js";

/** @type {import("../server/registry.js").ToolDefinition} */
export const healthTool = {
  name: "agent_link_health",
  description: "Report the host, the state directory, deprecated or conflicting environment variables, legacy state files, recent log events, whether Codex Agent Link can reach a Codex app-server, and whether it will use a managed local app-server. A machine without Codex is reported (codex.available false), not an error.",
  inputSchema: {
    type: "object",
    properties: {
      startAppServer: bool("Start/connect to a managed app-server when no endpoint is configured. Defaults to true. false also skips the codex --version probe."),
      includeCallerContext: bool("Include the runtime caller context visible on this MCP request. Defaults to false.")
    },
    additionalProperties: false
  },
  output: {
    host: out("string", "claude, codex, or unknown."),
    hostDetection: out("string", "How the host was determined."),
    address: out("string", "The caller's own address (claude:<id> or codex:<id>) from runtime identity, or 'external' when it cannot be identified."),
    addressSource: out("string", "Where address came from: runtime_context, current_session, env, or fallback."),
    providers: out("object", "{claude: {available, reason, searched}, codex: {available, reason, searched}}."),
    stateDir: out("object", "{path, source, exists}: where Agent Link keeps its files."),
    env: out("object", "{deprecated: [{name, canonical}], conflicts: [{canonical, winner, ignored}]}: legacy environment variable names in use (names only, never values)."),
    legacyState: out("object", "{files: [{kind, path, modifiedAt, writtenAfterMigration}], migration, stillWritten, warning}: pre-0.5 state files still present."),
    recentEvents: out("array", "Recent log events (most recent last). Stack traces and process output are redacted."),
    codex: out("object", "Codex install: {available, path, source, version, versionProbed, searched, reason, usedForManagedAppServer}."),
    appServer: commonOut.appServer,
    loadedThreadProbe: outAny("Result of a one-thread thread/loaded/list probe."),
    hint: out(["string", "null"], "Next step when Codex is unavailable."),
    stateSemantics: commonOut.stateSemantics,
    receiptIndex: out("object", "Receipt log paths and status."),
    claude: out("object", "Claude session index, mailbox, and channel status."),
    callerContextContract: out("object", "Which _meta keys are read as caller context."),
    callerContext: out("object", "The caller context of this request (includeCallerContext)."),
    configuredEndpoint: out("object", "{url, socket}: the variable naming an external app-server, or null."),
    autoStartEnabled: out("boolean", "Whether a managed app-server may be started.")
  },
  annotations: { readOnlyHint: true }
};

const REDACTED_FIELD = /stack|outputtail|stdout|stderr|logs?$|output$/i;
const RECENT_EVENT_LIMIT = 50;

/**
 * Recent log events for the model: stack traces and app-server output tails
 * stay in stderr and the log file, never in a tool result.
 * @param {import("../shared/log.js").LogEvent[]} events
 */
export function redactEvents(events) {
  return events.map((event) => {
    if (!event.fields) return event;
    const fields = /** @type {Record<string, unknown>} */ (redactValue(event.fields, 0));
    // The envelope shows an internal error only as its class; health must
    // not show more.
    if (event.event === "tool.internal_error" && fields.error && typeof fields.error === "object") {
      fields.error = { ...fields.error, message: "[redacted]" };
    }
    return { ...event, fields };
  });
}

/**
 * Redacts stack/output-like keys at any depth.
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function redactValue(value, depth) {
  if (depth > 6) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = REDACTED_FIELD.test(key) ? "[redacted]" : redactValue(item, depth + 1);
  }
  return out;
}

/**
 * @param {string} file
 */
function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/**
 * @param {unknown} error
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The app-server-independent part of the health report.
 * @param {{codex?: {available?: boolean, reason?: string | null, searched?: string[]}, source?: Record<string, string | undefined>}} [options]
 */
export function healthExtras({ codex = {}, source = process.env } = {}) {
  /** @type {{path: string | null, source: string, exists: boolean, error?: string}} */
  let state;
  try {
    const dir = stateDir({ env: source });
    state = { path: dir, source: isConfigured("AGENT_LINK_STATE_DIR", { env: source }) ? "AGENT_LINK_STATE_DIR" : "default", exists: exists(dir) };
  } catch (error) {
    state = { path: null, source: "AGENT_LINK_STATE_DIR", exists: false, error: messageOf(error) };
  }

  /** @type {Record<string, unknown>} */
  let legacyState;
  try {
    legacyState = { ...legacyStateReport({ env: source }) };
  } catch (error) {
    legacyState = { files: [], migration: null, stillWritten: false, warning: null, error: messageOf(error) };
  }

  const claudeDir = claudeConfigDir({ env: source });
  const projects = claudeProjectsRoot({ env: source });
  const claudeAvailable = exists(claudeDir);

  return {
    providers: {
      claude: {
        available: claudeAvailable,
        reason: claudeAvailable ? null : `No Claude config directory at ${claudeDir}`,
        searched: [claudeDir, projects]
      },
      codex: {
        available: codex.available ?? null,
        reason: codex.reason ?? null,
        searched: codex.searched ?? []
      }
    },
    stateDir: state,
    env: envReport(source),
    legacyState,
    recentEvents: redactEvents(getLogger().recentEvents(RECENT_EVENT_LIMIT))
  };
}
