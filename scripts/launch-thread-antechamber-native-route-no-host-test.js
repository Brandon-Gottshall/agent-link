#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CodexAppServerClient } from "../src/app-server-client.js";

if (!process.env.CODEX_AGENT_LINK_APP_SERVER_BIN && !process.env.CODEX_APP_SERVER_BIN) {
  throw new Error("Set CODEX_AGENT_LINK_APP_SERVER_BIN to a standalone codex-app-server binary before running this contract test.");
}

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-link-native-route-no-host-"));
const transportRoot = path.join(tempRoot, "transport");
const appServer = new CodexAppServerClient({
  autoStart: true
});
let client = null;

try {
  await appServer.ensureConnected();
  const connection = appServer.getConnectionSummary();
  assert.equal(connection.kind, "managed");
  assert.equal(typeof connection.url, "string");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./src/server.js"],
    cwd: pluginRoot,
    env: {
      ...process.env,
      CODEX_AGENT_LINK_AUTOSTART: "0",
      CODEX_AGENT_LINK_URL: connection.url,
      ANTECHAMBER_APPROVAL_TRANSPORT_ROOT: transportRoot
    }
  });
  client = new Client({ name: "codex-agent-link-native-route-no-host", version: "0.1.0" });
  await client.connect(transport);

  const threadName = `Agent Link native quiet route no-host smoke ${new Date().toISOString()}`;
  const launch = await client.callTool({
    name: "launch_codex_thread",
    arguments: {
      cwd: pluginRoot,
      name: threadName,
      ephemeral: false,
      openInGui: false,
      antechamberHandoff: {
        enabled: true,
        mode: "native_quiet_route",
        expiresInSeconds: 300
      }
    }
  });
  assert.equal(launch.isError, false);

  const payload = JSON.parse(launch.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.thread.name, threadName);
  assert.equal(payload.gui.attempted, false);
  assert.equal(payload.antechamberHandoff.attempted, true);
  assert.equal(payload.antechamberHandoff.ok, true);
  assert.equal(payload.antechamberHandoff.handoffOk, true);
  assert.equal(payload.antechamberHandoff.routeAttempted, true);
  assert.equal(payload.antechamberHandoff.routeOk, false);
  assert.equal(payload.antechamberHandoff.opensTargetApp, false);
  assert.equal(payload.antechamberHandoff.authority, "validated_only");
  assert.equal(payload.antechamberHandoff.routeResult.ok, false);
  assert.equal(payload.antechamberHandoff.routeResult.authority, "validated_only");
  assert.equal(payload.antechamberHandoff.routeResult.routeAuthority, "validatedOnly");
  assert.equal(payload.antechamberHandoff.routeResult.selectedThreadId, null);
  assert.equal(payload.antechamberHandoff.routeResult.focused, null);
  assert.equal(payload.antechamberHandoff.routeResult.routed, false);
  assert.match(payload.antechamberHandoff.routeResult.reason, /desktop.*host|adapter|unavailable/i);
  assert.ok(payload.antechamberHandoff.handoffPath);
  await fs.stat(payload.antechamberHandoff.handoffPath);

  console.log(`Antechamber native quiet route no-host smoke test passed; created ${payload.thread.id}; request ${payload.antechamberHandoff.requestId}; authority=${payload.antechamberHandoff.authority}`);
} finally {
  await client?.close();
  await appServer.close();
}
