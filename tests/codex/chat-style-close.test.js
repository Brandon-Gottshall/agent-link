// Drives the MCP server exactly as a chat-style MCP host does:
// detached spawn, one tool call, then close = stdin end + SIGTERM to the process group,
// SIGKILL to the group 1 s later if the server is still up. No managed app-server may
// outlive the server, whatever point in its lifecycle the close lands at.
// Close points are events, not delays: before any reply, after the initialize
// reply, once the stub app-server has started, and after the tool-call reply.
// Uses a stub app-server; never launches Codex.app.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { alive, pluginRoot, readSpawnLog, taggedProcesses, taggedStub, waitFor, waitForExit } from "../helpers/codex-stub.js";
import { hermeticEnv } from "../helpers/env.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-link-chat-close-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function responses(child) {
  const seen = new Map();
  const waiters = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined) continue;
      seen.set(msg.id, msg);
      waiters.get(msg.id)?.(msg);
    }
  });
  return (id, label) => seen.has(id) ? Promise.resolve(seen.get(id)) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: no response to request ${id}`)), 15000);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  });
}

async function chatStyleRun(closeAt) {
  const dir = path.join(tmp, closeAt);
  mkdirSync(dir);
  const spawnLog = path.join(dir, "spawns.log");
  const stub = taggedStub(dir);
  const child = spawn(process.execPath, [path.join(pluginRoot, "src", "server.js")], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: hermeticEnv({
      home: path.join(dir, "home"),
      overrides: {
        CODEX_AGENT_LINK_APP_SERVER_BIN: stub,
        CODEX_AGENT_LINK_STATE_DIR: path.join(dir, "state"),
        AGENT_LINK_MAILBOX_PATH: path.join(dir, "mailbox.jsonl"),
        AGENT_LINK_STUB_SPAWN_LOG: spawnLog,
        AGENT_LINK_STUB_GRANDCHILD: "1"
      }
    })
  });
  child.stderr.resume();
  const response = responses(child);
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chat-style", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_loaded_codex_threads", arguments: {} } });

  try {
    return await closeAndCheck({ child, closeAt, response, spawnLog, stub });
  } finally {
    // A failed wait must not leave the server (and its pipes) holding the test open.
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    const { starts, grandchildren } = readSpawnLog(spawnLog);
    for (const pid of [...starts.map((s) => s.pid), ...grandchildren.map((g) => g.pid), ...taggedProcesses(stub)]) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
}

async function closeAndCheck({ child, closeAt, response, spawnLog, stub }) {
  let reply = null;
  if (closeAt === "after-initialize") {
    await response(1, closeAt);
  } else if (closeAt === "after-spawn") {
    await waitFor(() => readSpawnLog(spawnLog).starts.length > 0, { timeoutMs: 10000, label: `${closeAt}: app-server spawn` });
  } else if (closeAt === "after-reply") {
    reply = await response(2, closeAt);
  }

  // The host's close().
  child.stdin.end();
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  }, 1000);

  const exit = await waitForExit(child, 5000);
  clearTimeout(killTimer);
  assert.ok(!exit.timeout, `${closeAt}: server exited`);

  // The server is gone, so the set of app-servers it started is final: every
  // process logged by the stub or carrying this run's stub path in its argv,
  // plus their process groups.
  const { starts, grandchildren } = readSpawnLog(spawnLog);
  const pids = [...new Set([...starts.map((s) => s.pid), ...grandchildren.map((g) => g.pid), ...taggedProcesses(stub)])];
  await waitFor(() => pids.every((pid) => !alive(pid)), { timeoutMs: 4000, label: `${closeAt}: no app-server outlives the server` })
    .catch(() => {
      const survivors = pids.filter(alive);
      for (const pid of survivors) try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
      assert.fail(`${closeAt}: app-server(s) outlived the server: ${survivors.join(", ")}`);
    });
  return { spawned: readSpawnLog(spawnLog).starts.length, reply };
}

test("chat-style close leaves no managed app-server behind", { concurrency: true }, async (t) => {
  await Promise.all([
    t.test("immediate", async () => {
      await chatStyleRun("immediate");
    }),
    t.test("after-initialize", async () => {
      await chatStyleRun("after-initialize");
    }),
    t.test("after-spawn", async () => {
      const { spawned } = await chatStyleRun("after-spawn");
      assert.ok(spawned >= 1, "the after-spawn case really started an app-server");
    }),
    t.test("after-reply", async () => {
      const { spawned, reply } = await chatStyleRun("after-reply");
      assert.ok(reply.result && reply.result.isError !== true, `tool call succeeded:${JSON.stringify(reply).slice(0, 300)}`);
      assert.equal(spawned, 1, "the tool call started exactly one app-server");
    })
  ]);
});
