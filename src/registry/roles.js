// src/registry/roles.js
//
// User-assigned roles (design doc section 1.8, PR B9). Two files hold them:
//
//   <state>/roles.json         the user's configuration (0600)
//     { "version": 1,
//       "enforcement": "off" | "warn" | "enforce",          (optional, R1.25)
//       "roles": { "<name>": { "address": "codex:<id>", "assignedAt": "<iso>" } },
//       "overridePolicy": { "<target>": {"model": [...], "effort": [...], "cwd": [...]} } }
//   <state>/roles/<name>.md    each role's procedure text (R1.20)
//
// and Agent Link's own bookkeeping, which is never part of the user's file:
//
//   <state>/role-state.json
//     { "version": 1,
//       "procedures": { "<name>": {"version", "sha256", "updatedAt"} },
//       "deliveries": { "<name>": { "<holder address>": "<sha256 last delivered>" } } }
//
// A role is a pointer, not a privilege (R1.22): it names the session that
// receives `role:<name>` messages and carries one procedure the user tunes in
// one place. The only permission in the table is target-side, the override
// policy (R9.4).
//
// roles.json is written only by the role write tools. Each write takes a lock
// file, re-reads the file, changes only the keys it owns on the raw JSON (so
// entries it does not understand survive), and replaces the file atomically
// (temporary file, fsync, rename). A file whose `version` is not 1 is never
// written. Reads validate on every call and never write: invalid entries are
// ignored and reported, and a file that cannot be parsed fails role lookups
// with state_io_error and is read as an empty policy (nothing allowed).
// Procedure versions are assigned only on send paths and by set_agent_role,
// so the read-only tools never write anything.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentLinkError } from "../shared/errors.js";
import { env as lookupEnv } from "../shared/env.js";
import { isAddress } from "../shared/identity.js";
import { DIR_MODE, FILE_MODE } from "../shared/jsonl.js";
import { roleProceduresDir, rolesPath, stateDir } from "../shared/paths.js";
import { ensureStateDir, tightenMode } from "../shared/state.js";

export const ROLE_NAME_PATTERN = /^[a-z0-9-]{1,40}$/;
export const ROLE_ADDRESS_PATTERN = /^role:([a-z0-9-]{1,40})$/;
export const ROLE_TABLE_VERSION = 1;
export const ENFORCEMENT_MODES = Object.freeze(["off", "warn", "enforce"]);
/** The release default (R1.26): B9 ships with enforcement off. */
export const DEFAULT_ENFORCEMENT = "off";
export const POLICY_SETTINGS = Object.freeze(["model", "effort", "cwd"]);
/** Procedure text is user configuration shown to the role holder; same cap as a message body. */
export const MAX_PROCEDURE_BYTES = 64 * 1024;
/** Maximum senders per policy setting. */
export const MAX_POLICY_SENDERS = 50;

const LOCK_STALE_MS = 30_000;
// Critical sections take milliseconds. A request waits at most this long for
// the lock and then fails fast with a retry hint instead of blocking the
// server's event loop.
const LOCK_TIMEOUT_MS = 250;
const LOCK_RETRY_MS = 5;
const BREAKER_STALE_MS = 5_000;
const STATE_FILE = "role-state.json";
const STATE_VERSION = 1;

/**
 * @typedef {{version: number, sha256: string, updatedAt: string}} ProcedureRecord
 * @typedef {{address: string | string[] | null, assignedAt: string | null, projects?: Record<string, string>}} RoleRecord
 *   projects: per-project holders, absolute project root -> address (the
 *   `orchestrator` role scoped by project root, R1.21)
 * @typedef {{model?: string[], effort?: string[], cwd?: string[]}} PolicyEntry
 * @typedef {{
 *   version: number,
 *   enforcement: string | null,
 *   roles: Record<string, RoleRecord>,
 *   overridePolicy: Record<string, PolicyEntry>
 * }} RoleTable
 * @typedef {{path: string, rule: string, message: string}} TableProblem
 * @typedef {{table: RoleTable, problems: TableProblem[], error: string | null, path: string, exists: boolean, writable: boolean, raw: Record<string, any> | null}} TableRead
 * @typedef {{version: number, procedures: Record<string, ProcedureRecord>, deliveries: Record<string, Record<string, string>>}} RoleState
 */

/** @returns {RoleTable} */
export function emptyRoleTable() {
  return { version: ROLE_TABLE_VERSION, enforcement: null, roles: {}, overridePolicy: {} };
}

/**
 * The role name in `role:<name>`, or null when the value is not a role address.
 * @param {unknown} value
 * @returns {string | null}
 */
