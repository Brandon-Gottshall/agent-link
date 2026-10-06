// src/shared/log.js
//
// Diagnostics for the MCP server and hooks. stdout carries the MCP protocol,
// so nothing here ever writes to it.
//
// Levels, most to least severe: error < warn < info < debug. The threshold is
// AGENT_LINK_LOG_LEVEL, else `debug` when AGENT_LINK_DEBUG is on (1, true,
// yes or on), else `warn`.
// Events at or above the threshold go to stderr as one line, and to the log
// file as JSON lines when AGENT_LINK_LOG_FILE is set or debug is on (default
// file <state>/logs/agent-link.log). The file is capped at maxFileBytes and
// rotated once to `<file>.1`. Every error/warn/info event (and debug events
// when enabled) also lands in an in-memory ring buffer that health reports as
// recentEvents.

import fs from "node:fs";
import path from "node:path";
import { env as lookup, envFlag } from "./env.js";
import { DIR_MODE, FILE_MODE } from "./jsonl.js";
import { logFilePath } from "./paths.js";
import { tightenMode } from "./state.js";

/** @typedef {"error" | "warn" | "info" | "debug"} LogLevel */

/**
 * @typedef {object} LogEvent
 * @property {string} at       ISO 8601 UTC
 * @property {LogLevel} level
 * @property {string} event    short dotted name, e.g. "app_server.exit"
 * @property {Record<string, unknown>} [fields]
 */

/**
 * @typedef {object} LoggerOptions
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [homedir]
 * @property {{write(chunk: string): unknown}} [stderr]
 * @property {() => Date} [clock]
 * @property {number} [ringSize]
 * @property {number} [maxFileBytes]
 */

/**
 * @typedef {object} Logger
 * @property {LogLevel} level
 * @property {string | null} filePath
 * @property {(level: LogLevel) => boolean} enabled
 * @property {(level: LogLevel, event: string, fields?: Record<string, unknown>) => void} log
 * @property {(event: string, fields?: Record<string, unknown>) => void} error
 * @property {(event: string, fields?: Record<string, unknown>) => void} warn
 * @property {(event: string, fields?: Record<string, unknown>) => void} info
 * @property {(event: string, fields?: Record<string, unknown>) => void} debug
 * @property {(limit?: number) => LogEvent[]} recentEvents
 */

/** @type {Readonly<Record<LogLevel, number>>} */
export const LOG_LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

export const DEFAULT_RING_SIZE = 200;
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_STRING_FIELD = 4000;

/**
 * @param {unknown} value
 * @returns {value is LogLevel}
 */
function isLevel(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LOG_LEVELS, value);
}

/**
 * The threshold for an environment.
 * @param {Record<string, string | undefined>} [source]
 * @returns {LogLevel}
 */
export function resolveLogLevel(source = process.env) {
  const configured = lookup("AGENT_LINK_LOG_LEVEL", source).value?.trim().toLowerCase();
  if (isLevel(configured)) return configured;
  return envFlag("AGENT_LINK_DEBUG", false, source) ? "debug" : "warn";
}

/**
 * Errors become `{name, message, code}`; long strings are cut. No stacks.
 * @param {Record<string, unknown> | undefined} fields
 * @returns {Record<string, unknown> | undefined}
 */
function cleanFields(fields) {
  if (!fields) return undefined;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value instanceof Error) {
      const code = /** @type {{code?: unknown}} */ (value).code;
      out[key] = { name: value.name, message: value.message, ...(code !== undefined ? { code } : {}) };
    } else if (typeof value === "string" && value.length > MAX_STRING_FIELD) {
      out[key] = `${value.slice(0, MAX_STRING_FIELD)}...`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param {LoggerOptions} [options]
 * @returns {Logger}
 */
export function createLogger(options = {}) {
  const source = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const clock = options.clock ?? (() => new Date());
  const ringSize = options.ringSize ?? DEFAULT_RING_SIZE;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const level = resolveLogLevel(source);
  const threshold = LOG_LEVELS[level];
  const fileWanted = Boolean(lookup("AGENT_LINK_LOG_FILE", source).value) || level === "debug";
  /** @type {string | null} */
  let filePath = null;
  if (fileWanted) {
    try {
      filePath = logFilePath({ env: source, homedir: options.homedir });
    } catch (error) {
      // A relative AGENT_LINK_LOG_FILE: say so once and log to stderr only.
      try {
        stderr.write(`agent-link: [warn] log.file_disabled ${JSON.stringify({ error: /** @type {Error} */ (error).message })}\n`);
      } catch {
        // stderr closed
      }
    }
  }
  let fileChecked = false;
  /** @type {LogEvent[]} */
  const ring = [];

  /** @param {string} line */
  function writeFile(line) {
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
      if (!fileChecked) {
        // An existing log file from an older release may be looser than 0600.
        fileChecked = true;
        tightenMode(filePath, FILE_MODE);
      }
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch {
        // missing: created below
      }
      if (size > 0 && size + Buffer.byteLength(line) > maxFileBytes) {
        fs.renameSync(filePath, `${filePath}.1`);
      }
      fs.appendFileSync(filePath, line, { encoding: "utf8", mode: FILE_MODE });
    } catch (error) {
      // One notice, then stop trying: logging must never break the server.
      const failed = filePath;
      filePath = null;
      try {
        stderr.write(`agent-link: [warn] log.file_disabled ${JSON.stringify({ path: failed, error: /** @type {Error} */ (error).message })}\n`);
      } catch {
        // stderr closed
      }
    }
  }

  /** @type {Logger["log"]} */
  function log(eventLevel, event, fields) {
    const rank = LOG_LEVELS[eventLevel];
    const shown = rank <= threshold;
    if (!shown && rank > LOG_LEVELS.info) return;
    /** @type {LogEvent} */
    const entry = { at: clock().toISOString(), level: eventLevel, event };
    const cleaned = cleanFields(fields);
    if (cleaned && Object.keys(cleaned).length > 0) entry.fields = cleaned;
    ring.push(entry);
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
    if (!shown) return;
    try {
      stderr.write(`agent-link: [${eventLevel}] ${event}${entry.fields ? ` ${JSON.stringify(entry.fields)}` : ""}\n`);
    } catch {
      // stderr closed
    }
    writeFile(`${JSON.stringify(entry)}\n`);
  }

  return {
    level,
    get filePath() {
      return filePath;
    },
    enabled: (eventLevel) => LOG_LEVELS[eventLevel] <= threshold,
    log,
    error: (event, fields) => log("error", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    info: (event, fields) => log("info", event, fields),
    debug: (event, fields) => log("debug", event, fields),
    recentEvents: (limit = ringSize) => (limit > 0 ? ring.slice(-limit) : []).map((entry) => ({ ...entry }))
  };
}

/** @type {Logger | null} */
let shared = null;

/**
 * The process-wide logger, created from process.env on first use.
 * @returns {Logger}
 */
export function getLogger() {
  shared ??= createLogger();
  return shared;
}

/**
 * Replaces the process-wide logger (tests). Pass null to reset.
 * @param {Logger | null} logger
 */
export function setLogger(logger) {
  shared = logger;
}
