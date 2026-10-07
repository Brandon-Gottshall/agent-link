// The role table (design doc R1.18, R1.20, R1.25; PR B9): validation on read,
// atomic 0600 writes under a lock (also across processes), procedure
// versioning by SHA-256, once-per-version procedure delivery, role
// resolution errors, and the enforcement-mode precedence. Every test uses a
// temp state directory; nothing touches the real ~/.agent-link.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createRoleStore,
  parseRoleAddress,
  requireRoleName,
  validateRoleTable,
  withFileLockSync
} from "../../src/registry/roles.js";
import { AgentLinkError } from "../../src/shared/errors.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CODEX_A = "codex:019d9000-0000-7000-8000-00000000000a";
const CODEX_B = "codex:019d9000-0000-7000-8000-00000000000b";
const CLAUDE_C = "claude:0b5e7c1a-3f2d-4a6e-9c8b-00000000000c";

function tempStore(extraEnv = {}, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-link-roles-"));
  const state = path.join(dir, "state");
  const env = { HOME: dir, AGENT_LINK_STATE_DIR: state, ...extraEnv };
  return { dir, state, env, store: createRoleStore({ env, homedir: dir, ...options }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** @param {() => unknown} fn @param {string} code */
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof AgentLinkError && error.errorCode === code);
}

test("role names and role addresses", () => {
  assert.equal(parseRoleAddress("role:router"), "router");
  assert.equal(parseRoleAddress(" role:build-2 "), "build-2");
  assert.equal(parseRoleAddress("role:Router"), null);
  assert.equal(parseRoleAddress(`role:${"a".repeat(41)}`), null);
  assert.equal(parseRoleAddress("codex:abc"), null);
  assert.equal(requireRoleName("role:router"), "router");
  throwsCode(() => requireRoleName("bad name"), "invalid_arguments");
});

test("an absent table is empty and enforcement defaults to off", () => {
  const { store, cleanup } = tempStore();
  try {
    const read = store.read();
    assert.equal(read.exists, false);
    assert.deepEqual(read.table.roles, {});
    assert.deepEqual(store.enforcement(), { mode: "off", source: "default", ignored: [] });
    assert.equal(store.get("router"), null);
    throwsCode(() => store.resolve("role:router"), "not_found");
  } finally {
    cleanup();
  }
});

test("validation drops invalid hand edits and reports them", () => {
  const { table, problems } = validateRoleTable({
    version: 1,
    enforcement: "loud",
    roles: {
      router: { address: CODEX_A, assignedAt: "2026-10-06T12:00:00Z" },
      "Bad Name": { address: CODEX_B },
      broken: { address: "not-an-address" },
      pair: { address: [CODEX_A, CODEX_B, "junk"] },
      odd: "string"
    },
    overridePolicy: {
      "role:router": { model: ["role:planner", "*", "bogus"], effort: [CODEX_B], colour: ["*"] },
      "not a target": { model: ["*"] },
      [CODEX_B]: "nope"
    }
  });
  assert.equal(table.enforcement, null);
  assert.deepEqual(Object.keys(table.roles).sort(), ["broken", "pair", "router"]);
  assert.equal(table.roles.router.address, CODEX_A);
  assert.equal(table.roles.router.assignedAt, "2026-10-06T12:00:00.000Z");
  assert.equal(table.roles.broken.address, null);
  assert.deepEqual(table.roles.pair.address, [CODEX_A, CODEX_B]);
  assert.deepEqual(table.overridePolicy, { "role:router": { model: ["role:planner", "*"], effort: [CODEX_B] } });
  const paths = problems.map((problem) => problem.path);
  for (const expected of ["enforcement", "roles.Bad Name", "roles.broken.address", "roles.pair.address", "roles.odd", "overridePolicy.role:router.model", "overridePolicy.role:router.colour", "overridePolicy.not a target", `overridePolicy.${CODEX_B}`]) {
    assert.ok(paths.includes(expected), `problem reported for ${expected}: ${paths.join(" | ")}`);
  }
});

test("set writes the table atomically with 0600/0700 modes and no leftovers", () => {
  const { store, state, cleanup } = tempStore();
  try {
    const result = store.set({ role: "router", address: CODEX_A, procedureText: "Route work.\n" });
    assert.equal(result.previousAddress, null);
    assert.equal(result.role.address, CODEX_A);
    assert.equal(result.role.procedure.version, 1);
    const file = path.join(state, "roles.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(state).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(state, "roles")).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(state, "roles", "router.md")).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(state, "role-state.json")).mode & 0o777, 0o600);
    assert.equal(readFileSync(path.join(state, "roles", "router.md"), "utf8"), "Route work.\n");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(stored.version, 1);
    assert.equal(stored.roles.router.address, CODEX_A);
    assert.equal(stored.roles.router.procedure, undefined, "procedure bookkeeping is not written into the user's roles.json");
    const bookkeeping = JSON.parse(readFileSync(path.join(state, "role-state.json"), "utf8"));
    assert.equal(bookkeeping.procedures.router.version, 1);
    assert.match(bookkeeping.procedures.router.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(readdirSync(state).filter((name) => name.endsWith(".tmp") || name.includes(".lock")), [], "no temp or lock files remain");
    // Reassigning moves the pointer and keeps the procedure version.
    const moved = store.set({ role: "router", address: CODEX_B });
    assert.equal(moved.previousAddress, CODEX_A);
    assert.equal(moved.role.procedure.version, 1);
    assert.deepEqual(store.rolesOf(CODEX_B), ["router"]);
    assert.deepEqual(store.rolesOf(CODEX_A), []);
  } finally {
    cleanup();
  }
});

test("I3: writes keep entries Agent Link does not understand, and refuse a file whose version is not 1", () => {
  const { store, state, cleanup } = tempStore();
  try {
    const file = path.join(state, "roles.json");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const handEdited = {
      version: 1,
      note: "kept",
      roles: { "Bad Name": { address: CODEX_A }, broken: { address: "nope", extra: 1 }, planner: { address: CLAUDE_C, comment: "mine" } },
      overridePolicy: { "not a target": { model: ["*"] }, "role:planner": { model: ["bogus", "*"], colour: ["*"] } }
    };
    writeFileSync(file, JSON.stringify(handEdited));
    store.set({ role: "router", address: CODEX_A });
    store.setPolicy("role:router", { effort: ["*"] });
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.note, "kept");
    assert.deepEqual(after.roles["Bad Name"], { address: CODEX_A });
    assert.deepEqual(after.roles.broken, { address: "nope", extra: 1 });
    assert.deepEqual(after.roles.planner, { address: CLAUDE_C, comment: "mine" });
    assert.deepEqual(after.overridePolicy["not a target"], { model: ["*"] });
    assert.deepEqual(after.overridePolicy["role:planner"], { model: ["bogus", "*"], colour: ["*"] });
    assert.deepEqual(after.overridePolicy["role:router"], { effort: ["*"] });
    assert.equal(after.roles.router.address, CODEX_A);

    // A file with another (or no) version is read, never written.
    for (const version of [2, undefined]) {
      const text = JSON.stringify({ ...(version === undefined ? {} : { version }), roles: { router: { address: CODEX_A } }, future: true });
      writeFileSync(file, text);
      assert.equal(store.read().table.roles.router.address, CODEX_A);
      assert.ok(store.read().problems.some((problem) => problem.path === "version"));
      assert.throws(() => store.set({ role: "router", address: CODEX_B }), (error) => error.errorCode === "state_io_error");
      assert.throws(() => store.setPolicy(CODEX_A, { model: ["*"] }), (error) => error.errorCode === "state_io_error");
      assert.throws(() => store.clear("router"), (error) => error.errorCode === "state_io_error");
      assert.equal(readFileSync(file, "utf8"), text, `version ${version}: untouched`);
    }
  } finally {
    cleanup();
  }
});

test("I3: read-only calls never write, even when a procedure file changed", () => {
  const { store, state, cleanup } = tempStore();
  try {
    store.set({ role: "router", address: CODEX_A, procedureText: "v1 text" });
    writeFileSync(path.join(state, "roles", "router.md"), "v2 text, edited by hand");
    const files = ["roles.json", "role-state.json"].map((name) => path.join(state, name));
    const before = files.map((file) => [readFileSync(file, "utf8"), statSync(file).mtimeMs]);
    const listed = store.list().roles[0].procedure;
    assert.deepEqual([listed.version, listed.present, listed.pending], [1, false, true]);
    assert.equal(store.get("router").procedure.pending, true);
    store.resolve("role:router", { sync: false });
    store.enforcement();
    store.read();
    assert.deepEqual(files.map((file) => [readFileSync(file, "utf8"), statSync(file).mtimeMs]), before, "nothing was written");
  } finally {
    cleanup();
  }
});

test("T-1.9: procedure versions follow the file's SHA-256, once per change, on send paths", () => {
  const { store, state, cleanup } = tempStore();
  try {
    store.set({ role: "router", address: CODEX_A, procedureText: "v1 text" });
    assert.equal(store.get("router").procedure.version, 1);
    // The same text is not a new version.
    store.set({ role: "router", address: CODEX_A, procedureText: "v1 text" });
    assert.equal(store.get("router").procedure.version, 1);
    // A hand edit gets its version from the next send (resolve with sync), exactly once.
    writeFileSync(path.join(state, "roles", "router.md"), "v2 text, edited by hand");
    const resolved = store.resolve("role:router");
    assert.deepEqual([resolved.address, resolved.via, resolved.procedure.version, resolved.procedure.text], [CODEX_A, "role:router", 2, "v2 text, edited by hand"]);
    assert.equal(store.resolve("role:router").procedure.version, 2);
    assert.equal(store.get("router").procedure.version, 2);
    // A missing file means no procedure is delivered; the record is kept.
    rmSync(path.join(state, "roles", "router.md"));
    assert.equal(store.get("router").procedure.present, false);
    assert.equal(store.resolve("role:router").procedure, null);
  } finally {
    cleanup();
  }
});

test("S2: procedure files must be regular files of at most 64 KiB", () => {
  const { store, state, dir, cleanup } = tempStore();
  try {
    store.set({ role: "router", address: CODEX_A, procedureText: "ok" });
    const file = path.join(state, "roles", "router.md");
    // A symlink (even to a readable file) is refused.
    const target = path.join(dir, "secret.txt");
    writeFileSync(target, "outside text");
    rmSync(file);
    symlinkSync(target, file);
    let view = store.get("router", { includeProcedureText: true }).procedure;
    assert.match(view.problem, /not a regular file/);
    assert.equal(view.text, undefined);
    assert.equal(store.resolve("role:router").procedure, null);
    // A FIFO is refused without blocking.
    rmSync(file);
    execFileSync("mkfifo", [file]);
    view = store.get("router").procedure;
    assert.match(view.problem, /not a regular file/);
    assert.equal(store.resolve("role:router").procedure, null);
    // Over 64 KiB is refused.
    rmSync(file);
    writeFileSync(file, "x".repeat(64 * 1024 + 1));
    assert.match(store.get("router").procedure.problem, /larger than/);
    assert.equal(store.resolve("role:router").procedure, null);
    // Exactly 64 KiB is fine.
    writeFileSync(file, "y".repeat(64 * 1024));
    assert.equal(store.resolve("role:router").procedure.text.length, 64 * 1024);
    // set_agent_role will not replace a non-regular file.
    rmSync(file);
    symlinkSync(target, file);
    assert.throws(() => store.set({ role: "router", address: CODEX_A, procedureText: "new" }), (error) => error.errorCode === "state_io_error");
    assert.equal(readFileSync(target, "utf8"), "outside text", "the link target is untouched");
  } finally {
    cleanup();
  }
});

test("I4: procedure text is delivered once per distinct text per recipient, also after a role is recreated", () => {
  const { store, state, cleanup } = tempStore();
  try {
    const claim = (hash, address) => store.claimProcedureDelivery({ role: "router", sha256: hash, address });
    assert.equal(claim("a".repeat(64), CODEX_A), true, "first delivery");
    assert.equal(claim("a".repeat(64), CODEX_A), false, "same text again");
    assert.equal(claim("a".repeat(64), CODEX_B), true, "another holder gets it once");
    assert.equal(claim("b".repeat(64), CODEX_A), true, "new text");
    store.releaseProcedureDelivery({ role: "router", sha256: "b".repeat(64), address: CODEX_A });
    assert.equal(claim("b".repeat(64), CODEX_A), true, "a released claim (failed send) is claimed again");

    // Recreate: the role and its version records are removed by hand and the
    // role comes back with new text at version 1 again. The holder still gets it.
    store.set({ role: "planner", address: CODEX_A, procedureText: "first life" });
    let resolved = store.resolve("role:planner");
    assert.equal(store.claimProcedureDelivery({ role: "planner", sha256: resolved.procedure.sha256, address: CODEX_A }), true);
    const bookkeeping = JSON.parse(readFileSync(path.join(state, "role-state.json"), "utf8"));
    delete bookkeeping.procedures.planner;
    writeFileSync(path.join(state, "role-state.json"), JSON.stringify(bookkeeping));
    store.clear("planner");
    store.set({ role: "planner", address: CODEX_A, procedureText: "second life" });
    resolved = store.resolve("role:planner");
    assert.equal(resolved.procedure.version, 1, "versions restarted");
    assert.equal(store.claimProcedureDelivery({ role: "planner", sha256: resolved.procedure.sha256, address: CODEX_A }), true, "new text is delivered despite the same version number");
  } finally {
    cleanup();
  }
});

test("clear keeps the procedure; resolve reports not_found, ambiguous, and invalid names", () => {
  const { store, state, cleanup } = tempStore();
  try {
    store.set({ role: "router", address: CODEX_A, procedureText: "p" });
    const cleared = store.clear("router");
    assert.deepEqual([cleared.existed, cleared.previousAddress, cleared.role.address, cleared.role.procedure.version], [true, CODEX_A, null, 1]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(state, "roles.json"), "utf8")).roles.router, {}, "the entry stays, without a holder");
    assert.equal(store.clear("never").existed, false);
    assert.throws(() => store.resolve("role:router"), (error) => error.errorCode === "not_found" && error.details.role === "router");
    throwsCode(() => store.resolve("role:Not_Valid"), "invalid_arguments");
    // A hand edit with two holders is ambiguous, never silently picked.
    writeFileSync(path.join(state, "roles.json"), JSON.stringify({ version: 1, roles: { pair: { address: [CODEX_A, CLAUDE_C] } } }));
    assert.throws(() => store.resolve("role:pair"), (error) => error.errorCode === "ambiguous" && error.details.candidates.length === 2);
    // Invalid JSON: lookups fail with state_io_error, the policy reads as empty, writes refuse.
    writeFileSync(path.join(state, "roles.json"), "{ not json");
    throwsCode(() => store.resolve("role:pair"), "state_io_error");
    assert.match(store.read().error, /not valid JSON/);
    assert.deepEqual(store.read().table.overridePolicy, {});
    throwsCode(() => store.set({ role: "x", address: CODEX_A }), "state_io_error");
    assert.equal(readFileSync(path.join(state, "roles.json"), "utf8"), "{ not json", "a broken table is never overwritten");
  } finally {
    cleanup();
  }
});

