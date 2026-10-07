// src/shared/env.js
//
// Canonical environment lookup (design doc section 4.1). Every Agent Link
// setting has one AGENT_LINK_* name; the older CODEX_AGENT_LINK_* / CODEX_* /
// CLAUDE_AGENT_LINK_* spellings stay readable as aliases, checked in table
// order after the canonical name. Host-provided variables (R4.3) are read
// as-is. An empty string counts as unset, as it does in the code this replaces.
//
// Pure: every function takes the environment as an argument (default
// process.env). Not wired into the mailbox, receipts or app-server yet.

/**
 * @typedef {Record<string, string | undefined>} EnvSource
 */

/**
 * @typedef {object} EnvValue
 * @property {string | undefined} value
 * @property {string | null} source  the variable that supplied the value
 */

/**
 * @typedef {object} EnvReport
 * @property {{name: string, canonical: string}[]} deprecated  aliases that supplied a value
 * @property {{canonical: string, winner: string, ignored: string}[]} conflicts  a lower-priority name set to a different value than the one used
 */

/**
 * Canonical name -> legacy aliases, in fallback order (section 4.2, plus the
 * transport, startup-timeout and log-level settings the code already reads).
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const ENV_ALIASES = Object.freeze({
  AGENT_LINK_HOST: [],
  AGENT_LINK_STATE_DIR: [],
  AGENT_LINK_CODEX_URL: ["CODEX_AGENT_LINK_URL", "CODEX_APP_SERVER_URL"],
  AGENT_LINK_CODEX_SOCK: ["CODEX_AGENT_LINK_SOCK", "CODEX_APP_SERVER_SOCK"],
  AGENT_LINK_CODEX_AUTOSTART: ["CODEX_AGENT_LINK_AUTOSTART"],
  AGENT_LINK_CODEX_BIN: ["CODEX_AGENT_LINK_CODEX_BIN", "CODEX_BIN"],
  AGENT_LINK_CODEX_APP_SERVER_BIN: ["CODEX_AGENT_LINK_APP_SERVER_BIN", "CODEX_APP_SERVER_BIN"],
  AGENT_LINK_CODEX_TRANSPORT: ["CODEX_AGENT_LINK_APP_SERVER_TRANSPORT"],
  AGENT_LINK_CODEX_IDLE_MS: ["CODEX_AGENT_LINK_APP_SERVER_IDLE_MS"],
  AGENT_LINK_CODEX_STARTUP_TIMEOUT_MS: ["CODEX_AGENT_LINK_APP_SERVER_STARTUP_MS"],
  AGENT_LINK_MANAGED_DIR: ["CODEX_AGENT_LINK_STATE_DIR"],
  AGENT_LINK_RECEIPT_LOG: ["CODEX_AGENT_LINK_RECEIPT_LOG", "CLAUDE_AGENT_LINK_RECEIPT_LOG"],
  AGENT_LINK_INFER_RECEIPT_ORIGIN: ["CODEX_AGENT_LINK_INFER_RECEIPT_ORIGIN"],
  AGENT_LINK_MAILBOX_PATH: [],
  AGENT_LINK_DISABLE_CHANNEL: [],
  AGENT_LINK_INSPECT_ALL: [],
  AGENT_LINK_REMINDER_LIMIT: [],
  AGENT_LINK_REMINDER_INTERVAL_MS: [],
  AGENT_LINK_CODEX_REMINDERS: [],
  AGENT_LINK_DEBUG: [],
  AGENT_LINK_LOG_LEVEL: [],
  AGENT_LINK_LOG_FILE: [],
  AGENT_LINK_GUI_OPEN_DRY_RUN: ["CODEX_AGENT_LINK_GUI_OPEN_DRY_RUN"]
});

/**
 * Set by the host, never renamed (R4.3).
 * @type {readonly string[]}
 */
export const HOST_PROVIDED_ENV = Object.freeze([
  "HOME",
  "CODEX_HOME",
  "CODEX_THREAD_ID",
  "CODEX_TURN_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_CONFIG_DIR"
]);

const HOST_PROVIDED_SET = new Set(HOST_PROVIDED_ENV);

/**
 * @param {string | undefined} value
 */
function present(value) {
  return value !== undefined && value !== "";
}

/**
 * Reads one setting: the canonical name first, then each alias in order.
 * Unknown names throw, so a typo cannot silently read nothing.
 * @param {string} name   canonical AGENT_LINK_* name or a host-provided name
 * @param {EnvSource} [source]
 * @returns {EnvValue}
 */
export function env(name, source = process.env) {
  if (HOST_PROVIDED_SET.has(name)) {
    const value = source[name];
    return present(value) ? { value, source: name } : { value: undefined, source: null };
  }
  const aliases = ENV_ALIASES[name];
  if (!aliases) {
    throw new TypeError(`Unknown Agent Link environment variable: ${name}`);
  }
  for (const candidate of [name, ...aliases]) {
    const value = source[candidate];
    if (present(value)) {
      return { value, source: candidate };
    }
  }
  return { value: undefined, source: null };
}

/**
 * The value only, or `fallback` when unset.
 * @param {string} name
 * @param {string} [fallback]
 * @param {EnvSource} [source]
 * @returns {string | undefined}
 */
export function envValue(name, fallback = undefined, source = process.env) {
  return env(name, source).value ?? fallback;
}

/**
 * `1`, `true`, `yes`, `on` (any case) are true; `0`, `false`, `no`, `off`
 * are false; unset or anything else gives `fallback`.
 * @param {string} name
 * @param {boolean} fallback
 * @param {EnvSource} [source]
 * @returns {boolean}
 */
export function envFlag(name, fallback, source = process.env) {
  const raw = env(name, source).value;
  if (raw === undefined) return fallback;
  const text = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

/**
 * Deprecated aliases in use and canonical/alias conflicts, for health
 * (R4.2). Names only: values are never reported.
 * @param {EnvSource} [source]
 * @returns {EnvReport}
 */
export function envReport(source = process.env) {
  /** @type {EnvReport} */
  const report = { deprecated: [], conflicts: [] };
  for (const [canonical, aliases] of Object.entries(ENV_ALIASES)) {
    const resolved = env(canonical, source);
    if (resolved.source && resolved.source !== canonical) {
      report.deprecated.push({ name: resolved.source, canonical });
    }
    for (const alias of aliases) {
      const value = source[alias];
      if (present(value) && resolved.source !== alias && value !== resolved.value) {
        report.conflicts.push({ canonical, winner: /** @type {string} */ (resolved.source), ignored: alias });
      }
    }
  }
  return report;
}
