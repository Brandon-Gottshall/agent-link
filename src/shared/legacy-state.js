// src/shared/legacy-state.js
//
// health.legacyState (design doc R4.7): which pre-0.5 state files still
// exist, when each was last modified, and whether one changed after
// ~/.agent-link/migration.json was written, which means an older plugin copy
// is still running somewhere and writing to the old location. Read-only:
// never creates the state directory.

import fs from "node:fs";
import path from "node:path";
import {
  legacyManagedAppServerDirs,
  legacyMailboxPaths,
  legacyPaths,
  legacyReceiptPaths,
  migrationRecordPath
} from "./paths.js";

/**
 * @typedef {object} LegacyFile
 * @property {"mailbox" | "mailboxDb" | "receipts" | "managedAppServers"} kind
 * @property {string} path
 * @property {string | null} modifiedAt          ISO 8601
 * @property {boolean | null} writtenAfterMigration   null when there is no migration record
 */

/**
 * @typedef {object} LegacyStateReport
 * @property {LegacyFile[]} files
 * @property {{path: string, at: string | null, version: string | null, from: string[]} | null} migration
 * @property {boolean} stillWritten
 * @property {string | null} warning
 */

export const LEGACY_STILL_WRITTEN_WARNING =
  "A legacy Agent Link state file changed after the migration to ~/.agent-link: an older plugin copy is still running. Upgrade the plugin in every harness and restart its sessions.";

/**
 * @param {string} file
 * @returns {fs.Stats | null}
 */
function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/**
 * Newest mtime of the managed app-server records (`<pid>.json`) in `dir`,
 * or null when it holds none.
 * @param {string} dir
 * @returns {number | null}
 */
function newestRecordMtimeMs(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let newest = null;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const stat = statOrNull(path.join(dir, name));
    if (stat?.isFile() && (newest === null || stat.mtimeMs > newest)) newest = stat.mtimeMs;
  }
  return newest;
}

/**
 * @param {import("./paths.js").PathOptions} [options]
 */
function readMigration(options) {
  const file = migrationRecordPath(options);
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      path: file,
      at: typeof record?.at === "string" ? record.at : null,
      version: typeof record?.version === "string" ? record.version : null,
      from: Array.isArray(record?.from) ? record.from.filter((/** @type {unknown} */ p) => typeof p === "string") : []
    };
  } catch {
    return null;
  }
}

/**
 * @param {import("./paths.js").PathOptions} [options]
 * @returns {LegacyStateReport}
 */
export function legacyStateReport(options = {}) {
  const migration = readMigration(options);
  const migratedAt = migration?.at ? Date.parse(migration.at) : NaN;
  /** @type {[LegacyFile["kind"], string][]} */
  const candidates = [
    ...legacyMailboxPaths(options).map((p) => /** @type {[LegacyFile["kind"], string]} */ (["mailbox", p])),
    ["mailboxDb", legacyPaths(options).mailboxDb],
    ...legacyReceiptPaths(options).map((p) => /** @type {[LegacyFile["kind"], string]} */ (["receipts", p])),
    ...legacyManagedAppServerDirs(options).map((p) => /** @type {[LegacyFile["kind"], string]} */ (["managedAppServers", p]))
  ];
  /** @type {LegacyFile[]} */
  const files = [];
  for (const [kind, file] of candidates) {
    const stat = statOrNull(file);
    if (!stat) continue;
    // A managed app-server directory's own mtime also changes when this
    // version reaps a stale record there (a delete), so only the records'
    // own mtimes count: a record newer than the migration was written by a
    // 0.4.x server.
    const mtimeMs = kind === "managedAppServers" ? newestRecordMtimeMs(file) : stat.mtimeMs;
    files.push({
      kind,
      path: file,
      modifiedAt: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
      writtenAfterMigration: Number.isFinite(migratedAt) && mtimeMs !== null ? mtimeMs > migratedAt : null
    });
  }
  const stillWritten = files.some((file) => file.writtenAfterMigration === true);
  return {
    files,
    migration,
    stillWritten,
    warning: stillWritten ? LEGACY_STILL_WRITTEN_WARNING : null
  };
}
