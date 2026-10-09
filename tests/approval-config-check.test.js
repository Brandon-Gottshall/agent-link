// scripts/approval-config-check.js reads only the Codex config it is told to
// (PR B9 review). With no --config / CODEX_CONFIG it refuses (exit 2) before
// reading anything, even when a config exists at the default location; the
// real config is read only with --real-config or AGENT_LINK_CHECK_REAL_CONFIG=1.
// Runs against dist/server.mjs with a temp HOME and CODEX_HOME.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "./helpers/guard.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "approval-config-check.js");
const pluginId = "codex-agent-link@agent-link";
const tools = JSON.parse(readFileSync(path.join(root, "tests", "fixtures", "tools-list.codex.json"), "utf8"));
const toolList = Array.isArray(tools) ? tools : tools.tools;
const toolNames = toolList.map((tool) => tool.name);
const readOnlyNames = toolList.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name);
const sideEffectNames = toolList.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name);
// Role write tools stay out of the README snippet entirely: leave them asking.
const ROLE_WRITE_TOOLS = ["set_agent_role", "clear_agent_role", "set_agent_override_policy"];

function run(args, extraEnv, home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CODEX_|AGENT_LINK_|CLAUDE_)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, { HOME: home, CODEX_HOME: path.join(home, ".codex"), ...extraEnv });
  return spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
}

const configFor = (names) => [`[plugins."${pluginId}"]`, "enabled = true", ...names.flatMap((tool) => ["", `[plugins."${pluginId}".mcp_servers.codex-agent-link.tools.${tool}]`, 'approval_mode = "approve"'])].join("\n") + "\n";
const fullConfig = () => configFor(toolNames);

test("approval-config-check never reads the default config unless asked", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agent-link-approval-"));
  try {
    // A config at the default location that cannot be read: if the script
    // touched it, it would fail with EACCES instead of refusing.
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const defaultConfig = path.join(home, ".codex", "config.toml");
    writeFileSync(defaultConfig, fullConfig());
    chmodSync(defaultConfig, 0o000);
    const refused = run([], {}, home);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /does not read your real Codex config unless asked/);
    assert.match(refused.stderr, /--config <path>/);
    assert.doesNotMatch(refused.stderr, /EACCES/);
    chmodSync(defaultConfig, 0o600);

    // Explicit file: complete passes, incomplete fails with the missing entries.
    const explicit = path.join(home, "explicit.toml");
    writeFileSync(explicit, fullConfig());
    const ok = run(["--config", explicit], {}, home);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /approval config OK/);
    writeFileSync(explicit, `[plugins."${pluginId}"]\nenabled = true\n`);
    const missing = run([], { CODEX_CONFIG: explicit }, home);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /approval config is incomplete/);

    // The default location is read only when asked for (here it is a temp HOME).
    const real = run(["--real-config"], {}, home);
    assert.equal(real.status, 0, real.stderr);
    assert.match(real.stdout, new RegExp(defaultConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(run([], { AGENT_LINK_CHECK_REAL_CONFIG: "1" }, home).status, 0);
    assert.equal(run(["--config"], {}, home).status, 2, "--config without a path is refused");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("approval-config-check requires the read-only tools; side-effecting ones are optional", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agent-link-approval-"));
  try {
    assert.ok(readOnlyNames.length > 0 && sideEffectNames.length > 0, "fixture has both groups");
    const config = path.join(home, "read-only.toml");
    writeFileSync(config, configFor(readOnlyNames));
    const ok = run(["--config", config], {}, home);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, new RegExp(`${readOnlyNames.length} read-only MCP tools approved`));
    assert.match(ok.stdout, new RegExp(`auto-approved \\(they act without asking\\): 0 of ${sideEffectNames.length}\\.`));

    // --all keeps the old contract: every tool must be approved.
    const all = run(["--config", config, "--all"], {}, home);
    assert.equal(all.status, 1);
    assert.match(all.stderr, /tools\.launch_codex_thread\] approval_mode/);

    // Missing one read-only tool fails and names only that tool.
    writeFileSync(config, configFor(readOnlyNames.filter((name) => name !== "list_agents")));
    const missing = run(["--config", config], {}, home);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /tools\.list_agents\] approval_mode/);
    assert.doesNotMatch(missing.stderr, /tools\.launch_codex_thread\]/);

    // Approved side-effecting tools are reported by name.
    writeFileSync(config, configFor([...readOnlyNames, "message_agent"]));
    const some = run(["--config", config], {}, home);
    assert.equal(some.status, 0, some.stderr);
    assert.match(some.stdout, new RegExp(`1 of ${sideEffectNames.length} \\(message_agent\\)`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the README approval snippet splits tools by their read-only annotation", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const blocks = [...readme.matchAll(/```toml\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2, "two TOML blocks: read-only, then side-effecting");
  const namesIn = (block) => [...block.matchAll(/\.tools\.([a-z_]+)\]\napproval_mode = "approve"/g)].map((m) => m[1]).sort();
  const [readOnlyBlock, sideEffectBlock] = blocks;
  assert.match(readOnlyBlock, new RegExp(`\\[plugins\\."${pluginId}"\\]\\nenabled = true`));
  assert.deepEqual(namesIn(readOnlyBlock), [...readOnlyNames].sort(), "read-only block = every readOnlyHint tool");
  assert.deepEqual(namesIn(sideEffectBlock), sideEffectNames.filter((name) => !ROLE_WRITE_TOOLS.includes(name)).sort(),
    "side-effecting block = every other tool except the role write tools");
});
