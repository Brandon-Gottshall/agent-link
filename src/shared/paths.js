// src/shared/paths.js
//
// The only path resolver for Agent Link state (design doc sections 4.3/4.4).
// The MCP server and the Claude notify hook both import it, so they agree on
// every path under the same environment whatever their working directory.
// The state root is ~/.agent-link unless AGENT_LINK_STATE_DIR says otherwise.
// Legacy locations under ~/.claude and $CODEX_HOME are reported separately so
// the mailbox and receipt readers can merge them (R4.5); nothing ever writes
// to them.
//
// Pure: every function takes `{env, homedir}` (defaults: process.env and
// os.homedir()) and touches no file, except assertTestSafeWrite (the
// test-run guard at the end).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env as lookup } from "./env.js";
import { AgentLinkError } from "./errors.js";

/**
 * @typedef {object} PathOptions
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [homedir]
 */

/**
 * @typedef {object} LegacyPaths
 * @property {string} mailbox
 * @property {string} receipts
 * @property {string} managedAppServers
 */

/**
 * Settings that name Agent Link's own files. A relative value is rejected:
 * the hook runs in the session's project directory and the server in the
 * plugin root, so one relative path would name two different files.
 */
const AGENT_LINK_PATH_SETTINGS = new Set([
  "AGENT_LINK_STATE_DIR",
  "AGENT_LINK_MAILBOX_PATH",
  "AGENT_LINK_RECEIPT_LOG",
  "AGENT_LINK_MANAGED_DIR",
  "AGENT_LINK_LOG_FILE"
]);

/**
 * @param {PathOptions} [options]
 */
function resolveOptions(options = {}) {
  return {
    source: options.env ?? process.env,
    home: options.homedir ?? os.homedir()
  };
}

/**
 * Expands a leading `~` or `~/` and normalizes an absolute path. Returns null
 * for a relative path: callers reject it (Agent Link settings) or resolve it
 * (host-provided directories).
 * @param {string} value
 * @param {string} home
 * @returns {string | null}
 */
export function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return path.isAbsolute(value) ? path.normalize(value) : null;
}

/**
 * Thrown when an Agent Link path setting is relative. Names the variable that
 * supplied the value (canonical or legacy alias) so the fix is obvious.
 */
export class PathConfigError extends AgentLinkError {
  /**
   * @param {string} variable
   * @param {string} value
   */
  constructor(variable, value) {
    super(
      "state_io_error",
      `${variable} must be an absolute path or start with ~/ (got the relative path ${JSON.stringify(value)}). ` +
        "The Claude hook and the MCP server run from different working directories, so a relative path would name two different files.",
      {
        details: { variable, value },
        hint: `Set ${variable} to an absolute path, or unset it to use the default under ~/.agent-link.`
      }
    );
    this.name = "PathConfigError";
  }
}

/**
 * @param {string} name
 * @param {PathOptions} options
 * @returns {string | null}
 */
function configuredPath(name, options) {
  const { source, home } = resolveOptions(options);
  const found = lookup(name, source);
  const value = found.value?.trim();
  if (!value) return null;
  const expanded = expandHome(value, home);
  if (expanded) return expanded;
  if (AGENT_LINK_PATH_SETTINGS.has(name)) {
    throw new PathConfigError(/** @type {string} */ (found.source), value);
  }
  // Host-provided directories (CLAUDE_CONFIG_DIR, CODEX_HOME) keep the
  // host's own meaning: relative to the current directory.
  return path.resolve(value);
}

/**
 * True when `name` (or one of its legacy aliases) is set to a non-blank value.
 * @param {string} name
 * @param {PathOptions} [options]
 * @returns {boolean}
 */
export function isConfigured(name, options = {}) {
  return Boolean(lookup(name, resolveOptions(options).source).value?.trim());
}

