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
import { reminderSettings } from "../delivery/message-status.js";
import { codexRemindersEnabled } from "../delivery/reminders.js";
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
    providers: out("object", "{claude: {available, reason, searched}, codex: {available, reason, searched}}. list_agents and resolve_agent read both providers on either host; reading Codex threads may start a managed Codex app-server when Codex is installed and autoStartEnabled is true."),
    stateDir: out("object", "{path, source, exists}: where Agent Link keeps its files."),
    env: out("object", "{deprecated: [{name, canonical}], conflicts: [{canonical, winner, ignored}]}: legacy environment variable names in use (names only, never values)."),
    legacyState: out("object", "{files: [{kind, path, modifiedAt, writtenAfterMigration}], migration, stillWritten, warning}: pre-0.5 state files still present."),
    reminders: out("object", "{limit, intervalMs, codexTurns, warnings}: re-surfacing of open reply/action messages (AGENT_LINK_REMINDER_LIMIT, AGENT_LINK_REMINDER_INTERVAL_MS, AGENT_LINK_CODEX_REMINDERS, on by default). warnings lists settings that were ignored."),
    recentEvents: out("array", "Recent log events (most recent last). Stack traces and process output are redacted."),
    codex: out("object", "Codex install: {available, path, source, version, versionProbed, searched, reason, usedForManagedAppServer, overrideCosts, desktopPush}. overrideCosts: {measured, codexVersion, measuredAt, effortChange, modelSwitch, cwdChange, forkSameModel, forkOtherModel (each {cachedShare: [rep1, rep2], cacheNeutral}), compactForkAutoFraction, installedVersion, warning}: the measured prompt-cache effect of overrides and forks (B7 spike, R9.12) and the Codex version it was measured on; warning when the installed version differs, also added to the result's warnings[] (code override_costs_version_mismatch). desktopPush: {mode: mailbox-only|shared-daemon, source, refused, verifiedCodexVersion, installedCodexVersion, heldSignal, turnCompletedMethod, warnings, rolloutChecks: {checked, held, skipped: {<reason>: count}}} (R1.12a): in mailbox-only mode (the B7 spike's result) a thread not loaded in Agent Link's own app-server is treated as held by the Codex desktop app and gets mail by inbox only; warnings name a Codex version that differs from the verified one, and a refused shared-daemon setting (it needs an explicit AGENT_LINK_CODEX_URL or AGENT_LINK_CODEX_SOCK)."),
    forkJobs: out("object", "{pending, running, stuck, error}: unfinished fork_codex_thread jobs in the job log. pending: the task ended and the reconcile is not finished yet; running: the task turn is running; stuck: no task turn long after the fork, or a written reconcile left unfinished (the server's sweeper finishes both). Counts are null with error when the log cannot be read. Health reads the log only; the sweep runs on a timer, never from this tool."),
    appServer: commonOut.appServer,
    loadedThreadProbe: outAny("Result of a one-thread thread/loaded/list probe."),
    hint: out(["string", "null"], "Next step when Codex is unavailable."),
    stateSemantics: commonOut.stateSemantics,
    receiptIndex: out("object", "Receipt log paths and status."),
    claude: out("object", "Claude session index, mailbox, and channel status."),
    callerContextContract: out("object", "Which _meta keys are read as caller context."),
    callerContext: out("object", "The caller context of this request (includeCallerContext)."),
    configuredEndpoint: out("object", "{url, socket}: the variable naming an external app-server, or null."),
    autoStartEnabled: out("boolean", "Whether a managed app-server may be started."),
    roles: out("object", "{path, exists, count, assigned, policyTargets, enforcement: {mode: off|warn|enforce, source, ignored[]}, admin, problems, error}: the role table (roles.json), the role enforcement mode and its source, and whether the role write tools are enabled (AGENT_LINK_ROLE_ADMIN).")
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
 * Reminder settings (design 7.5) and any that were ignored (R7.13).
 * @param {Record<string, string | undefined>} source
 */
function remindersReport(source) {
  const settings = reminderSettings(source);
  return {
    limit: settings.limit,
    intervalMs: settings.intervalMs,
    codexTurns: codexRemindersEnabled(source),
    warnings: settings.warnings
  };
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
    reminders: remindersReport(source),
    recentEvents: redactEvents(getLogger().recentEvents(RECENT_EVENT_LIMIT))
  };
}
