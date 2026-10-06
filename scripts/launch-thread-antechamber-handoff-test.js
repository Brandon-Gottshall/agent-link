#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transportRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-link-antechamber-"));
const threadName = `Agent Link Antechamber handoff smoke ${new Date().toISOString()}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./src/server.js"],
  cwd: pluginRoot,
  env: {
    ...process.env,
    CODEX_AGENT_LINK_AUTOSTART: "1",
    ANTECHAMBER_APPROVAL_TRANSPORT_ROOT: transportRoot
  }
});

const client = new Client({ name: "codex-agent-link-antechamber-handoff", version: "0.1.0" });

try {
  await client.connect(transport);
  const launch = await client.callTool({
    name: "launch_codex_thread",
    arguments: {
      cwd: pluginRoot,
      name: threadName,
      ephemeral: false,
      openInGui: false,
      antechamberHandoff: {
        enabled: true,
        mode: "data_only",
        expiresInSeconds: 300
      }
    }
  });
  assert.equal(launch.isError, false);

  const payload = JSON.parse(launch.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "started_thread+named_thread");
  assert.equal(payload.thread.name, threadName);
  assert.equal(payload.gui.attempted, false);
  assert.equal(payload.gui.deepLink, `codex://threads/${encodeURIComponent(payload.thread.id)}`);
  assert.equal(payload.antechamberHandoff.attempted, true);
  assert.equal(payload.antechamberHandoff.ok, true);
  assert.equal(payload.antechamberHandoff.opensTargetApp, false);
  assert.equal(payload.antechamberHandoff.surface, "codex_desktop");
  assert.equal(payload.antechamberHandoff.action, "route_thread");
  assert.equal(payload.antechamberHandoff.authority, "handoff_only");
  assert.equal(payload.antechamberHandoff.focusPolicy, "never");
  assert.equal(payload.antechamberHandoff.routeUrl, `codex://threads/${encodeURIComponent(payload.thread.id)}`);
  assert.equal(payload.antechamberHandoff.transportRoot, transportRoot);

  const handoff = JSON.parse(await fs.readFile(payload.antechamberHandoff.handoffPath, "utf8"));
  assert.equal(handoff.request_id, payload.antechamberHandoff.requestId);
  assert.equal(handoff.thread_id, payload.thread.id);
  assert.equal(handoff.route_url, payload.antechamberHandoff.routeUrl);
  assert.equal(handoff.focus_policy, "never");
  assert.equal(handoff.status, "pending");

  await fs.access(payload.antechamberHandoff.approvalRequestPath);
  console.log(`Antechamber handoff smoke test passed; created ${payload.thread.id}; request ${payload.antechamberHandoff.requestId}; transportRoot=${transportRoot}`);
} finally {
  await client.close();
}