/**
 * State root: AGENT_LINK_STATE_DIR, default ~/.agent-link.
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function stateDir(options = {}) {
  return configuredPath("AGENT_LINK_STATE_DIR", options)
    ?? path.join(resolveOptions(options).home, ".agent-link");
}

/**
 * Claude config dir: CLAUDE_CONFIG_DIR, default ~/.claude (R4.9).
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function claudeConfigDir(options = {}) {
  return configuredPath("CLAUDE_CONFIG_DIR", options)
    ?? path.join(resolveOptions(options).home, ".claude");
}

/**
 * Codex home: CODEX_HOME, default ~/.codex.
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function codexHome(options = {}) {
  return configuredPath("CODEX_HOME", options)
    ?? path.join(resolveOptions(options).home, ".codex");
}

/**
 * The mailbox file new events are appended to: AGENT_LINK_MAILBOX_PATH, else
 * mailbox.jsonl in the state directory.
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function mailboxPath(options = {}) {
  const explicit = configuredPath("AGENT_LINK_MAILBOX_PATH", options);
  if (explicit) return explicit;
  return path.join(stateDir(options), "mailbox.jsonl");
}

/**
 * The fork job log (design doc R9.7): `<state>/forks.jsonl`, one event per
 * line (created, forked, compacted, turn-started, completed | failed |
 * interrupted, reconciled, archived).
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function forkJobsPath(options = {}) {
  return path.join(stateDir(options), "forks.jsonl");
}

/**
 * Where receipts are written. With no override, reads also merge the legacy
 * log from legacyReceiptPaths().
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function receiptLogPath(options = {}) {
  return configuredPath("AGENT_LINK_RECEIPT_LOG", options)
    ?? path.join(stateDir(options), "receipts.jsonl");
}

/**
 * Managed app-server records. The legacy CODEX_AGENT_LINK_STATE_DIR only ever
 * meant this directory, so it is an alias of AGENT_LINK_MANAGED_DIR.
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function managedAppServerDir(options = {}) {
  return configuredPath("AGENT_LINK_MANAGED_DIR", options)
    ?? path.join(stateDir(options), "managed-app-servers");
}

/**
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function logDir(options = {}) {
  return path.join(stateDir(options), "logs");
}

/**
 * Log file: AGENT_LINK_LOG_FILE, default <state>/logs/agent-link.log.
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function logFilePath(options = {}) {
  return configuredPath("AGENT_LINK_LOG_FILE", options)
    ?? path.join(logDir(options), "agent-link.log");
}

/**
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function migrationRecordPath(options = {}) {
  return path.join(stateDir(options), "migration.json");
}

/**
 * The role table (design doc R1.18): `<state>/roles.json`.
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function rolesPath(options = {}) {
  return path.join(stateDir(options), "roles.json");
}

/**
 * Role procedure files (R1.20): `<state>/roles/<name>.md`.
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function roleProceduresDir(options = {}) {
  return path.join(stateDir(options), "roles");
}

/**
 * Where releases up to 0.4.x kept state. Read-only from 0.4.x on.
 * @param {PathOptions} [options]
 * @returns {LegacyPaths}
 */
export function legacyPaths(options = {}) {
  const { home } = resolveOptions(options);
  // The 0.4.x mailbox and managed records ignored CLAUDE_CONFIG_DIR and lived
  // under ~/.claude; the receipt log lived in $CODEX_HOME.
  const legacyClaudeDir = path.join(home, ".claude", "agent-link");
  return {
    mailbox: path.join(legacyClaudeDir, "mailbox.jsonl"),
    receipts: path.join(codexHome(options), "agent-link-receipts.jsonl"),
    managedAppServers: path.join(legacyClaudeDir, "managed-app-servers")
  };
}

/**
 * Legacy locations under CLAUDE_CONFIG_DIR, for users who set it. Section 4.4
 * reads the legacy mailbox from `<claudeConfigDir>/agent-link` as well as
 * ~/.claude/agent-link.
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function legacyClaudeStateDir(options = {}) {
  return path.join(claudeConfigDir(options), "agent-link");
}

/**
 * Legacy mailbox files merged into reads (R4.5): the 0.4.x default under
 * ~/.claude, plus <CLAUDE_CONFIG_DIR>/agent-link when that differs. Empty when
 * AGENT_LINK_MAILBOX_PATH names the mailbox: an explicit choice is never mixed
 * with other files.
 * @param {PathOptions} [options]
 * @returns {string[]}
 */
export function legacyMailboxPaths(options = {}) {
  if (isConfigured("AGENT_LINK_MAILBOX_PATH", options)) return [];
  return without(unique([
    legacyPaths(options).mailbox,
    path.join(legacyClaudeStateDir(options), "mailbox.jsonl")
  ]), mailboxPath(options));
}

/**
 * Legacy receipt log merged into reads, or none when a receipt-log override
 * is set.
 * @param {PathOptions} [options]
 * @returns {string[]}
 */
