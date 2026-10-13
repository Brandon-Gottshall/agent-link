// tests/codex/e2e-installed-servers.test.js
//
// The cross-harness live E2E turns off installed Agent Link copies for its own
// app-servers. A plugin-provided MCP server is turned off through its plugin
// (`-c plugins.<id>.enabled=false`). Only a server defined directly under
// `mcp_servers` gets `-c mcp_servers.<name>.enabled=false`: for a name the
// config does not define, that override creates an entry with no command,
// and codex-cli 0.162.1 refuses to start ("invalid transport in
// `mcp_servers.codex-agent-link`").
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import test from "node:test";
import { installedAgentLinkServers } from "../../scripts/e2e-installed-servers.js";

test("plugin-provided Agent Link servers are disabled through their plugin, config ones by name", () => {
  // mcpServerStatus/list data as codex-cli 0.162.1 returns it (trimmed).
  const data = [
    { name: "codex-agent-link", pluginId: "codex-agent-link@agent-link", serverInfo: { name: "agent-link", version: "0.6.2" } },
    { name: "agent-link-legacy", pluginId: null },
    { name: "agent_link_e2e", pluginId: null },
    { name: "computer-use", pluginId: null },
    { name: "notes", pluginId: "apple-notes@brandon-local" }
  ];
  assert.deepEqual(installedAgentLinkServers(data, { ownName: "agent_link_e2e" }), {
    mcpNames: ["agent-link-legacy"],
    pluginIds: ["codex-agent-link@agent-link"]
  });
});

test("no status data disables nothing", () => {
  assert.deepEqual(installedAgentLinkServers(undefined, { ownName: "agent_link_e2e" }), { mcpNames: [], pluginIds: [] });
});
