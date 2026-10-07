// Target-side override policy (design doc section 9.2, PR B9): the matrix of
// launcher, peer, role-permitted, and denied senders; cwd inside and outside
// the workspace (git top level, symlinks resolved); Claude targets
// unsupported; allowTargetOverride granting nothing. Pure functions over a
// temp directory.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoClaudeOverrides,
  decideTargetOverrides,
  isWithinWorkspace,
  overrideDeniedError,
  policyAllows,
  workspaceRoot
} from "../../src/delivery/override-policy.js";

const TARGET = "codex:019d9000-0000-7000-8000-0000000000aa";
const LAUNCHER = "codex:019d9000-0000-7000-8000-0000000000l1";
const PEER = "codex:019d9000-0000-7000-8000-0000000000p1";
const ROUTER = "claude:0b5e7c1a-3f2d-4a6e-9c8b-0000000000r1";

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-link-policy-")));
const repo = path.join(tmp, "repo");
const sub = path.join(repo, "packages", "app");
mkdirSync(path.join(repo, ".git"), { recursive: true });
mkdirSync(sub, { recursive: true });
mkdirSync(path.join(repo, "docs"), { recursive: true });
const outside = path.join(tmp, "elsewhere");
mkdirSync(outside, { recursive: true });
// A link inside the repo that points outside it.
symlinkSync(outside, path.join(repo, "escape"));
const plain = path.join(tmp, "plain");
mkdirSync(path.join(plain, "child"), { recursive: true });

const thread = { cwd: sub, model: "gpt-a", reasoningEffort: "medium" };

/**
 * @param {Record<string, any>} args
 * @param {{sender?: string, senderRoles?: string[], targetRoles?: string[], policy?: any, launcher?: string | null, steering?: boolean, threadOverride?: any}} [options]
 */
function decide(args, { sender = PEER, senderRoles = [], targetRoles = [], policy = {}, launcher = LAUNCHER, steering = false, threadOverride = thread } = {}) {
  return decideTargetOverrides({
    thread: threadOverride,
    args,
    steering,
    parties: { senderAddress: sender, senderRoles, targetAddress: TARGET, targetRoles },
    policy,
    launcher
  });
}

test.after(() => rmSync(tmp, { recursive: true, force: true }));

test("workspace: git top level, else the cwd itself; symlinks resolved", () => {
  assert.equal(workspaceRoot(sub), repo);
  assert.equal(workspaceRoot(plain), plain);
  assert.equal(isWithinWorkspace(path.join(repo, "docs"), repo), true);
  assert.equal(isWithinWorkspace(path.join(repo, "not-yet-created"), repo), true, "a new directory inside is inside");
  assert.equal(isWithinWorkspace(path.join(repo, "escape"), repo), false, "a symlink out of the workspace is outside");
  assert.equal(isWithinWorkspace(path.join(repo, "escape", "deeper"), repo), false);
  assert.equal(isWithinWorkspace(`${repo}-sibling`, repo), false, "a sibling with a common prefix is outside");
  assert.equal(isWithinWorkspace(path.join(repo, ".."), repo), false);
});

test("policyAllows: address, role keys, role senders, and * (never external)", () => {
  const policy = {
    [TARGET]: { effort: [PEER] },
    "role:builder": { model: ["role:router"], cwd: ["*"] }
  };
  const parties = { senderAddress: PEER, senderRoles: [], targetAddress: TARGET, targetRoles: ["builder"] };
  assert.deepEqual(policyAllows(policy, "effort", parties), { key: TARGET, sender: PEER });
  assert.equal(policyAllows(policy, "model", parties), null);
  assert.deepEqual(policyAllows(policy, "model", { ...parties, senderAddress: ROUTER, senderRoles: ["router"] }), { key: "role:builder", sender: "role:router" });
  assert.deepEqual(policyAllows(policy, "cwd", parties), { key: "role:builder", sender: "*" });
  assert.equal(policyAllows(policy, "cwd", { ...parties, senderAddress: "external" }), null, "* never matches external");
  assert.equal(policyAllows(policy, "cwd", { ...parties, targetRoles: [] }), null, "a role key applies only while the target holds the role");
});

