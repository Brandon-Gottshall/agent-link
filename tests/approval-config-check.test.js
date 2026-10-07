// scripts/approval-config-check.js reads only the Codex config it is told to
// (PR B9 review). With no --config / CODEX_CONFIG it refuses (exit 2) before
// reading anything, even when a config exists at the default location; the
// real config is read only with --real-config or AGENT_LINK_CHECK_REAL_CONFIG=1.
// Runs against dist/server.mjs with a temp HOME and CODEX_HOME.
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
const toolNames = (Array.isArray(tools) ? tools : tools.tools).map((tool) => tool.name);

function run(args, extraEnv, home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CODEX_|AGENT_LINK_|CLAUDE_)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, { HOME: home, CODEX_HOME: path.join(home, ".codex"), ...extraEnv });
  return spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
}

const fullConfig = () => [`[plugins."${pluginId}"]`, "enabled = true", ...toolNames.flatMap((tool) => ["", `[plugins."${pluginId}".mcp_servers.codex-agent-link.tools.${tool}]`, 'approval_mode = "approve"'])].join("\n") + "\n";

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
