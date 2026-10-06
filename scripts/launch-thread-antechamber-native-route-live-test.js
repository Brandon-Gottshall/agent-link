#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CodexAppServerClient } from "../src/app-server-client.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const broker = option("--broker") || process.env.CODEX_AGENT_LINK_ANTECHAMBER_CLI || findAntechamberBroker();
if (!broker) {
  throw new Error("Could not find agent-browser-broker. Set CODEX_AGENT_LINK_ANTECHAMBER_CLI or pass --broker <path>.");
}

const transportRoot = option("--transport-root")
  || await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-link-live-native-route-"));
const threadName = option("--name") || `Agent Link live native quiet route ${new Date().toISOString()}`;
const releaseLock = await acquireLiveRouteLock();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./src/server.js"],
  cwd: pluginRoot,
  env: {
    ...process.env,
    CODEX_AGENT_LINK_AUTOSTART: "1",
    CODEX_AGENT_LINK_ANTECHAMBER_CLI: broker,
    ANTECHAMBER_APPROVAL_TRANSPORT_ROOT: transportRoot
  }
});
const client = new Client({ name: "codex-agent-link-live-native-route", version: "0.1.0" });
const appServer = new CodexAppServerClient({
  autoStart: true,
  requestTimeoutMs: 15000,
  startupTimeoutMs: 15000
});

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
        mode: "native_quiet_route",
        expiresInSeconds: 300
      }
    }
  });
  assert.equal(launch.isError, false);

  const payload = JSON.parse(launch.content?.[0]?.text ?? "{}");
  const handoff = payload.antechamberHandoff;
  const routeResult = handoff?.routeResult;
  assert.equal(payload.ok, true);
  assert.equal(payload.thread?.name, threadName);
  assert.equal(payload.gui?.attempted, false);
  assert.equal(handoff?.ok, true);
  assert.equal(handoff?.handoffOk, true);
  assert.equal(handoff?.routeAttempted, true);
  assert.equal(handoff?.routeOk, true);
  assert.equal(handoff?.authority, "native_quiet_route");
  assert.equal(routeResult?.ok, true);
  assert.equal(routeResult?.authority, "native_quiet_route");
  assert.equal(routeResult?.routeAuthority, "nativeQuietRoute");
  assert.equal(routeResult?.selectedThreadId, payload.thread.id);
  assert.equal(routeResult?.focused, false);
  assert.equal(routeResult?.routed, true);

  const readback = await appServer.request("desktop/thread/selection/read", {});
  assert.equal(readback?.authority, "nativeQuietRoute");
  assert.equal(readback?.selection?.threadId, payload.thread.id);
  assert.equal(readback?.selection?.focused, false);

  const result = {
    ok: true,
    threadId: payload.thread.id,
    threadName,
    broker,
    transportRoot,
    requestId: handoff.requestId,
    auditPath: routeResult.auditPath ?? null,
    routeAuthority: routeResult.routeAuthority,
    selectedThreadId: routeResult.selectedThreadId,
    focused: routeResult.focused,
    routed: routeResult.routed,
    readback,
    connection: appServer.getConnectionSummary()
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Live native quiet route smoke test passed; thread=${result.threadId}; request=${result.requestId}; focused=${result.focused}; transportRoot=${result.transportRoot}\n`);
  }
} finally {
  await client.close();
  await appServer.close();
  await releaseLock();
}

function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) {
    return null;
  }
  return args[index + 1];
}

function findAntechamberBroker() {
  const candidates = [
    "/opt/homebrew/bin/agent-browser-broker",
    "/usr/local/bin/agent-browser-broker"
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function acquireLiveRouteLock() {
  const lockDir = path.join(os.tmpdir(), "codex-agent-link-live-native-route.lock");
  try {
    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");
    return async () => {
      await fs.rm(lockDir, { recursive: true, force: true });
    };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  let stale = false;
  try {
    const stat = await fs.stat(lockDir);
    stale = Date.now() - stat.mtimeMs > 120000;
  } catch {
    stale = true;
  }
  if (stale) {
    await fs.rm(lockDir, { recursive: true, force: true });
    return acquireLiveRouteLock();
  }

  throw new Error(`Live native route smoke test is already running; remove stale lock ${lockDir} only if no validation is active.`);
}