export function parseRoleAddress(value) {
  if (typeof value !== "string") return null;
  const match = ROLE_ADDRESS_PATTERN.exec(value.trim());
  return match ? match[1] : null;
}

/**
 * True when the value looks like a role address attempt (`role:` prefix),
 * valid or not, so callers can reject a malformed name instead of treating
 * it as a fuzzy query.
 * @param {unknown} value
 */
export function looksLikeRoleAddress(value) {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("role:");
}

/**
 * Throws invalid_arguments unless `value` is a role name (`[a-z0-9-]{1,40}`).
 * A `role:` prefix is accepted and stripped.
 * @param {unknown} value
 * @param {string} [argument]
 * @returns {string}
 */
export function requireRoleName(value, argument = "role") {
  const raw = typeof value === "string" ? value.trim() : "";
  const name = raw.startsWith("role:") ? raw.slice("role:".length) : raw;
  if (!ROLE_NAME_PATTERN.test(name)) {
    throw new AgentLinkError("invalid_arguments", `${argument} must be a role name of 1 to 40 lowercase letters, digits, or hyphens (optionally written role:<name>).`, {
      details: { errors: [{ path: argument, rule: "pattern", expected: "[a-z0-9-]{1,40}" }] }
    });
  }
  return name;
}

/**
 * A policy sender entry: "*", role:<name>, or a session address.
 * @param {unknown} value
 */
export function isPolicySender(value) {
  return value === "*" || parseRoleAddress(value) !== null || isAddress(value);
}

/**
 * A policy target key: role:<name> or a session address.
 * @param {unknown} value
 */
