#!/usr/bin/env node
import "./live-guard.js";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./src/server.js"],
  cwd: pluginRoot,
  env: {
    ...process.env,
    CODEX_AGENT_LINK_AUTOSTART: "1"
  }
});

const client = new Client({ name: "codex-agent-link-app-server-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const health = await client.callTool({
    name: "agent_link_health",
    arguments: {}
  });
  assert.equal(health.isError, false);

  const list = await client.callTool({
    name: "list_codex_threads",
    arguments: { limit: 2 }
  });
  assert.equal(list.isError, false);
  const payload = JSON.parse(list.content[0].text);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.data));
  console.log(`App-server smoke test passed; saw ${payload.data.length} thread(s)`);
} finally {
  await client.close();
}
