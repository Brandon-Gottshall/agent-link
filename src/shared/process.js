// src/shared/process.js
//
// Small child-process and timing helpers (moved from src/server.js in PR B5).
// Nothing runs at import time.

import { spawn } from "node:child_process";

/**
 * How a child started by spawnAndWait ended: `error` when it could not be
 * started (or failed before exiting), otherwise its exit code and signal.
 * @typedef {{error: Error, code?: undefined, signal?: undefined} | {error?: undefined, code: number | null, signal: NodeJS.Signals | null}} SpawnOutcome
 */

/**
 * Runs `command args` with stdio ignored and resolves with the first of its
 * `error` or `exit` events. Never rejects.
 * @param {string} command
 * @param {string[]} args
 * @param {{spawnImpl?: typeof spawn}} [options]
 * @returns {Promise<SpawnOutcome>}
 */
export function spawnAndWait(command, args, { spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, {
      stdio: "ignore"
    });

    child.on("error", (error) => {
      resolve({ error });
    });

    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

/**
 * A command argument quoted for display in a POSIX shell. Display only: the
 * command itself is never run through a shell.
 * @param {string} value
 * @returns {string}
 */
export function shellQuoteForDisplay(value) {
  if (/^[A-Za-z0-9_/:.=+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