export function isPolicyTarget(value) {
  return parseRoleAddress(value) !== null || isAddress(value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
function isoOrNull(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
}

/**
 * Validates a parsed table. Invalid entries are dropped and reported in
 * `problems`; the result is always a well-formed table.
 * @param {unknown} raw
 * @returns {{table: RoleTable, problems: TableProblem[]}}
 */
export function validateRoleTable(raw) {
  /** @type {TableProblem[]} */
  const problems = [];
  const table = emptyRoleTable();
  if (!isPlainObject(raw)) {
    problems.push({ path: "", rule: "type", message: "roles.json must hold a JSON object." });
    return { table, problems };
  }
  if (raw.version !== ROLE_TABLE_VERSION) {
    problems.push({ path: "version", rule: "version", message: `roles.json version is ${JSON.stringify(raw.version ?? null)}; expected ${ROLE_TABLE_VERSION}. Entries were read as version ${ROLE_TABLE_VERSION}, and Agent Link will not write the file until its version is ${ROLE_TABLE_VERSION}.` });
  }
  if (raw.enforcement !== undefined && raw.enforcement !== null) {
    if (ENFORCEMENT_MODES.includes(raw.enforcement)) table.enforcement = raw.enforcement;
    else problems.push({ path: "enforcement", rule: "enum", message: `enforcement must be one of ${ENFORCEMENT_MODES.join(", ")}; ignored.` });
  }
  if (raw.roles !== undefined && !isPlainObject(raw.roles)) {
    problems.push({ path: "roles", rule: "type", message: "roles must be an object; ignored." });
  }
  for (const [name, entry] of Object.entries(isPlainObject(raw.roles) ? raw.roles : {})) {
    if (!ROLE_NAME_PATTERN.test(name)) {
      problems.push({ path: `roles.${name.slice(0, 60)}`, rule: "pattern", message: "Role names are 1 to 40 lowercase letters, digits, or hyphens; entry ignored." });
      continue;
    }
    if (!isPlainObject(entry)) {
      problems.push({ path: `roles.${name}`, rule: "type", message: "A role entry must be an object; ignored." });
      continue;
    }
    /** @type {string | string[] | null} */
    let address = null;
    if (typeof entry.address === "string" && entry.address) {
      if (isAddress(entry.address)) address = entry.address;
      else problems.push({ path: `roles.${name}.address`, rule: "format", message: "address must be claude:<id> or codex:<id>; the role has no holder." });
    } else if (Array.isArray(entry.address)) {
      // Hand edits may list several holders; resolution reports them as ambiguous.
      const valid = [...new Set(entry.address.filter(isAddress))];
      if (valid.length !== entry.address.length) {
        problems.push({ path: `roles.${name}.address`, rule: "format", message: "Invalid or duplicate addresses in the list were ignored." });
      }
      address = valid.length === 0 ? null : valid.length === 1 ? valid[0] : valid;
    } else if (entry.address !== undefined && entry.address !== null) {
      problems.push({ path: `roles.${name}.address`, rule: "type", message: "address must be a string; the role has no holder." });
    }
    /** @type {Record<string, string>} */
    const projects = {};
    if (entry.projects !== undefined && entry.projects !== null) {
      if (name !== "orchestrator") {
        problems.push({ path: `roles.${name}.projects`, rule: "scope", message: "Only the orchestrator role is scoped by project root; projects ignored." });
      } else if (!isPlainObject(entry.projects)) {
        problems.push({ path: `roles.${name}.projects`, rule: "type", message: "projects must map absolute project roots to addresses; ignored." });
      } else {
        for (const [root, holder] of Object.entries(entry.projects)) {
          if (!path.isAbsolute(root) || !isAddress(holder)) {
            problems.push({ path: `roles.${name}.projects`, rule: "format", message: "projects keys are absolute project roots and values claude:<id> or codex:<id> addresses; invalid entries were ignored." });
            continue;
          }
          projects[path.resolve(root)] = holder;
        }
      }
    }
    table.roles[name] = { address, assignedAt: isoOrNull(entry.assignedAt), ...(Object.keys(projects).length ? { projects } : {}) };
  }
  if (raw.overridePolicy !== undefined && !isPlainObject(raw.overridePolicy)) {
    problems.push({ path: "overridePolicy", rule: "type", message: "overridePolicy must be an object; ignored (nothing is allowed)." });
  }
  for (const [target, entry] of Object.entries(isPlainObject(raw.overridePolicy) ? raw.overridePolicy : {})) {
    if (!isPolicyTarget(target)) {
      problems.push({ path: `overridePolicy.${target.slice(0, 80)}`, rule: "format", message: "Policy targets are role:<name> or a session address; entry ignored." });
      continue;
    }
    if (!isPlainObject(entry)) {
      problems.push({ path: `overridePolicy.${target}`, rule: "type", message: "A policy entry must be an object; ignored." });
      continue;
    }
    /** @type {PolicyEntry} */
    const clean = {};
    for (const [setting, senders] of Object.entries(entry)) {
      if (!POLICY_SETTINGS.includes(setting)) {
        problems.push({ path: `overridePolicy.${target}.${setting.slice(0, 40)}`, rule: "enum", message: `Policy settings are ${POLICY_SETTINGS.join(", ")}; ignored.` });
        continue;
      }
      if (!Array.isArray(senders)) {
        problems.push({ path: `overridePolicy.${target}.${setting}`, rule: "type", message: "A policy setting must list senders; ignored." });
        continue;
      }
      const valid = [...new Set(senders.filter(isPolicySender))].slice(0, MAX_POLICY_SENDERS);
      if (valid.length !== senders.length) {
        problems.push({ path: `overridePolicy.${target}.${setting}`, rule: "format", message: "Senders are \"*\", role:<name>, or a session address; invalid or duplicate entries were ignored." });
      }
      clean[/** @type {"model" | "effort" | "cwd"} */ (setting)] = valid;
    }
    table.overridePolicy[target] = clean;
  }
  return { table, problems };
}

/**
 * Sleeps synchronously (lock retries). Atomics.wait on a private buffer.
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {number} pid */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * Identity of a lock file as seen at one moment: content, inode, mtime.
 * @param {string} lockPath
 * @returns {{raw: string, ino: number, mtimeMs: number} | null}
 */
function lockSnapshot(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    return { raw: fs.readFileSync(lockPath, "utf8"), ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** @param {string} raw */
function ownerPid(raw) {
  try {
    return Number(JSON.parse(raw)?.pid);
  } catch {
    return NaN;
  }
}

/**
 * Removes a stale lock without ever removing a live one. Only the holder of
 * the O_EXCL breaker file `<lock>.break` may remove the lock, and only after
 * re-checking that the lock is still exactly the stale file it observed
 * (same content, inode, and mtime). Returns true when it removed the lock.
 * @param {string} lockPath
 * @param {{raw: string, ino: number, mtimeMs: number}} observed
 * @param {string} token
 * @param {() => number} now
 */
function breakStaleLock(lockPath, observed, token, now) {
  const breaker = `${lockPath}.break`;
  try {
    fs.writeFileSync(breaker, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: FILE_MODE });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") return false;
    // A breaker left by a process that died while breaking: clear it so the
    // next attempt can proceed. Breaking takes microseconds, so a breaker
    // this old whose owner is gone is abandoned.
    const stale = lockSnapshot(breaker);
    if (stale && now() - stale.mtimeMs > BREAKER_STALE_MS && !processAlive(ownerPid(stale.raw))) {
      fs.rmSync(breaker, { force: true });
    }
    return false;
  }
  try {
    const current = lockSnapshot(lockPath);
    if (!current || current.raw !== observed.raw || current.ino !== observed.ino || current.mtimeMs !== observed.mtimeMs) return false;
    fs.rmSync(lockPath, { force: true });
    return true;
  } finally {
    fs.rmSync(breaker, { force: true });
  }
}

/**
 * Runs `fn` while holding `<lockPath>` (created with O_EXCL). A lock older
 * than `staleMs` whose owner process is gone is stale and is taken over
 * through breakStaleLock. Waits at most `timeoutMs` (250 ms by default, so a
 * request never blocks the server for long), then fails with
 * state_io_error and a retry hint.
 * @template T
 * @param {string} lockPath
 * @param {() => T} fn
 * @param {{timeoutMs?: number, staleMs?: number, now?: () => number}} [options]
 * @returns {T}
 */
export function withFileLockSync(lockPath, fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS, now = () => Date.now() } = {}) {
  const deadline = now() + timeoutMs;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, at: new Date(now()).toISOString() }), { flag: "wx", mode: FILE_MODE });
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") {
        throw stateIoError(lockPath, error, "Could not create the role table lock.");
      }
    }
    const observed = lockSnapshot(lockPath);
    if (observed && now() - observed.mtimeMs > staleMs && !processAlive(ownerPid(observed.raw))) {
      if (breakStaleLock(lockPath, observed, token, now)) continue;
    }
    if (now() >= deadline) {
      throw new AgentLinkError("state_io_error", "The role table is busy (another Agent Link server holds its lock).", {
        details: { path: path.basename(lockPath), errno: "ETIMEDOUT" },
        hint: `Retry the call. If this persists, check that no Agent Link process is stuck, then remove ${path.basename(lockPath)} from the state directory.`
      });
    }
    sleepSync(LOCK_RETRY_MS);
  }
  try {
    return fn();
  } finally {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (current?.token === token) fs.rmSync(lockPath, { force: true });
    } catch {
      // Already gone.
    }
  }
}