export function legacyReceiptPaths(options = {}) {
  if (isConfigured("AGENT_LINK_RECEIPT_LOG", options)) return [];
  return without([path.resolve(legacyPaths(options).receipts)], receiptLogPath(options));
}

/**
 * Legacy managed app-server record directories that orphan reaping also
 * scans, or none when the managed dir is overridden.
 * @param {PathOptions} [options]
 * @returns {string[]}
 */
export function legacyManagedAppServerDirs(options = {}) {
  if (isConfigured("AGENT_LINK_MANAGED_DIR", options)) return [];
  return without(unique([
    legacyPaths(options).managedAppServers,
    path.join(legacyClaudeStateDir(options), "managed-app-servers")
  ]), managedAppServerDir(options));
}

/**
 * @param {string[]} paths
 * @returns {string[]}
 */
function unique(paths) {
  return [...new Set(paths.map((p) => path.resolve(p)))];
}

/**
 * Drops `current` (an AGENT_LINK_STATE_DIR pointed at the old location must
 * not read one file twice).
 * @param {string[]} paths
 * @param {string} current
 * @returns {string[]}
 */
function without(paths, current) {
  const resolved = path.resolve(current);
  return paths.filter((p) => p !== resolved);
}

/**
 * Test-run guard (not pure: reads process.env and the user database). Under
 * `node --test` (NODE_TEST_CONTEXT is set) Agent Link refuses to create or
 * write state under the real home directory (os.userInfo().homedir, which
 * ignores HOME), unless the path is inside the temp directory. A test that
 * forgot to point HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, AGENT_LINK_STATE_DIR
 * and AGENT_LINK_MAILBOX_PATH at a temp directory fails here instead of
 * writing the user's mailbox, receipts or roles. Outside tests it does
 * nothing.
 * @param {string} target  a file or directory about to be written
 * @param {{env?: Record<string, string | undefined>, realHome?: string | null, tmpdir?: string}} [options]
 *   realHome / tmpdir: injected for tests; by default both are resolved once
 *   per process
 */
export function assertTestSafeWrite(target, { env = process.env, realHome = undefined, tmpdir = undefined } = {}) {
  if (!env.NODE_TEST_CONTEXT || typeof target !== "string") return;
  const roots = guardRoots(realHome, tmpdir);
  if (!roots) return;
  const resolved = canonical(target);
  const { home, tmp } = roots;
  const within = (/** @type {string} */ p, /** @type {string} */ root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  // The real home's own state roots are refused even when the temp
  // directory is inside the home (TMPDIR under $HOME, or TMPDIR = $HOME).
  const realRoots = [".agent-link", ".claude", ".codex"].map((name) => path.join(home, name));
  if (resolved === home || realRoots.some((root) => within(resolved, root)) || (within(resolved, home) && !within(resolved, tmp))) {
    throw new Error(`Agent Link refuses to write ${resolved} during a test run (NODE_TEST_CONTEXT is set): it is under the real home directory. Run tests with npm test, or point HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, AGENT_LINK_STATE_DIR and AGENT_LINK_MAILBOX_PATH at a temp directory.`);
  }
}

/** @type {{home: string, tmp: string} | null | undefined} */
let defaultRoots;

/**
 * The canonical real home and temp directory, cached for the process when
 * neither is injected (the guard runs on hot write paths in tests).
 * @param {string | null | undefined} realHome
 * @param {string | undefined} tmpdir
 * @returns {{home: string, tmp: string} | null}
 */
function guardRoots(realHome, tmpdir) {
  if (realHome === undefined && tmpdir === undefined) {
    if (defaultRoots === undefined) {
      const home = realHomeDir();
      defaultRoots = home ? { home: canonical(home), tmp: canonical(os.tmpdir()) } : null;
    }
    return defaultRoots;
  }
  const home = realHome === undefined ? realHomeDir() : realHome;
  return home ? { home: canonical(home), tmp: canonical(tmpdir ?? os.tmpdir()) } : null;
}

/** @returns {string | null} */
function realHomeDir() {
  try {
    return os.userInfo().homedir || null;
  } catch {
    return null;
  }
}

/**
 * The real path of `value`, or of its nearest existing ancestor joined with
 * the rest (macOS /var is /private/var).
 * @param {string} value
 */
function canonical(value) {
  let current = path.resolve(value);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}
