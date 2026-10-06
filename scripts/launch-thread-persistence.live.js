#!/usr/bin/env node
import "./live-guard.js";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CodexAppServerClient } from "../src/codex/app-server-client.js";
import { readLocalThread } from "../src/codex/session-index.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const threadName = `Agent Link blank persistence smoke ${new Date().toISOString()}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./src/server.js"],
  cwd: pluginRoot,
  env: {
    ...process.env,
    CODEX_AGENT_LINK_AUTOSTART: "1"
  }
});

const client = new Client({ name: "codex-agent-link-persistence-smoke", version: "0.1.0" });
let threadId = null;

try {
  await client.connect(transport);
  const launch = await client.callTool({
    name: "launch_codex_thread",
    arguments: {
      cwd: pluginRoot,
      name: threadName,
      ephemeral: false,
      openInGui: false
    }
  });
  assert.equal(launch.isError, false);

  const payload = JSON.parse(launch.content[0].text);
  threadId = payload.thread.id;
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "started_thread+named_thread");
  assert.equal(payload.thread.name, threadName);
  assert.deepEqual(payload.nameUpdate, {
    name: threadName,
    reason: "name was supplied by caller"
  });
  assert.equal(payload.gui.attempted, false);
} finally {
  await client.close();
}

assert.ok(threadId, "launch_codex_thread should return a thread id");
await new Promise((resolve) => setTimeout(resolve, 700));

const local = await readLocalThread(threadId, { includeTurns: false });
assert.equal(local.thread.id, threadId);
assert.equal(local.thread.name, threadName);
assert.equal(local.thread.lastEventType, "thread_name_updated");

const appServer = new CodexAppServerClient({
  autoStart: true,
  requestTimeoutMs: 10000,
  startupTimeoutMs: 15000
});

try {
  const read = await appServer.request("thread/read", { threadId, includeTurns: false });
  assert.equal(read.thread.id, threadId);
  assert.equal(read.thread.name, threadName);
  assert.equal(read.thread.status.type, "notLoaded");
} finally {
  appServer.close();
}

console.log(`Launch thread persistence test passed; created durable blank thread ${threadId}`);
