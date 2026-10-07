// src/shared/state.js
//
// Creates the Agent Link state directory (design doc section 4.3) the first
// time something is written there: directory 0700, files 0600. The first
// creation also records which legacy files existed (`migration.json`, R4.7),
// so health can later tell when an older plugin copy is still writing to the
// legacy locations. Legacy files are only ever read, never changed.

import fs from "node:fs";
import { DIR_MODE, FILE_MODE } from "./jsonl.js";
import {
  legacyMailboxPaths,
  legacyManagedAppServerDirs,
  legacyReceiptPaths,
  assertTestSafeWrite,
  migrationRecordPath,
  stateDir
} from "./paths.js";

// The bundled server has the version compiled in; the hook runs from src/,
// so it reads the plugin's package.json instead.
function pluginVersion() {
  if (typeof __AGENT_LINK_VERSION__ === "string") return __AGENT_LINK_VERSION__;
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Makes `target` mode `mode` when this user owns it and it is looser.
 * @param {string} target
 * @param {number} mode
 */
export function tightenMode(target, mode) {
  try {
    const stat = fs.statSync(target);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && stat.uid !== uid) return;
    if ((stat.mode & 0o777 & ~mode) !== 0) fs.chmodSync(target, mode);
  } catch {
    // missing or not ours: leave it alone
  }
}

/**
 * Creates the state directory 0700 (tightening an existing one this user
 * owns) and writes migration.json once. Returns the directory.
 * @param {import("./paths.js").PathOptions} [options]
 * @returns {string}
 */
export function ensureStateDir(options = {}) {
  const dir = stateDir(options);
  assertTestSafeWrite(dir);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  tightenMode(dir, DIR_MODE);
  writeMigrationRecord(options);
  return dir;
}

/**
 * @param {import("./paths.js").PathOptions} options
 */
function writeMigrationRecord(options) {
  const file = migrationRecordPath(options);
  if (fs.existsSync(file)) return;
  const from = [
    ...legacyMailboxPaths(options),
    ...legacyReceiptPaths(options),
    ...legacyManagedAppServerDirs(options)
  ].filter((candidate) => fs.existsSync(candidate));
  const record = { from, at: new Date().toISOString(), version: pluginVersion() };
  try {
    // "wx": a concurrent first open (hook and server) keeps the first record.
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
  } catch {
    // already written, or not writable: the record is advisory
  }
}
