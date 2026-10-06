// src/shared/paths.js
//
// The path resolver for Agent Link state (design doc sections 4.3/4.4). The
// state root is ~/.agent-link unless AGENT_LINK_STATE_DIR says otherwise;
// legacy locations under ~/.claude and $CODEX_HOME are reported separately so
// a later PR can merge reads from them.
//
// Pure: every function takes `{env, homedir}` (defaults: process.env and
// os.homedir()) and touches no file. Not wired into the mailbox, receipts or
// app-server yet; they keep their own defaults until the state-dir PR.

import os from "node:os";
import path from "node:path";
import { env as lookup } from "./env.js";

/**
 * @typedef {object} PathOptions
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [homedir]
 */

/**
 * @typedef {object} LegacyPaths
 * @property {string} mailbox
 * @property {string} mailboxDb
 * @property {string} receipts
 * @property {string} managedAppServers
 */

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
 * Expands a leading `~` or `~/` and makes the path absolute.
 * @param {string} value
 * @param {string} home
 * @returns {string}
 */
export function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return path.resolve(value);
}

/**
 * @param {string} name
 * @param {PathOptions} options
 * @returns {string | null}
 */
function configuredPath(name, options) {
  const { source, home } = resolveOptions(options);
  const value = lookup(name, source).value;
  return value ? expandHome(value, home) : null;
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
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function mailboxPath(options = {}) {
  return configuredPath("AGENT_LINK_MAILBOX_PATH", options)
    ?? path.join(stateDir(options), "mailbox.jsonl");
}

/**
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
 * Where releases up to 0.4.x kept state. Read-only from the state-dir PR on.
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
    mailboxDb: path.join(legacyClaudeDir, "mailbox.sqlite"),
    receipts: path.join(codexHome(options), "agent-link-receipts.jsonl"),
    managedAppServers: path.join(legacyClaudeDir, "managed-app-servers")
  };
}

/**
 * Legacy locations under CLAUDE_CONFIG_DIR, for users who set it. Section 4.4
 * reads the legacy mailbox from `<claudeConfigDir>/agent-link`; when that
 * differs from ~/.claude the state-dir PR checks both.
 * @param {PathOptions} [options]
 * @returns {string}
 */
export function legacyClaudeStateDir(options = {}) {
  return path.join(claudeConfigDir(options), "agent-link");
}
