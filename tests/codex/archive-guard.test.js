// archive_codex_thread's local fallback never moves a transcript that another
// live writer holds, and never moves one Codex's state database tracks.
//
// The incident (2026-10-12): a Codex thread was running in another
// app-server (computer-use-via-codex's). Agent Link's own app-server reported
// it not loaded and failed thread/archive, so archive_codex_thread fell back
// to moving the rollout JSONL into archived_sessions mid-turn. Codex's state
// database (state_5.sqlite) kept archived=0 and the old rollout_path, and
// every app-server then failed thread/read with "missing source rollout".
//
// Uses a temp CODEX_HOME, a real child process holding the transcript open,
// and the real lsof check (src/codex/rollout-holders.js).
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerError } from "../../src/codex/app-server-client.js";
import { makeRolloutCheck } from "../../src/codex/rollout-holders.js";
import { archiveLocalThread } from "../../src/codex/session-index.js";
import { makeThreadActions } from "../../src/codex/thread-actions.js";

const T = "01a12eda-b557-7542-9a56-6683ee2485ca";
// A process group no test process is in: Agent Link's own managed app-server.
const OWN_APP_SERVER_PID = 2_000_000_000;

/** A temp CODEX_HOME with one running thread's transcript in sessions/. */
function codexHomeWithRunningThread() {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "al-archive-guard-"));
  const day = path.join(codexHome, "sessions", "2026", "10", "12");
  mkdirSync(day, { recursive: true });
  const transcript = path.join(day, `rollout-2026-10-12T02-44-07-${T}.jsonl`);
  writeFileSync(transcript, [
    { timestamp: "2026-10-12T02:44:07.000Z", type: "session_meta", payload: { id: T, timestamp: "2026-10-12T02:44:07.000Z", cwd: "/tmp/project", source: "test" } },
    { timestamp: "2026-10-12T02:44:08.000Z", type: "event_msg", payload: { type: "user_message", message: "executor task" } },
    { timestamp: "2026-10-12T02:44:09.000Z", type: "event_msg", payload: { type: "task_started" } }
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  process.env.CODEX_HOME = codexHome;
  return { codexHome, transcript, cleanup: () => rmSync(codexHome, { recursive: true, force: true }) };
}

/**
 * Another Codex app-server's writer: a process in its own process group that
 * keeps the transcript open for append.
 * @param {string} file
 * @returns {Promise<{pid: number, stop: () => void}>}
 */
async function holdOpen(file) {
  const child = spawn(process.execPath, ["-e", "require('fs').openSync(process.argv[1], 'a'); process.stdout.write('ready\\n'); setInterval(() => {}, 1e9);", file], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"]
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", resolve);
  });
  return { pid: /** @type {number} */ (child.pid), stop: () => { try { process.kill(/** @type {number} */ (child.pid), "SIGKILL"); } catch { /* already gone */ } } };
}

/**
 * Agent Link's app-server as it answered in the incident: the thread is not
 * loaded there, and thread/archive fails.
 * @param {{loaded?: string[], unavailable?: boolean, managedPid?: number | null}} [options]
 */
function incidentAppServer({ loaded = [], unavailable = false, managedPid = OWN_APP_SERVER_PID } = {}) {
  const requests = [];
  return {
    requests,
    async request(/** @type {string} */ method, /** @type {any} */ params) {
      requests.push(method);
      if (unavailable) throw new Error("app-server unavailable");
      if (method === "thread/loaded/list") return { data: loaded, nextCursor: null };
      if (method === "thread/archive") throw new AppServerError(`thread ${params.threadId} already has an active writer`, { code: -32600 });
      throw new AppServerError(`fake: ${method}`, { code: -32601 });
    },
    getConnectionSummary: () => ({ connected: !unavailable, managed: true, managedPid, codexHome: process.env.CODEX_HOME })
  };
}

/** @param {any} appServer */
function actionsFor(appServer) {
  const rolloutCheck = makeRolloutCheck({ ownProcessGroup: () => appServer.getConnectionSummary().managedPid ?? null });
  return makeThreadActions({
    appServer,
    messaging: /** @type {any} */ ({ sendToThread: async () => { throw new Error("unused"); }, recordActionReceipt: async () => ({ recorded: false }) }),
    desktop: /** @type {any} */ ({}),
    rolloutCheck
  });
}

/** @param {string} codexHome */
function archivedFiles(codexHome) {
  const root = path.join(codexHome, "archived_sessions");
  return existsSync(root) ? readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".jsonl")) : [];
}

test("a transcript another process holds open is never moved, even with forceLoaded", { skip: process.platform === "win32" }, async () => {
  const home = codexHomeWithRunningThread();
  const holder = await holdOpen(home.transcript);
  try {
    const actions = actionsFor(incidentAppServer());
    for (const forceLoaded of [true, false]) {
      await assert.rejects(
        actions.archiveThread({ threadId: T, forceLoaded, receipt: { record: false } }),
        (/** @type {any} */ error) => {
          assert.equal(error.errorCode, "active_turn_conflict");
          assert.equal(error.details.reason, "open_in_another_process");
          assert.equal(error.details.rolloutPath, home.transcript);
          assert.match(error.details.appServerError.message, /active writer/);
          return true;
        },
        `forceLoaded=${forceLoaded}`
      );
      assert.ok(existsSync(home.transcript), "the transcript stays where Codex's state database points");
      assert.deepEqual(archivedFiles(home.codexHome), [], "nothing is written to archived_sessions");
    }
  } finally {
    holder.stop();
    home.cleanup();
  }
});