test("matrix: equal values pass; launcher effort; peer denied; policy allowed", () => {
  // Same values are not changes.
  assert.deepEqual(decide({ model: "gpt-a", effort: "medium", cwd: sub }).forward, { cwd: sub, model: "gpt-a", effort: "medium" });

  // Launcher may change effort, nothing else.
  const launcher = decide({ effort: "high" }, { sender: LAUNCHER });
  assert.equal(launcher.denied, null);
  assert.deepEqual(launcher.switches.map((s) => [s.field, s.previous, s.current, s.grantedBy, s.expectedCost]), [["effort", "medium", "high", "launcher", null]]);
  assert.equal(decide({ model: "gpt-b" }, { sender: LAUNCHER }).denied.reason, "model_switch_requires_fork_or_opt_in");

  // A peer without policy: each setting has its own reason.
  assert.equal(decide({ effort: "high" }).denied.reason, "effort_not_permitted");
  assert.equal(decide({ model: "gpt-b" }).denied.reason, "model_switch_requires_fork_or_opt_in");
  assert.equal(decide({ cwd: path.join(repo, "docs") }).denied.reason, "cwd_change_not_permitted");
  // No recorded launcher: every peer needs policy for effort.
  assert.equal(decide({ effort: "high" }, { sender: LAUNCHER, launcher: null }).denied.reason, "effort_not_permitted");
  // external is never the launcher.
  assert.equal(decide({ effort: "high" }, { sender: "external", launcher: "external" }).denied.reason, "effort_not_permitted");

  // Policy by target address, and through a role the sender holds.
  const byAddress = decide({ model: "gpt-b" }, { policy: { [TARGET]: { model: [PEER] } } });
  assert.equal(byAddress.denied, null);
  assert.deepEqual(byAddress.switches[0], {
    field: "model", setting: "model", kind: "model-switch", previous: "gpt-a", current: "gpt-b", grantedBy: "policy",
    policy: { key: TARGET, sender: PEER }, expectedCost: { uncachedInputTokens: null, basis: "unknown" }
  });
  const byRole = decide({ model: "gpt-b", effort: "low" }, { sender: ROUTER, senderRoles: ["router"], targetRoles: ["builder"], policy: { "role:builder": { model: ["role:router"], effort: ["role:router"] } } });
  assert.deepEqual(byRole.switches.map((s) => [s.field, s.grantedBy]), [["model", "policy"], ["effort", "policy"]]);
  assert.deepEqual(byRole.forward, { model: "gpt-b", effort: "low" });

  // model covers modelProvider and serviceTier.
  const provider = decide({ modelProvider: "other", serviceTier: "flex" }, { threadOverride: { ...thread, modelProvider: "openai", serviceTier: "default" }, policy: { [TARGET]: { model: [PEER] } } });
  assert.deepEqual(provider.switches.map((s) => [s.field, s.setting, s.kind]), [["modelProvider", "model", "model-switch"], ["serviceTier", "model", "model-switch"]]);
  assert.equal(decide({ serviceTier: "flex" }, { threadOverride: { ...thread, serviceTier: "default" } }).denied.reason, "model_switch_requires_fork_or_opt_in");
});

test("cwd: inside the workspace with policy switches; outside is refused even with policy", () => {
  const policy = { [TARGET]: { cwd: [PEER] } };
  const inside = decide({ cwd: path.join(repo, "docs") }, { policy });
  assert.equal(inside.denied, null);
  assert.deepEqual(inside.switches.map((s) => [s.kind, s.previous, s.current]), [["cwd-change", sub, path.join(repo, "docs")]]);
  for (const target of [outside, path.join(repo, "escape"), path.join(repo, "..")]) {
    const result = decide({ cwd: target }, { policy });
    assert.equal(result.denied.reason, "cwd_outside_workspace", target);
    assert.equal(result.denied.workspace, repo);
  }
  // cwd_outside_workspace wins over other denials in the same call.
  assert.equal(decide({ model: "gpt-b", cwd: outside }).denied.reason, "cwd_outside_workspace");
  // An unreported cwd has no workspace: never applied, even with policy.
  assert.equal(decide({ cwd: path.join(repo, "docs") }, { policy, threadOverride: { ...thread, cwd: null } }).denied.reason, "cwd_outside_workspace");
  const error = overrideDeniedError(decide({ cwd: outside }, { policy }).denied, "t1");
  assert.equal(error.errorCode, "permission_denied");
  assert.equal(error.details.reason, "cwd_outside_workspace");
});

test("unknown thread values: not applied without a grant, applied with one", () => {
  const unknown = { cwd: sub, model: null, reasoningEffort: null };
  const denied = decide({ effort: "high", model: "gpt-b" }, { threadOverride: unknown });
  assert.equal(denied.denied, null, "unknown values are not refused (0.4.0 behavior)");
  assert.deepEqual(denied.forward, {});
  assert.deepEqual(denied.warnings.map((w) => [w.code, w.field]), [["target-override-unverified", "model"], ["target-override-unverified", "effort"]]);
  const granted = decide({ effort: "high" }, { sender: LAUNCHER, threadOverride: unknown });
  assert.deepEqual(granted.switches.map((s) => [s.field, s.previous, s.current]), [["effort", null, "high"]]);
});

test("steering ignores overrides; allowTargetOverride grants nothing (R9.13)", () => {
  const steer = decide({ model: "gpt-b", cwd: outside }, { steering: true });
  assert.equal(steer.denied, null);
  assert.deepEqual(steer.switches, []);
  assert.deepEqual(steer.warnings.map((w) => w.code), ["target-override-ignored-steer", "target-override-ignored-steer"]);
  const flagged = decide({ model: "gpt-b", allowTargetOverride: true });
  assert.equal(flagged.denied.reason, "model_switch_requires_fork_or_opt_in");
  assert.equal(flagged.warnings[0].code, "ignored_argument");
  assert.match(flagged.warnings[0].message, /0\.8\.0/);
  const flaggedOk = decide({ model: "gpt-a", allowTargetOverride: true });
  assert.equal(flaggedOk.denied, null);
  assert.equal(flaggedOk.warnings[0].code, "ignored_argument");
});

test("R9.6: Claude targets accept no overrides", () => {
  assert.doesNotThrow(() => assertNoClaudeOverrides({ message: "hi" }, ROUTER));
  for (const field of ["cwd", "model", "effort", "modelProvider", "serviceTier"]) {
    assert.throws(() => assertNoClaudeOverrides({ [field]: "x" }, ROUTER), (error) => error.errorCode === "unsupported" && error.details.capability === "turn_overrides" && error.details.fields[0] === field);
  }
});
