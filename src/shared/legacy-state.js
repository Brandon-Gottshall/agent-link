// src/shared/legacy-state.js
//
// health.legacyState (design doc R4.7): which pre-0.5 state files still
// exist, when each was last modified, and whether one changed after
// ~/.agent-link/migration.json was written, which means an older plugin copy
// ran somewhere and wrote to the old location. Only a recent such write (within
// LEGACY_ACTIVE_WINDOW_MS) means one is still running; an older one is reported
// as a note, because the mtime comparison alone stays true forever once any old
// copy has written once. Read-only: never creates the state directory.

import fs from "node:fs";
import path from "node:path";
import {
  legacyManagedAppServerDirs,
  legacyMailboxPaths,
  legacyReceiptPaths,
  migrationRecordPath
} from "./paths.js";

/**
 * @typedef {object} LegacyFile
 * @property {"mailbox" | "receipts" | "managedAppServers"} kind
 * @property {string} path
 * @property {string | null} modifiedAt          ISO 8601
 * @property {boolean | null} writtenAfterMigration   null when there is no migration record
 * @property {boolean | null} writtenRecently   written after the migration and within LEGACY_ACTIVE_WINDOW_MS
 */

/**
 * @typedef {object} LegacyStateReport
 * @property {LegacyFile[]} files
 * @property {{path: string, at: string | null, version: string | null, from: string[]} | null} migration
 * @property {boolean} stillWritten          a legacy file was written after the migration within LEGACY_ACTIVE_WINDOW_MS
 * @property {string | null} lastWrittenAfterMigrationAt   ISO 8601 of the newest post-migration legacy write
 * @property {string | null} warning
 * @property {string | null} note            post-migration writes exist but none is recent
 */

/** A legacy write newer than this means an older plugin copy is still running. */
export const LEGACY_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const LEGACY_STILL_WRITTEN_WARNING =
  "A legacy Agent Link state file changed after the migration to ~/.agent-link: an older plugin copy is still running. Upgrade the plugin in every harness and restart its sessions.";

/**
 * @param {string} at   ISO 8601
 */
export function legacyQuietNote(at) {
  return `A legacy Agent Link state file was last written after the migration at ${at}, more than 24 hours ago. No older plugin copy appears to be running now.`;
}

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
 * @param {import("./paths.js").PathOptions & {now?: number}} [options]   `now` (ms) is for tests
 * @returns {LegacyStateReport}
 */
export function legacyStateReport(options = {}) {
  const now = options.now ?? Date.now();
  const migration = readMigration(options);
  const migratedAt = migration?.at ? Date.parse(migration.at) : NaN;
  /** @type {[LegacyFile["kind"], string][]} */
  const candidates = [
    ...legacyMailboxPaths(options).map((p) => /** @type {[LegacyFile["kind"], string]} */ (["mailbox", p])),
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
    const writtenAfterMigration = Number.isFinite(migratedAt) && mtimeMs !== null ? mtimeMs > migratedAt : null;
    files.push({
      kind,
      path: file,
      modifiedAt: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
      writtenAfterMigration,
      writtenRecently: writtenAfterMigration === null ? null : writtenAfterMigration && now - /** @type {number} */ (mtimeMs) <= LEGACY_ACTIVE_WINDOW_MS
    });
  }
  const stillWritten = files.some((file) => file.writtenRecently === true);
  const lastWrittenAfterMigrationAt =
    files
      .filter((file) => file.writtenAfterMigration === true && file.modifiedAt !== null)
      .map((file) => /** @type {string} */ (file.modifiedAt))
      .sort()
      .at(-1) ?? null;
  return {
    files,
    migration,
    stillWritten,
    lastWrittenAfterMigrationAt,
    warning: stillWritten ? LEGACY_STILL_WRITTEN_WARNING : null,
    note: !stillWritten && lastWrittenAfterMigrationAt ? legacyQuietNote(lastWrittenAfterMigrationAt) : null
  };
}