test("when Agent Link's own app-server pid is unknown, any other holder still blocks the move", { skip: process.platform === "win32" }, async () => {
  const home = codexHomeWithRunningThread();
  const holder = await holdOpen(home.transcript);
  try {
    const actions = actionsFor(incidentAppServer({ unavailable: true, managedPid: null }));
    await assert.rejects(
      actions.archiveThread({ threadId: T, forceLoaded: true, receipt: { record: false } }),
      (/** @type {any} */ error) => error.errorCode === "active_turn_conflict" && error.details.reason === "open_in_another_process"
    );
    assert.ok(existsSync(home.transcript));
  } finally {
    holder.stop();
    home.cleanup();
  }
});

test("Agent Link's own app-server holding the transcript is the loaded case: forceLoaded still decides", { skip: process.platform === "win32" }, async () => {
  const home = codexHomeWithRunningThread();
  const holder = await holdOpen(home.transcript);
  try {
    const actions = actionsFor(incidentAppServer({ loaded: [T], managedPid: holder.pid }));
    await assert.rejects(actions.archiveThread({ threadId: T, receipt: { record: false } }), /active writer/);
    assert.ok(existsSync(home.transcript));
    const result = await actions.archiveThread({ threadId: T, forceLoaded: true, receipt: { record: false } });
    assert.equal(result.action, "local_archive_moved");
    assert.deepEqual(result.archive.rolloutCheck, { held: false, checked: true });
    assert.equal(existsSync(home.transcript), false);
  } finally {
    holder.stop();
    home.cleanup();
  }
});

test("with Codex's state database present, the local fallback refuses and moves nothing", async () => {
  const home = codexHomeWithRunningThread();
  try {
    writeFileSync(path.join(home.codexHome, "state_5.sqlite"), "");
    const actions = actionsFor(incidentAppServer({ unavailable: true }));
    await assert.rejects(
      actions.archiveThread({ threadId: T, receipt: { record: false } }),
      (/** @type {any} */ error) => {
        assert.equal(error.errorCode, "unsupported");
        assert.equal(error.details.capability, "local_archive");
        assert.equal(error.details.reason, "codex_state_db");
        assert.equal(error.details.stateDb, path.join(home.codexHome, "state_5.sqlite"));
        assert.equal(error.details.loadedCheck.checked, false);
        return true;
      }
    );
    assert.ok(existsSync(home.transcript));
    assert.deepEqual(archivedFiles(home.codexHome), []);
    // archiveLocalThread itself refuses too, for any caller.
    await assert.rejects(archiveLocalThread(T, { codexHome: home.codexHome }), (/** @type {any} */ error) => error.errorCode === "unsupported");
    assert.ok(existsSync(home.transcript));

    // Without a state database (older Codex), the move still works.
    rmSync(path.join(home.codexHome, "state_5.sqlite"));
    const result = await actions.archiveThread({ threadId: T, receipt: { record: false } });
    assert.equal(result.action, "local_archive_moved");
    assert.equal(existsSync(home.transcript), false);
    assert.equal(archivedFiles(home.codexHome).length, 1);
  } finally {
    home.cleanup();
  }
});

test("strict rollout check: an unknown endpoint process group still runs lsof and counts every other holder", async () => {
  const fakeRun = (/** @type {string} */ stdout) => (/** @type {any} */ _f, /** @type {any} */ _a, /** @type {any} */ _o, /** @type {any} */ cb) => cb(null, stdout);
  const unknown = () => null;
  const logger = { warn: () => {} };
  assert.equal((await makeRolloutCheck({ ownProcessGroup: unknown, run: fakeRun("p555\ng555\n"), selfPid: 1, logger })("/r.jsonl")).reason, "endpoint_pid_unknown", "a push still skips");
  assert.deepEqual(await makeRolloutCheck({ ownProcessGroup: unknown, run: fakeRun("p555\ng555\n"), selfPid: 1 })("/r.jsonl", { strict: true }), { held: true, checked: true, reason: "open_in_another_process" });
  assert.deepEqual(await makeRolloutCheck({ ownProcessGroup: unknown, run: fakeRun("p1\ng1\n"), selfPid: 1 })("/r.jsonl", { strict: true }), { held: false, checked: true }, "this process is never a holder");
  assert.deepEqual(await makeRolloutCheck({ ownProcessGroup: () => 100, run: fakeRun("p101\ng100\n"), selfPid: 1 })("/r.jsonl", { strict: true }), { held: false, checked: true }, "our own endpoint's group");
  // lsof takes seconds on a machine with ~1000 processes: a push keeps its
  // short budget, a move waits longer before the check gives up.
  const timeouts = [];
  const timed = makeRolloutCheck({ ownProcessGroup: () => 100, run: (_f, _a, options, cb) => { timeouts.push(options.timeout); cb(null, ""); }, selfPid: 1 });
  await timed("/r.jsonl");
  await timed("/r.jsonl", { strict: true });
  assert.deepEqual(timeouts, [1_000, 10_000]);
});
