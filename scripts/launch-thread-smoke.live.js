#!/usr/bin/env node
import "./live-guard.js";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const openInGui = process.env.CODEX_AGENT_LINK_SMOKE_OPEN_GUI === "1";
const guiDryRun = process.env.CODEX_AGENT_LINK_SMOKE_GUI_DRY_RUN === "1";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./src/server.js"],
  cwd: pluginRoot,
  env: {
    ...process.env,
    CODEX_AGENT_LINK_AUTOSTART: "1",
    ...(guiDryRun ? { CODEX_AGENT_LINK_GUI_OPEN_DRY_RUN: "1" } : {})
  }
});

const client = new Client({ name: "codex-agent-link-launch-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const launch = await client.callTool({
    name: "launch_codex_thread",
    arguments: {
      cwd: pluginRoot,
      ephemeral: true,
      openInGui
    }
  });
  assert.equal(launch.isError, false);

  const payload = JSON.parse(launch.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "started_thread");
  assert.equal(typeof payload.thread.id, "string");
  assert.ok(payload.thread.id.length > 0);
  assert.equal(payload.gui.attempted, openInGui);
  assert.equal(payload.gui.deepLink, `codex://threads/${encodeURIComponent(payload.thread.id)}`);
  if (openInGui) {
    assert.match(payload.gui.command, /^open -g codex:\/\/threads\//);
    assert.equal(payload.gui.dryRun === true, guiDryRun);
  }

  console.log(`Launch thread smoke test passed; created ${payload.thread.id}; openInGui=${openInGui}; guiDryRun=${guiDryRun}`);
} finally {
  await client.close();
}