test("override policy entries: replace per setting, [] clears, empty entries are removed", () => {
  const { store, cleanup } = tempStore();
  try {
    assert.deepEqual(store.setPolicy("role:builder", { model: ["role:router"], effort: ["*"] }), { model: ["role:router"], effort: ["*"] });
    assert.deepEqual(store.setPolicy("role:builder", { effort: [] }), { model: ["role:router"], effort: [] });
    assert.equal(store.setPolicy("role:builder", { model: [] }), null);
    assert.deepEqual(store.read().table.overridePolicy, {});
  } finally {
    cleanup();
  }
});

test("T-1.11: AGENT_LINK_ROLE_ENFORCEMENT overrides roles.json, which overrides the default", () => {
  const { store, state, env, dir, cleanup } = tempStore();
  try {
    store.set({ role: "router", address: CODEX_A });
    const table = JSON.parse(readFileSync(path.join(state, "roles.json"), "utf8"));
    writeFileSync(path.join(state, "roles.json"), JSON.stringify({ ...table, enforcement: "warn" }));
    assert.deepEqual(store.enforcement(), { mode: "warn", source: "roles.json", ignored: [] });
    const withEnv = createRoleStore({ env: { ...env, AGENT_LINK_ROLE_ENFORCEMENT: "enforce" }, homedir: dir });
    assert.deepEqual(withEnv.enforcement(), { mode: "enforce", source: "AGENT_LINK_ROLE_ENFORCEMENT", ignored: [] });
    const badEnv = createRoleStore({ env: { ...env, AGENT_LINK_ROLE_ENFORCEMENT: "loud" }, homedir: dir });
    const bad = badEnv.enforcement();
    assert.equal(bad.mode, "warn");
    assert.equal(bad.source, "roles.json");
    assert.equal(bad.ignored[0].source, "AGENT_LINK_ROLE_ENFORCEMENT");
    // set preserves the hand-set enforcement field.
    store.set({ role: "planner", address: CODEX_B });
    assert.equal(JSON.parse(readFileSync(path.join(state, "roles.json"), "utf8")).enforcement, "warn");
  } finally {
    cleanup();
  }
});