/**
 * Writes `text` to `filePath` atomically: a temporary file in the same
 * directory (0600), fsync, rename over the target.
 * @param {string} filePath
 * @param {string} text
 */
export function writeFileAtomicSync(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(temp, "wx", FILE_MODE);
    try {
      fs.writeFileSync(fd, text, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, filePath);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw stateIoError(filePath, error, "Could not write the role table.");
  }
  tightenMode(filePath, FILE_MODE);
}

/**
 * @param {string} filePath
 * @param {unknown} error
 * @param {string} message
 */
function stateIoError(filePath, error, message) {
  const errno = /** @type {NodeJS.ErrnoException} */ (error)?.code ?? null;
  return new AgentLinkError("state_io_error", `${message} (${errno ?? "error"})`, {
    details: { path: path.basename(filePath), errno },
    cause: error
  });
}

/**
 * Reads a procedure file safely: a regular file only (no symlink, FIFO, or
 * device), opened without following links and without blocking, at most
 * MAX_PROCEDURE_BYTES. Null when there is no file; {error} when the file
 * cannot be used.
 * @param {string} dir   the procedures directory
 * @param {string} file
 * @returns {{text: string, sha256: string} | {error: string} | null}
 */
export function readProcedureFileSafe(dir, file) {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return { error: "the roles directory is not a directory" };
  } catch {
    return null;
  }
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return { error: "the procedure file is not a regular file (symlinks, FIFOs, and devices are refused)" };
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    return { error: `the procedure file could not be opened (${/** @type {NodeJS.ErrnoException} */ (error).code ?? "error"})` };
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { error: "the procedure file is not a regular file" };
    const buffer = Buffer.alloc(MAX_PROCEDURE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > MAX_PROCEDURE_BYTES) {
        return { error: `the procedure file is larger than ${MAX_PROCEDURE_BYTES} bytes (64 KiB)` };
      }
    }
    const text = buffer.subarray(0, length).toString("utf8");
    return { text, sha256: sha256(text) };
  } catch (error) {
    return { error: `the procedure file could not be read (${/** @type {NodeJS.ErrnoException} */ (error).code ?? "error"})` };
  } finally {
    fs.closeSync(fd);
  }
}

/** @param {string} text */
export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The role store for one state directory.
 * @param {{env?: Record<string, string | undefined>, homedir?: string, now?: () => number, lockTimeoutMs?: number}} [options]
 */
