#!/usr/bin/env node
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
    CODEX_AGENT_LINK_AUTOSTART: "0"
  }
});

const client = new Client({ name: "codex-agent-link-antechamber-conflict", version: "0.1.0" });

try {
  await client.connect(transport);
  const launch = await client.callTool({
    name: "launch_codex_thread",
    arguments: {
      openInGui: true,
      antechamberHandoff: {
        enabled: true
      }
    }
  });

  assert.equal(launch.isError, true);
  const payload = JSON.parse(launch.content[0].text);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /cannot combine openInGui:true with antechamberHandoff\.enabled:true/);

  console.log("Antechamber handoff conflict test passed; no app-server launch was attempted.");
} finally {
  await client.close();
}
