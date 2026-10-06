// tests/manifest.test.js
// Keeps the hand-maintained host manifests, marketplace files, and package.json
// consistent. There is no generator: each file is edited directly, and this
// test is what catches drift between them.
//
// Naming map: the plugin is `agent-link` everywhere except the Codex plugin
// manifest and Codex marketplace entry, which keep the legacy name
// `codex-agent-link`. The MCP server key is `codex-agent-link` on both hosts so
// existing tool-approval keys keep working.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));

const pkg = readJson("package.json");
const claude = readJson(".claude-plugin/plugin.json");
const codex = readJson(".codex-plugin/plugin.json");
const claudeMarket = readJson(".claude-plugin/marketplace.json");
const codexMarket = readJson(".agents/plugins/marketplace.json");
const mcp = readJson(".mcp.json");
const codexMcp = readJson(".codex-mcp.json");
const hooks = readJson("hooks/hooks.json");

const NAME = "agent-link";
const CODEX_NAME = "codex-agent-link";
const MCP_KEY = "codex-agent-link";
const AUTHOR = "Brandon Gottshall";
const REPO_URL = "https://github.com/Brandon-Gottshall/agent-link";
const SERVER = "dist/server.mjs";

test("package.json carries the shared metadata", () => {
  assert.equal(pkg.name, NAME);
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.author, AUTHOR);
  assert.equal(pkg.homepage, REPO_URL);
  assert.equal(pkg.repository?.url, `git+${REPO_URL}.git`);
  assert.equal(pkg.bugs?.url, `${REPO_URL}/issues`);
});

test("host manifests match package.json", () => {
  assert.equal(claude.name, NAME);
  assert.equal(codex.name, CODEX_NAME);
  for (const [label, manifest] of [["claude", claude], ["codex", codex]]) {
    assert.equal(manifest.version, pkg.version, `${label} version`);
    assert.equal(manifest.description, pkg.description, `${label} description`);
    assert.equal(manifest.license, pkg.license, `${label} license`);
    assert.equal(manifest.homepage, pkg.homepage, `${label} homepage`);
    assert.equal(manifest.repository, REPO_URL, `${label} repository`);
    assert.deepEqual(manifest.author, { name: AUTHOR, url: "https://github.com/Brandon-Gottshall" }, `${label} author`);
    assert.deepEqual(manifest.keywords, claude.keywords, `${label} keywords`);
    assert.equal(manifest.skills, "./skills/", `${label} skills`);
  }
  assert.ok(existsSync(path.join(root, "skills")), "skills/ exists");
});

test("Codex interface metadata is consistent", () => {
  const ui = codex.interface;
  assert.equal(ui.developerName, AUTHOR);
  assert.equal(ui.websiteURL, REPO_URL);
  assert.equal(ui.category, codexMarket.plugins[0].category);
  assert.ok(Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length >= 1 && ui.defaultPrompt.length <= 3,
    "defaultPrompt has 1-3 entries");
  // Optional in Codex. If ever re-added they must point at this project, not a host vendor.
  for (const key of ["privacyPolicyURL", "termsOfServiceURL"]) {
    if (ui[key] !== undefined) assert.ok(ui[key].startsWith(REPO_URL), `${key} points at this repo`);
  }
});

test("both hosts launch the bundled server under the shared MCP key", () => {
  assert.equal(codex.mcpServers, "./.codex-mcp.json");
  const codexServer = codexMcp.mcpServers?.[MCP_KEY];
  assert.ok(codexServer, ".codex-mcp.json defines the MCP key");
  assert.equal(codexServer.command, "node");
  assert.deepEqual(codexServer.args, [`./${SERVER}`]);

  const claudeServer = claude.mcpServers?.[MCP_KEY];
  assert.ok(claudeServer, ".claude-plugin/plugin.json defines the MCP key");
  assert.equal(claudeServer.command, "node");
  assert.deepEqual(claudeServer.args, [`\${CLAUDE_PLUGIN_ROOT}/${SERVER}`]);

  // Each host declares itself, so host detection never has to guess (W2C-08).
  assert.deepEqual(codexServer.env, { AGENT_LINK_HOST: "codex" });
  assert.deepEqual(claudeServer.env, { AGENT_LINK_HOST: "claude" });

  // The repo-root .mcp.json is only for development: Claude Code loads it as
  // a project config when the repo is opened, so it must not claim a host.
  const devServer = mcp.mcpServers?.[MCP_KEY];
  assert.ok(devServer, ".mcp.json defines the MCP key");
  assert.deepEqual(devServer.args, [`./${SERVER}`]);
  assert.equal(devServer.env?.AGENT_LINK_HOST, undefined, ".mcp.json leaves host detection automatic");

  assert.ok(existsSync(path.join(root, SERVER)), `${SERVER} is committed`);
});

test("hook commands point at files that exist", () => {
  const commands = Object.values(hooks.hooks).flatMap((entries) =>
    entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)));
  assert.ok(commands.length > 0, "hooks.json has commands");
  for (const command of commands) {
    const refs = [...command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s;]+)/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, `hook command references the plugin root: ${command}`);
    for (const rel of refs) assert.ok(existsSync(path.join(root, rel)), `hook target exists: ${rel}`);
  }
});

test("marketplace files reference the right plugin names", () => {
  assert.equal(claudeMarket.name, NAME);
  assert.equal(claudeMarket.owner?.name, AUTHOR);
  assert.equal(claudeMarket.plugins.length, 1);
  assert.equal(claudeMarket.plugins[0].name, claude.name);
  assert.equal(claudeMarket.plugins[0].source, "./");

  assert.equal(codexMarket.name, NAME);
  assert.equal(codexMarket.plugins.length, 1);
  const entry = codexMarket.plugins[0];
  assert.equal(entry.name, codex.name);
  assert.deepEqual(entry.source, { source: "local", path: "./" });
  assert.ok(["ON_INSTALL", "ON_USE"].includes(entry.policy?.authentication));
});

test("no stale canonical manifest is left behind", () => {
  assert.equal(existsSync(path.join(root, ".plugin", "plugin.json")), false);
});