export function createRoleStore({ env = process.env, homedir, now = () => Date.now(), lockTimeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const pathOptions = { env, ...(homedir ? { homedir } : {}) };
  const tablePath = () => rolesPath(pathOptions);
  const proceduresDir = () => roleProceduresDir(pathOptions);
  const statePath = () => path.join(stateDir(pathOptions), STATE_FILE);
  const iso = () => new Date(now()).toISOString();
  const lockOptions = { now, timeoutMs: lockTimeoutMs };

  /** @param {string} name */
  function procedureFile(name) {
    return path.join(proceduresDir(), `${name}.md`);
  }

  /** @param {string} name */
  function readProcedure(name) {
    return readProcedureFileSafe(proceduresDir(), procedureFile(name));
  }

  /**
   * Reads and validates the table. Never writes.
   * @returns {TableRead}
   */
  function read() {
    const file = tablePath();
    const base = { path: file, exists: true, writable: false, raw: null };
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        return { ...base, table: emptyRoleTable(), problems: [], error: null, exists: false, writable: true };
      }
      return { ...base, table: emptyRoleTable(), problems: [], error: `roles.json could not be read (${/** @type {NodeJS.ErrnoException} */ (error).code ?? "error"}).` };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ...base, table: emptyRoleTable(), problems: [], error: "roles.json is not valid JSON; roles and the override policy are unavailable until it is fixed." };
    }
    const { table, problems } = validateRoleTable(parsed);
    const writable = isPlainObject(parsed) && parsed.version === ROLE_TABLE_VERSION;
    return { ...base, table, problems, error: null, writable, raw: isPlainObject(parsed) ? parsed : null };
  }

  /**
   * Throws state_io_error when the table exists but cannot be used.
   * @param {TableRead} result
   */
  function assertUsable(result) {
    if (result.error) {
      throw new AgentLinkError("state_io_error", result.error, {
        details: { path: "roles.json", errno: null },
        hint: "Fix or remove roles.json in the Agent Link state directory; agent_link_health shows its path."
      });
    }
  }

  /**
   * Runs `mutate(raw, table)` on the raw JSON under the lock and writes the
   * result atomically. Only the keys the mutation touches change; entries
   * Agent Link does not understand are kept. A file whose version is not 1
   * is refused (fail closed).
   * @template T
   * @param {(raw: Record<string, any>, table: RoleTable) => T} mutate
   * @returns {T}
   */
  function update(mutate) {
    ensureStateDir(pathOptions);
    return withFileLockSync(`${tablePath()}.lock`, () => {
      const current = read();
      assertUsable(current);
      if (!current.writable) {
        throw new AgentLinkError("state_io_error", "roles.json has an unsupported version; Agent Link will not rewrite it.", {
          details: { path: "roles.json", errno: null, version: current.raw?.version ?? null },
          hint: `Set "version": ${ROLE_TABLE_VERSION} in roles.json after checking its contents, or move the file aside.`
        });
      }
      const raw = current.raw ?? { version: ROLE_TABLE_VERSION };
      if (!isPlainObject(raw.roles)) raw.roles = {};
      if (!isPlainObject(raw.overridePolicy)) raw.overridePolicy = {};
      const result = mutate(raw, current.table);
      writeFileAtomicSync(tablePath(), `${JSON.stringify(raw, null, 2)}\n`);
      return result;
    }, lockOptions);
  }

  /**
   * Agent Link's bookkeeping (procedure versions, deliveries). Never fails:
   * a missing or unreadable file is empty.
   * @returns {RoleState}
   */
  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8"));
      if (isPlainObject(parsed)) {
        return {
          version: STATE_VERSION,
          procedures: isPlainObject(parsed.procedures) ? parsed.procedures : {},
          deliveries: isPlainObject(parsed.deliveries) ? parsed.deliveries : {}
        };
      }
    } catch {
      // Missing or unreadable: start over (at worst a procedure is shown again).
    }
    return { version: STATE_VERSION, procedures: {}, deliveries: {} };
  }

  /**
   * @template T
   * @param {(state: RoleState) => T} mutate
   * @returns {T}
   */
  function updateState(mutate) {
    ensureStateDir(pathOptions);
    return withFileLockSync(`${statePath()}.lock`, () => {
      const state = readState();
      const result = mutate(state);
      writeFileAtomicSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
      return result;
    }, lockOptions);
  }

  /**
   * @param {RoleState} state
   * @param {string} name
   * @returns {ProcedureRecord | null}
   */
  function procedureRecord(state, name) {
    const p = state.procedures[name];
    return isPlainObject(p) && Number.isInteger(p.version) && p.version >= 1 && typeof p.sha256 === "string"
      ? { version: p.version, sha256: p.sha256, updatedAt: isoOrNull(p.updatedAt) ?? new Date(0).toISOString() }
      : null;
  }

  /**
   * R1.20: gives a changed procedure file the next version. Called only on
   * send paths and by set_agent_role, never by read-only tools. Writes only
   * when the file's hash differs from the recorded one.
   * @param {string} name
   */
  function syncProcedure(name) {
    const file = readProcedure(name);
    if (!file || "error" in file) return;
    if (procedureRecord(readState(), name)?.sha256 === file.sha256) return;
    updateState((state) => {
      const again = readProcedure(name);
      if (!again || "error" in again) return;
      const record = procedureRecord(state, name);
      if (record?.sha256 === again.sha256) return;
      state.procedures[name] = { version: (record?.version ?? 0) + 1, sha256: again.sha256, updatedAt: iso() };
    });
  }

  /**
   * The procedure as it stands, without writing: the recorded version, and
   * whether the file has changed since (`pending`; the next send or
   * set_agent_role assigns the next version).
   * @param {string} name
   * @param {{includeText?: boolean, state?: RoleState}} [options]
   */
  function procedureView(name, { includeText = false, state = readState() } = {}) {
    const record = procedureRecord(state, name);
    const file = readProcedure(name);
    if (!record && !file) return null;
    const usable = file && !("error" in file) ? file : null;
    const present = Boolean(usable && record && usable.sha256 === record.sha256);
    return {
      name,
      version: record?.version ?? null,
      sha256: record?.sha256 ?? null,
      updatedAt: record?.updatedAt ?? null,
      present,
      pending: Boolean(usable && usable.sha256 !== record?.sha256),
      ...(file && "error" in file ? { problem: file.error } : {}),
      ...(includeText && present && usable ? { text: usable.text } : {})
    };
  }

  /**
   * The public view of one role. Never writes.
   * @param {string} name
   * @param {RoleRecord} role
   * @param {{includeProcedureText?: boolean, state?: RoleState}} [options]
   */
  function view(name, role, { includeProcedureText = false, state } = {}) {
    return {
      role: name,
      roleAddress: `role:${name}`,
      address: role.address,
      assignedAt: role.assignedAt,
      ...(role.projects ? { projects: { ...role.projects } } : {}),
      procedure: procedureView(name, { includeText: includeProcedureText, ...(state ? { state } : {}) })
    };
  }

  /** Every role, by name. Never writes. */
  function list() {
    const result = read();
    const state = readState();
    return {
      roles: Object.keys(result.table.roles).sort().map((name) => view(name, result.table.roles[name], { state })),
      problems: result.problems,
      error: result.error,
      path: result.path,
      exists: result.exists,
      table: result.table
    };
  }

  /**
   * One role, or null. Never writes.
   * @param {string} name
   * @param {{includeProcedureText?: boolean}} [options]
   */
  function get(name, options = {}) {
    const result = read();
    assertUsable(result);
    const role = result.table.roles[name];
    return role ? view(name, role, options) : null;
  }

  /**
   * Assigns a role (R1.18). `procedureText`, when given, replaces the
   * procedure file; a changed hash is the next version.
   * With `projectRoot` (absolute), assigns the holder for that project only
   * (`projects`, R1.21) and leaves the role's own holder as it is.
   * @param {{role: string, address: string, procedureText?: string | null, projectRoot?: string | null}} input
   */
  function set({ role: name, address, procedureText = null, projectRoot = null }) {
    if (!ROLE_NAME_PATTERN.test(name)) throw new TypeError(`invalid role name ${name}`);
    if (!isAddress(address)) throw new TypeError(`invalid holder address ${address}`);
    if (projectRoot !== null && !path.isAbsolute(projectRoot)) throw new TypeError(`projectRoot must be absolute: ${projectRoot}`);
    if (projectRoot !== null && name !== "orchestrator") throw new TypeError("only the orchestrator role is scoped by project root");
    const root = projectRoot === null ? null : path.resolve(projectRoot);
    let previous = null;
    update((raw, table) => {
      const entry = isPlainObject(raw.roles[name]) ? raw.roles[name] : {};
      if (root !== null) {
        previous = table.roles[name]?.projects?.[root] ?? null;
        entry.projects = isPlainObject(entry.projects) ? entry.projects : {};
        entry.projects[root] = address;
        raw.roles[name] = entry;
        return;
      }
      const before = table.roles[name]?.address ?? null;
      previous = typeof before === "string" ? before : null;
      if (entry.address !== address || !isoOrNull(entry.assignedAt)) entry.assignedAt = iso();
      entry.address = address;
      raw.roles[name] = entry;
    });
    if (typeof procedureText === "string") {
      fs.mkdirSync(proceduresDir(), { recursive: true, mode: DIR_MODE });
      tightenMode(proceduresDir(), DIR_MODE);
      const existing = fs.lstatSync(procedureFile(name), { throwIfNoEntry: false });
      if (existing && !existing.isFile()) {
        throw new AgentLinkError("state_io_error", `The procedure file for ${name} is not a regular file; Agent Link will not replace it.`, {
          details: { path: `roles/${name}.md`, errno: null }
        });
      }
      writeFileAtomicSync(procedureFile(name), procedureText);
    }
    syncProcedure(name);
    const result = read();
    return { previousAddress: previous, role: view(name, result.table.roles[name]) };
  }

  /**
   * Removes a role's holder. The procedure and its version stay, so a later
   * holder receives the same procedure. With `projectRoot`, removes only
   * that project's holder (R1.21).
   * @param {string} name
   * @param {{projectRoot?: string | null}} [options]
   */
  function clear(name, { projectRoot = null } = {}) {
    let previous = null;
    let existed = false;
    const root = projectRoot === null ? null : path.resolve(projectRoot);
    update((raw, table) => {
      if (!table.roles[name] || !isPlainObject(raw.roles[name])) return;
      existed = true;
      if (root !== null) {
        previous = table.roles[name].projects?.[root] ?? null;
        if (isPlainObject(raw.roles[name].projects)) {
          for (const key of Object.keys(raw.roles[name].projects)) {
            if (path.isAbsolute(key) && path.resolve(key) === root) delete raw.roles[name].projects[key];
          }
          if (Object.keys(raw.roles[name].projects).length === 0) delete raw.roles[name].projects;
        }
        return;
      }
      const before = table.roles[name].address;
      previous = typeof before === "string" ? before : null;
      delete raw.roles[name].address;
      delete raw.roles[name].assignedAt;
    });
    const result = read();
    const role = result.table.roles[name];
    return { existed, previousAddress: previous, role: role ? view(name, role) : null };
  }

  /**
   * Replaces the listed settings of one policy entry (R9.4). A setting given
   * as [] is cleared; omitted settings are unchanged. An entry left with no
   * senders is removed.
   * @param {string} target
   * @param {PolicyEntry} settings
   */
  function setPolicy(target, settings) {
    /** @type {PolicyEntry | null} */
    let entry = null;
    update((raw) => {
      const next = isPlainObject(raw.overridePolicy[target]) ? { ...raw.overridePolicy[target] } : {};
      for (const setting of POLICY_SETTINGS) {
        const senders = settings[/** @type {"model" | "effort" | "cwd"} */ (setting)];
        if (senders === undefined) continue;
        next[setting] = [...new Set(senders)];
      }
      const empty = Object.values(next).every((senders) => !Array.isArray(senders) || senders.length === 0);
      if (empty) delete raw.overridePolicy[target];
      else raw.overridePolicy[target] = next;
      entry = empty ? null : next;
    });
    return entry;
  }

  /**
   * Every role the address holds (persistent-agent test, R1.23). A table
   * that cannot be read holds no roles.
   * @param {string} address
   * @param {RoleTable} [table]
   * @returns {string[]}
   */
  function rolesOf(address, table = read().table) {
    return Object.entries(table.roles)
      .filter(([, role]) => role.address === address || (Array.isArray(role.address) && role.address.includes(address)) ||
        Object.values(role.projects ?? {}).includes(address))
      .map(([name]) => name)
      .sort();
  }

  /**
   * What `address` holds: roles it holds outright, and the project roots it
   * holds the orchestrator role for (R1.21).
   * @param {string} address
   * @param {RoleTable} [table]
   * @returns {{roles: string[], projectRoots: string[]}}
   */
  function holdings(address, table = read().table) {
    const roles = Object.entries(table.roles)
      .filter(([, role]) => role.address === address || (Array.isArray(role.address) && role.address.includes(address)))
      .map(([name]) => name)
      .sort();
    const projectRoots = Object.values(table.roles)
      .flatMap((role) => Object.entries(role.projects ?? {}).filter(([, holder]) => holder === address).map(([root]) => root))
      .sort();
    return { roles, projectRoots };
  }

  /**
   * Resolves `role:<name>` to its holder at send time (R1.19). No holder is
   * not_found with details.role; several (a hand edit) are ambiguous.
   * `sync: true` (send paths only) first gives a changed procedure file its
   * next version; read-only callers pass false and never write.
   * @param {string} roleAddress
   * @param {{includeProcedureText?: boolean, sync?: boolean}} [options]
   */
  function resolve(roleAddress, { includeProcedureText = true, sync = true } = {}) {
    const name = parseRoleAddress(roleAddress);
    if (!name) {
      throw new AgentLinkError("invalid_arguments", `${JSON.stringify(String(roleAddress).slice(0, 60))} is not a role address; use role:<name> with 1 to 40 lowercase letters, digits, or hyphens.`, {
        details: { errors: [{ path: "role", rule: "pattern", expected: "role:[a-z0-9-]{1,40}" }] }
      });
    }
    const result = read();
    assertUsable(result);
    const role = result.table.roles[name];
    if (!role || !role.address) {
      throw new AgentLinkError("not_found", `No session holds role ${name}.`, {
        details: { role: name, query: `role:${name}`, candidates: [] },
        hint: "Ask the user to assign it (set_agent_role), or call list_agent_roles."
      });
    }
    if (Array.isArray(role.address)) {
      throw new AgentLinkError("ambiguous", `Role ${name} lists ${role.address.length} holders in roles.json.`, {
        details: { role: name, query: `role:${name}`, candidates: role.address.map((address) => ({ address })) },
        hint: "A role has one holder. Ask the user to fix roles.json or reassign the role with set_agent_role."
      });
    }
    if (sync) syncProcedure(name);
    const procedure = procedureView(name, { includeText: includeProcedureText });
    return {
      role: name,
      via: `role:${name}`,
      address: role.address,
      procedure: procedure && procedure.present && procedure.version !== null && procedure.sha256 !== null
        ? { name, version: procedure.version, sha256: procedure.sha256, ...(procedure.text !== undefined ? { text: procedure.text } : {}) }
        : null,
      // Why a procedure file exists but is not delivered (symlink, FIFO,
      // over 64 KiB), so the send can say so.
      procedureProblem: procedure?.problem ?? null
    };
  }

  /**
   * Records that `address` received the procedure text with hash `sha256`
   * and reports whether it had not received that exact text before (R1.20).
   * Keyed by content, so a recreated role whose versions restart still
   * delivers new text, and unchanged text is never sent twice.
   * @param {{role: string, sha256: string, address: string}} input
   * @returns {boolean}
   */
  function claimProcedureDelivery({ role, sha256: hash, address }) {
    return updateState((state) => {
      const seen = isPlainObject(state.deliveries[role]) ? state.deliveries[role] : {};
      if (seen[address] === hash) return false;
      state.deliveries[role] = { ...seen, [address]: hash };
      return true;
    });
  }

  /**
   * Undoes a claim after a delivery failed, so the next send carries the text.
   * @param {{role: string, sha256: string, address: string}} input
   */
  function releaseProcedureDelivery({ role, sha256: hash, address }) {
    try {
      updateState((state) => {
        if (state.deliveries[role]?.[address] === hash) delete state.deliveries[role][address];
      });
    } catch {
      // Best effort.
    }
  }

  /**
   * The role enforcement mode (R1.25): AGENT_LINK_ROLE_ENFORCEMENT, then
   * roles.json `enforcement`, then the release default (off). A roles.json
   * that cannot be parsed contributes nothing, so enforcement falls back to
   * the default: it fails open, because enforcement keeps coordination
   * consistent and is not a security boundary (R1.27).
   * @param {TableRead} [tableRead]
   * @returns {{mode: string, source: string, ignored: {source: string, reason: string}[]}}
   */
  function enforcement(tableRead = read()) {
    /** @type {{source: string, reason: string}[]} */
    const ignored = [];
    const fromEnv = lookupEnv("AGENT_LINK_ROLE_ENFORCEMENT", env).value?.trim().toLowerCase();
    if (fromEnv) {
      if (ENFORCEMENT_MODES.includes(fromEnv)) return { mode: fromEnv, source: "AGENT_LINK_ROLE_ENFORCEMENT", ignored };
      ignored.push({ source: "AGENT_LINK_ROLE_ENFORCEMENT", reason: `not one of ${ENFORCEMENT_MODES.join(", ")}` });
    }
    if (tableRead.error) ignored.push({ source: "roles.json", reason: "unreadable; enforcement falls back to the default (fails open)" });
    if (tableRead.table.enforcement) return { mode: tableRead.table.enforcement, source: "roles.json", ignored };
    return { mode: DEFAULT_ENFORCEMENT, source: "default", ignored };
  }

  return {
    read,
    list,
    get,
    set,
    clear,
    setPolicy,
    rolesOf,
    holdings,
    resolve,
    claimProcedureDelivery,
    releaseProcedureDelivery,
    enforcement,
    paths: { table: tablePath, procedures: proceduresDir, procedureFile, state: statePath }
  };
}

/** @typedef {ReturnType<typeof createRoleStore>} RoleStore */

/**
 * The warning a send carries when the role's procedure file was refused.
 * @param {{role: string, procedureProblem?: string | null} | null} role
 * @returns {{code: string, message: string, details: {role: string, problem: string}} | null}
 */
export function procedureProblemWarning(role) {
  if (!role?.procedureProblem) return null;
  return {
    code: "role_procedure_unavailable",
    message: `The procedure for role ${role.role} was not sent: ${role.procedureProblem}. Ask the user to fix roles/${role.role}.md.`,
    details: { role: role.role, problem: role.procedureProblem }
  };
}
