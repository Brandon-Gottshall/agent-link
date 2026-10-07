// src/registry/roles.js
//
// User-assigned roles (design doc section 1.8, PR B9). The role table lives
// in `<state>/roles.json` (0600) and each role's procedure text in
// `<state>/roles/<name>.md`:
//
//   { "version": 1,
//     "enforcement": "off" | "warn" | "enforce",          (optional, R1.25)
//     "roles": { "<name>": { "address": "codex:<id>", "assignedAt": "<iso>",
//                            "procedure": {"version", "sha256", "updatedAt"} } },
//     "overridePolicy": { "<target>": {"model": [...], "effort": [...], "cwd": [...]} } }
//
// A role is a pointer, not a privilege (R1.22): it names the session that
// receives `role:<name>` messages and carries one procedure the user tunes in
// one place. The only permission in the table is target-side, the override
// policy (R9.4).
//
// Writes take a lock file beside the table and replace the table atomically
// (temporary file, fsync, rename), so concurrent servers never interleave or
// leave a half-written table. Hand edits are supported: the table is
// validated on every read, invalid entries are dropped and reported, and a
// procedure file whose SHA-256 changed gets a new version on the next read
// that syncs (R1.20). A table that cannot be parsed is reported, never
// guessed at: role lookups fail with state_io_error and the override policy
// is read as empty (nothing allowed).

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
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;
const DELIVERIES_FILE = "role-procedure-deliveries.json";

