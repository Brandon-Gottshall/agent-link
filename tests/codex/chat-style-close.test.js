// Drives the MCP server exactly as a chat-style MCP host does:
// detached spawn, one tool call, then close = stdin end + SIGTERM to the process group,
// SIGKILL to the group 1 s later if the server is still up. No managed app-server may
// outlive the server, whatever point in its lifecycle the close lands at.
// Uses a stub app-server; never launches Codex.app.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { alive, pluginRoot, readSpawnLog, sleep, stubAppServer, waitFor } from "./test-helpers.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-link-chat-close-"));

async function chatStyleRun(closeAfterMs, label) {
  const spawnLog = path.join(tmp, `${label}.log`);
  const child = spawn(process.execPath, [path.join(pluginRoot, "src", "server.js")], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      CODEX_AGENT_LINK_APP_SERVER_BIN: stubAppServer,
      CODEX_AGENT_LINK_STATE_DIR: path.join(tmp, `${label}-state`),
      AGENT_LINK_STUB_SPAWN_LOG: spawnLog,
      AGENT_LINK_STUB_GRANDCHILD: "1",
      CODEX_AGENT_LINK_URL: "",
      CODEX_APP_SERVER_URL: "",
      CODEX_THREAD_ID: "",
      CODEX_TURN_ID: "",
      CLAUDE_SESSION_ID: ""
    }
  });
  child.stdout.resume();
  child.stderr.resume();
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chat-style", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_loaded_codex_threads", arguments: {} } });

  if (closeAfterMs === "after-spawn") {
    await waitFor(() => readSpawnLog(spawnLog).starts.length > 0, { timeoutMs: 10000, label: `${label}: app-server spawn` });
  } else {
    await sleep(closeAfterMs);
  }

  // The host's close().
  child.stdin.end();
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  setTimeout(() => {
    if (child.exitCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  }, 1000).unref();

  await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 5000, label: `${label}: server exit` });
  // Give any app-server spawned during shutdown time to appear, then require all gone.
  await sleep(1500);
  const { starts, grandchildren } = readSpawnLog(spawnLog);
  const pids = [...starts.map((s) => s.pid), ...grandchildren.map((g) => g.pid)];
  await waitFor(() => pids.every((pid) => !alive(pid)), { timeoutMs: 4000, label: `${label}: no app-server outlives the server` })
    .catch(() => {
      for (const pid of pids) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
      assert.fail(`${label}: app-server(s) outlived the server: ${pids.filter(alive).join(", ")}`);
    });
  return starts.length;
}

try {
  const spawned = {};
  for (const [delay, label] of [[0, "immediate"], [50, "50ms"], [300, "300ms"], ["after-spawn", "after-spawn"], [2000, "after-reply"]]) {
    spawned[label] = await chatStyleRun(delay, label);
  }
  assert.ok(spawned["after-spawn"] >= 1, "the after-spawn case really started an app-server");
  console.log(`chat-style close tests passed (app-servers spawned per case: ${JSON.stringify(spawned)})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