test("the lock times out on a live holder and takes over a stale one", () => {
  const { dir, cleanup } = tempStore();
  try {
    const lock = path.join(dir, "x.lock");
    // Held by a live process (this one): times out with state_io_error.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "other" }));
    assert.throws(() => withFileLockSync(lock, () => "never", { timeoutMs: 100 }), (error) => error.errorCode === "state_io_error" && error.details.errno === "ETIMEDOUT");
    assert.ok(existsSync(lock), "a live holder's lock is left alone");
    // Old and its owner is gone: stale, taken over, released afterwards.
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, token: "dead" }));
    const old = Date.now() / 1000 - 120;
    utimesSync(lock, old, old);
    assert.equal(withFileLockSync(lock, () => "ran", { timeoutMs: 1000 }), "ran");
    assert.equal(existsSync(lock), false, "the lock is released");
  } finally {
    cleanup();
  }
});

test("concurrent writers in separate processes never lose an update", async () => {
  const { state, dir, cleanup } = tempStore();
  try {
    const script = `
      import { createRoleStore } from ${JSON.stringify(path.join(root, "src", "registry", "roles.js"))};
      const store = createRoleStore({ env: { HOME: ${JSON.stringify(dir)}, AGENT_LINK_STATE_DIR: ${JSON.stringify(state)} }, homedir: ${JSON.stringify(dir)}, lockTimeoutMs: 30000 });
      const worker = Number(process.argv[1]);
      for (let i = 0; i < 10; i++) {
        store.set({ role: \`w\${worker}-\${i}\`, address: "codex:019d9000-0000-7000-8000-0000000000" + String(worker).padStart(2, "0") });
        store.setPolicy("role:shared", { effort: ["role:w" + worker + "-" + i] });
      }
    `;
    const workers = 6;
    await Promise.all(Array.from({ length: workers }, (_, worker) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, String(worker)], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("exit", (code) => (code === 0 ? resolve(undefined) : reject(new Error(`worker ${worker} exited ${code}: ${stderr}`))));
    })));
    const table = JSON.parse(readFileSync(path.join(state, "roles.json"), "utf8"));
    assert.equal(Object.keys(table.roles).length, workers * 10, "every role written by every process is present");
    assert.equal(table.overridePolicy["role:shared"].effort.length, 1);
    assert.deepEqual(readdirSync(state).filter((name) => name.endsWith(".tmp") || name.includes(".lock")), []);
  } finally {
    cleanup();
  }
});