/**
 * @typedef {{version: number, sha256: string, updatedAt: string}} ProcedureRecord
 * @typedef {{address: string | string[] | null, assignedAt: string | null, procedure: ProcedureRecord | null}} RoleRecord
 * @typedef {{model?: string[], effort?: string[], cwd?: string[]}} PolicyEntry
 * @typedef {{
 *   version: number,
 *   enforcement: string | null,
 *   roles: Record<string, RoleRecord>,
 *   overridePolicy: Record<string, PolicyEntry>
 * }} RoleTable
 * @typedef {{path: string, rule: string, message: string}} TableProblem
 * @typedef {{table: RoleTable, problems: TableProblem[], error: string | null, path: string, exists: boolean}} TableRead
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
  if (raw.version !== undefined && raw.version !== ROLE_TABLE_VERSION) {
    problems.push({ path: "version", rule: "version", message: `Unsupported roles.json version ${JSON.stringify(raw.version)}; expected ${ROLE_TABLE_VERSION}. Entries were read as version ${ROLE_TABLE_VERSION}.` });
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
    /** @type {ProcedureRecord | null} */
    let procedure = null;
    if (isPlainObject(entry.procedure)) {
      const p = entry.procedure;
      if (Number.isInteger(p.version) && p.version >= 1 && typeof p.sha256 === "string" && /^[0-9a-f]{64}$/.test(p.sha256)) {
        procedure = { version: p.version, sha256: p.sha256, updatedAt: isoOrNull(p.updatedAt) ?? new Date(0).toISOString() };
      } else {
        problems.push({ path: `roles.${name}.procedure`, rule: "format", message: "procedure must be {version >= 1, sha256, updatedAt}; it is rebuilt from the procedure file." });
      }
    }
    table.roles[name] = { address, assignedAt: isoOrNull(entry.assignedAt), procedure };
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
 * Runs `fn` while holding `<lockPath>` (created with O_EXCL). A lock older
 * than 30 s whose owner process is gone is stale and is taken over. Waits up
 * to 5 s, then fails with state_io_error.
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
    try {
      const stat = fs.statSync(lockPath);
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        owner = null;
      }
      if (now() - stat.mtimeMs > staleMs && !processAlive(Number(owner?.pid))) {
        // Move the stale lock aside first: only one contender's rename succeeds.
        const aside = `${lockPath}.stale-${token.replace(/[^A-Za-z0-9-]/g, "")}`;
        fs.renameSync(lockPath, aside);
        fs.rmSync(aside, { force: true });
        continue;
      }
    } catch {
      // The lock disappeared or was taken over meanwhile: retry.
    }
    if (now() >= deadline) {
      throw new AgentLinkError("state_io_error", "Timed out waiting for the role table lock.", {
        details: { path: path.basename(lockPath), errno: "ETIMEDOUT" },
        hint: `Another Agent Link server is writing the role table. Retry; if this persists, remove ${path.basename(lockPath)} from the state directory.`
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
 * Procedure text as delivered: a hand-edited file over the cap is cut, with a note.
 * @param {string} text
 */
export function capProcedureText(text) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_PROCEDURE_BYTES) return text;
  const cut = new TextDecoder("utf-8").decode(Buffer.from(text, "utf8").subarray(0, MAX_PROCEDURE_BYTES)).replace(/\uFFFD+$/, "");
  return `${cut}\n[Agent Link: procedure truncated; the file is ${bytes} bytes and the limit is ${MAX_PROCEDURE_BYTES}.]`;
}

/** @param {string} text */
export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The role store for one state directory.
 * @param {{env?: Record<string, string | undefined>, homedir?: string, now?: () => number}} [options]
 */
export function createRoleStore({ env = process.env, homedir, now = () => Date.now() } = {}) {
  const pathOptions = { env, ...(homedir ? { homedir } : {}) };
  const tablePath = () => rolesPath(pathOptions);
  const proceduresDir = () => roleProceduresDir(pathOptions);
  const deliveriesPath = () => path.join(stateDir(pathOptions), DELIVERIES_FILE);
  const lockPath = () => `${tablePath()}.lock`;
  const iso = () => new Date(now()).toISOString();

  /** @param {string} name */
  function procedureFile(name) {
    return path.join(proceduresDir(), `${name}.md`);
  }

  /**
   * Reads and validates the table without writing anything.
   * @returns {TableRead}
   */
  function read() {
    const file = tablePath();
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        return { table: emptyRoleTable(), problems: [], error: null, path: file, exists: false };
      }
      return { table: emptyRoleTable(), problems: [], error: `roles.json could not be read (${/** @type {NodeJS.ErrnoException} */ (error).code ?? "error"}).`, path: file, exists: true };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { table: emptyRoleTable(), problems: [], error: "roles.json is not valid JSON; roles and the override policy are unavailable until it is fixed.", path: file, exists: true };
    }
    const { table, problems } = validateRoleTable(parsed);
    return { table, problems, error: null, path: file, exists: true };
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
   * Runs `mutate(table)` under the lock and writes the result atomically.
   * @template T
   * @param {(table: RoleTable) => T} mutate
   * @returns {T}
   */
  function update(mutate) {
    ensureStateDir(pathOptions);
    return withFileLockSync(lockPath(), () => {
      const current = read();
      assertUsable(current);
      const result = mutate(current.table);
      writeFileAtomicSync(tablePath(), `${JSON.stringify(serialize(current.table), null, 2)}\n`);
      return result;
    }, { now });
  }

  /** @param {RoleTable} table */
  function serialize(table) {
    /** @type {Record<string, any>} */
    const out = { version: ROLE_TABLE_VERSION };
    if (table.enforcement) out.enforcement = table.enforcement;
    out.roles = {};
    for (const name of Object.keys(table.roles).sort()) {
      const role = table.roles[name];
      out.roles[name] = {
        ...(role.address ? { address: role.address } : {}),
        ...(role.assignedAt ? { assignedAt: role.assignedAt } : {}),
        ...(role.procedure ? { procedure: role.procedure } : {})
      };
    }
    out.overridePolicy = {};
    for (const target of Object.keys(table.overridePolicy).sort()) out.overridePolicy[target] = table.overridePolicy[target];
    return out;
  }

  /**
   * The procedure file's text and hash, or null when there is none.
   * @param {string} name
   * @returns {{text: string, sha256: string} | null}
   */
  function readProcedureFile(name) {
    try {
      const text = fs.readFileSync(procedureFile(name), "utf8");
      return { text, sha256: sha256(text) };
    } catch {
      return null;
    }
  }

  /**
   * True when a procedure file exists whose hash differs from the record.
   * @param {RoleTable} table
   * @param {string} name
   */
  function procedureStale(table, name) {
    const file = readProcedureFile(name);
    const record = table.roles[name]?.procedure ?? null;
    return file !== null && file.sha256 !== record?.sha256;
  }

  /**
   * R1.20: a procedure file whose SHA-256 differs from the record gets the
   * next version. Runs under the lock only when something changed, so a
   * hand edit bumps the version exactly once.
   * @param {string[]} names
   * @returns {TableRead}
   */
  function sync(names) {
    const first = read();
    if (first.error) return first;
    const stale = names.filter((name) => first.table.roles[name] && procedureStale(first.table, name));
    if (stale.length === 0) return first;
    update((table) => {
      for (const name of stale) {
        const role = table.roles[name];
        const file = readProcedureFile(name);
        if (!role || !file || file.sha256 === role.procedure?.sha256) continue;
        role.procedure = { version: (role.procedure?.version ?? 0) + 1, sha256: file.sha256, updatedAt: iso() };
      }
    });
    return read();
  }

  /**
   * The public view of one role.
   * @param {string} name
   * @param {RoleRecord} role
   * @param {{includeProcedureText?: boolean}} [options]
   */
  function view(name, role, { includeProcedureText = false } = {}) {
    const file = role.procedure ? readProcedureFile(name) : null;
    const present = file !== null && file.sha256 === role.procedure?.sha256;
    return {
      role: name,
      roleAddress: `role:${name}`,
      address: role.address,
      assignedAt: role.assignedAt,
      procedure: role.procedure
        ? {
            name,
            version: role.procedure.version,
            sha256: role.procedure.sha256,
            updatedAt: role.procedure.updatedAt,
            present,
            ...(includeProcedureText && present && file ? { text: capProcedureText(file.text) } : {})
          }
        : null
    };
  }

  /**
   * @param {{sync?: boolean}} [options]
   */
  function list({ sync: doSync = true } = {}) {
    const first = read();
    const result = doSync && !first.error ? sync(Object.keys(first.table.roles)) : first;
    return {
      roles: Object.keys(result.table.roles).sort().map((name) => view(name, result.table.roles[name])),
      problems: result.problems,
      error: result.error,
      path: result.path,
      exists: result.exists,
      table: result.table
    };
  }

  /**
   * One role, or null.
   * @param {string} name
   * @param {{includeProcedureText?: boolean}} [options]
   */
  function get(name, options = {}) {
    const result = sync([name]);
    assertUsable(result);
    const role = result.table.roles[name];
    return role ? view(name, role, options) : null;
  }

  /**
   * Assigns a role (R1.18). `procedureText`, when given, replaces the
   * procedure file; a changed hash increments the version.
   * @param {{role: string, address: string, procedureText?: string | null}} input
   */
  function set({ role: name, address, procedureText = null }) {
    if (!ROLE_NAME_PATTERN.test(name)) throw new TypeError(`invalid role name ${name}`);
    if (!isAddress(address)) throw new TypeError(`invalid holder address ${address}`);
    let previous = null;
    update((table) => {
      previous = table.roles[name]?.address ?? null;
      const role = table.roles[name] ?? { address: null, assignedAt: null, procedure: null };
      if (role.address !== address) role.assignedAt = iso();
      role.address = address;
      role.assignedAt ??= iso();
      if (typeof procedureText === "string") {
        const hash = sha256(procedureText);
        fs.mkdirSync(proceduresDir(), { recursive: true, mode: DIR_MODE });
        tightenMode(proceduresDir(), DIR_MODE);
        writeFileAtomicSync(procedureFile(name), procedureText);
        if (hash !== role.procedure?.sha256) {
          role.procedure = { version: (role.procedure?.version ?? 0) + 1, sha256: hash, updatedAt: iso() };
        }
      }
      table.roles[name] = role;
    });
    const result = sync([name]);
    return { previousAddress: previous, role: view(name, result.table.roles[name]) };
  }

  /**
   * Removes a role's holder. The procedure and its version stay, so a later
   * holder receives the same procedure.
   * @param {string} name
   */
  function clear(name) {
    let previous = null;
    let existed = false;
    update((table) => {
      const role = table.roles[name];
      if (!role) return;
      existed = true;
      previous = role.address;
      role.address = null;
      role.assignedAt = null;
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
    update((table) => {
      const next = { ...(table.overridePolicy[target] ?? {}) };
      for (const setting of POLICY_SETTINGS) {
        const senders = settings[/** @type {"model" | "effort" | "cwd"} */ (setting)];
        if (senders === undefined) continue;
        next[/** @type {"model" | "effort" | "cwd"} */ (setting)] = [...new Set(senders)];
      }
      const empty = POLICY_SETTINGS.every((setting) => !(next[/** @type {"model" | "effort" | "cwd"} */ (setting)]?.length));
      if (empty) delete table.overridePolicy[target];
      else table.overridePolicy[target] = next;
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
      .filter(([, role]) => role.address === address || (Array.isArray(role.address) && role.address.includes(address)))
      .map(([name]) => name)
      .sort();
  }

  /**
   * Resolves `role:<name>` to its holder at send time (R1.19). No holder is
   * not_found with details.role; several (a hand edit) are ambiguous.
   * @param {string} roleAddress
   * @param {{includeProcedureText?: boolean}} [options]
   */
  function resolve(roleAddress, { includeProcedureText = true } = {}) {
    const name = parseRoleAddress(roleAddress);
    if (!name) {
      throw new AgentLinkError("invalid_arguments", `${JSON.stringify(String(roleAddress).slice(0, 60))} is not a role address; use role:<name> with 1 to 40 lowercase letters, digits, or hyphens.`, {
        details: { errors: [{ path: "role", rule: "pattern", expected: "role:[a-z0-9-]{1,40}" }] }
      });
    }
    const result = sync([name]);
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
    const v = view(name, role, { includeProcedureText });
    return {
      role: name,
      via: `role:${name}`,
      address: role.address,
      procedure: v.procedure && v.procedure.present ? v.procedure : null
    };
  }

  /**
   * Records that `address` received procedure `role@version` and reports
   * whether this is the first delivery of that version to it (R1.20). The
   * caller includes the procedure text only then.
   * @param {{role: string, version: number, address: string}} input
   * @returns {boolean}
   */
  function claimProcedureDelivery({ role, version, address }) {
    ensureStateDir(pathOptions);
    return withFileLockSync(lockPath(), () => {
      const file = deliveriesPath();
      /** @type {{version: number, deliveries: Record<string, Record<string, number>>}} */
      let data = { version: 1, deliveries: {} };
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (isPlainObject(parsed) && isPlainObject(parsed.deliveries)) data = { version: 1, deliveries: parsed.deliveries };
      } catch {
        // Missing or unreadable: start over (at worst a procedure is shown again).
      }
      const seen = Number(data.deliveries[role]?.[address] ?? 0);
      if (Number.isFinite(seen) && seen >= version) return false;
      data.deliveries[role] = { ...(isPlainObject(data.deliveries[role]) ? data.deliveries[role] : {}), [address]: version };
      writeFileAtomicSync(file, `${JSON.stringify(data, null, 2)}\n`);
      return true;
    }, { now });
  }

  /**
   * Undoes a claim after a delivery failed, so the next send carries the text.
   * @param {{role: string, version: number, address: string}} input
   */
  function releaseProcedureDelivery({ role, version, address }) {
    try {
      withFileLockSync(lockPath(), () => {
        const file = deliveriesPath();
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (data?.deliveries?.[role]?.[address] === version) {
          delete data.deliveries[role][address];
          writeFileAtomicSync(file, `${JSON.stringify(data, null, 2)}\n`);
        }
      }, { now });
    } catch {
      // Best effort.
    }
  }

  /**
   * The role enforcement mode (R1.25): AGENT_LINK_ROLE_ENFORCEMENT, then
   * roles.json `enforcement`, then the release default (off).
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
    resolve,
    claimProcedureDelivery,
    releaseProcedureDelivery,
    enforcement,
    paths: { table: tablePath, procedures: proceduresDir, procedureFile }
  };
}

/** @typedef {ReturnType<typeof createRoleStore>} RoleStore */
