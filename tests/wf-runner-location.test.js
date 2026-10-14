// tests/wf-runner-location.test.js
// The WF runner's reports hold local paths and session ids, and both hosts copy
// the plugin folder whole, so reports must land under the Agent Link state dir
// (AGENT_LINK_STATE_DIR, default ~/.agent-link), never inside the plugin folder.
// Runs the dry suite against a throwaway state dir; nothing touches a real
// ~/.agent-link, ~/.claude or ~/.codex.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "./helpers/guard.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hermeticEnv } from "./helpers/env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(root, "scripts", "agent-wf-runner.js");
const SUITE = "agent-link-dependency-callback-wf";

const tempDir = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-link-wf-location-")));
// Entries under the plugin folder's own wf-runs/<suite>; 0 when either is absent.
const repoWfRuns = () => {
  const dir = path.join(root, "wf-runs", SUITE);
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).length : 0;
};

/** @param {string[]} args @param {Record<string, string | undefined>} overrides */
function runDry(args, overrides) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: root, env: hermeticEnv({ overrides }), encoding: "utf8"
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

const reportsIn = (/** @type {string} */ dir) => readdirSync(path.join(dir, SUITE)).sort();

test("default report directory is <state dir>/wf-runs/<suite>, not the plugin folder", () => {
  const state = tempDir();
  try {
    const before = repoWfRuns();
    runDry([], { AGENT_LINK_STATE_DIR: state });
    const reports = reportsIn(path.join(state, "wf-runs"));
    assert.equal(reports.length, 2);
    assert.deepEqual(reports.map((name) => path.extname(name)).sort(), [".json", ".md"]);
    assert.equal(repoWfRuns(), before, "nothing was written under the plugin folder's wf-runs/");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("with no state dir configured the default is ~/.agent-link/wf-runs", () => {
  const home = tempDir();
  try {
    const before = repoWfRuns();
    runDry([], { HOME: home, AGENT_LINK_STATE_DIR: undefined });
    assert.equal(reportsIn(path.join(home, ".agent-link", "wf-runs")).length, 2);
    assert.equal(repoWfRuns(), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("AGENT_LINK_WF_RUNS_DIR and --report-dir override the directory", () => {
  const state = tempDir();
  const viaEnv = tempDir();
  const viaFlag = tempDir();
  try {
    runDry([], { AGENT_LINK_STATE_DIR: state, AGENT_LINK_WF_RUNS_DIR: viaEnv });
    assert.equal(reportsIn(viaEnv).length, 2);
    assert.equal(existsSync(path.join(state, "wf-runs")), false);

    runDry(["--report-dir", viaFlag], { AGENT_LINK_STATE_DIR: state, AGENT_LINK_WF_RUNS_DIR: viaEnv });
    assert.equal(reportsIn(viaFlag).length, 2);
    assert.equal(reportsIn(viaEnv).length, 2, "the flag wins over the environment variable");
  } finally {
    for (const dir of [state, viaEnv, viaFlag]) rmSync(dir, { recursive: true, force: true });
  }
});

test("a relative AGENT_LINK_WF_RUNS_DIR or --report-dir is rejected and nothing is written", () => {
  const state = tempDir();
  try {
    const before = repoWfRuns();
    for (const [args, overrides, source] of [
      [[], { AGENT_LINK_STATE_DIR: state, AGENT_LINK_WF_RUNS_DIR: "wf-runs" }, "AGENT_LINK_WF_RUNS_DIR"],
      [["--report-dir", "./out"], { AGENT_LINK_STATE_DIR: state }, "--report-dir"]
    ]) {
      const result = spawnSync(process.execPath, [RUNNER, ...args], { cwd: root, env: hermeticEnv({ overrides }), encoding: "utf8" });
      assert.notEqual(result.status, 0, source);
      assert.match(result.stderr, new RegExp(`${source} must be an absolute path`), source);
    }
    assert.equal(existsSync(path.join(state, "wf-runs")), false);
    assert.equal(repoWfRuns(), before);
    assert.equal(existsSync(path.join(root, "out")), false);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("an override starting with ~ expands to the home directory", () => {
  const home = tempDir();
  try {
    runDry(["--report-dir", "~/reports"], { HOME: home, AGENT_LINK_STATE_DIR: path.join(home, "state") });
    assert.equal(reportsIn(path.join(home, "reports")).length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
