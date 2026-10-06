// Measure managed app-server churn and idle CPU of one agent-link MCP server
// driven over MCP stdio. Uses the stub app-server; never launches Codex.app.
// Used by tests/codex/server-idle-churn.test.js and the
// scripts/idle-churn-measure.js CLI.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { alive, pluginRoot as selfRoot, readSpawnLog, sleep, taggedProcesses, taggedStub, waitFor, waitForExit } from "./codex-stub.js";
import { hermeticEnv } from "./env.js";

export async function measure({
  idleSeconds = 120,
  pluginRoot = selfRoot,
  realHome = false,
  sessionId = "00000000-0000-4000-8000-000000000000",
  shutdown = "stdin",
  extraEnv = {}
} = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-link-idle-measure-"));
  const spawnLog = path.join(tmp, "spawns.log");
  const stub = taggedStub(tmp);
  const home = realHome ? os.homedir() : path.join(tmp, "home");
  if (!realHome) mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  const env = hermeticEnv({
    home,
    codexHome: path.join(tmp, "codex-home"),
    overrides: {
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
      AGENT_LINK_MAILBOX_PATH: path.join(tmp, "mailbox.jsonl"),
      CODEX_AGENT_LINK_APP_SERVER_BIN: stub,
      CODEX_AGENT_LINK_STATE_DIR: path.join(tmp, "state"),
      AGENT_LINK_STUB_SPAWN_LOG: spawnLog,
      AGENT_LINK_STUB_GRANDCHILD: "1",
      ...extraEnv
    }
  });

  const server = spawn(process.execPath, [path.join(pluginRoot, "src", "server.js")], {
    cwd: pluginRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const rpc = makeRpc(server);
  const runPids = () => {
    const { starts, grandchildren } = readSpawnLog(spawnLog);
    return [...new Set([...starts.map((p) => p.pid), ...grandchildren.map((p) => p.pid), ...taggedProcesses(stub)])];
  };

  try {
    await rpc.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "idle-churn-measure", version: "1.0.0" }
    });
    rpc.notify("notifications/initialized", {});

    // The idle window is the observation itself: nothing may spawn in it.
    const cpu0 = cpuSeconds(server.pid);
    const t0 = Date.now();
    await sleep(idleSeconds * 1000);
    const idleWallSeconds = (Date.now() - t0) / 1000;
    const idleCpuSeconds = cpuSeconds(server.pid) - cpu0;
    const spawnsDuringIdle = readSpawnLog(spawnLog).starts.length + taggedProcesses(stub).length;

    // Each tool call that needs the app-server returns only after it answered,
    // so the stub's spawn-log line exists by the time the reply arrives.
    const first = await rpc.call("tools/call", { name: "agent_link_health", arguments: {} });
    const spawnsAfterFirstCall = readSpawnLog(spawnLog).starts.length;
    await rpc.call("tools/call", { name: "list_loaded_codex_threads", arguments: {} });
    await rpc.call("tools/call", { name: "agent_link_health", arguments: {} });
    const spawnsAfterThreeCalls = readSpawnLog(spawnLog).starts.length;
    const tracked = runPids();

    if (shutdown === "sigterm") {
      server.kill("SIGTERM");
    } else if (shutdown === "sighup") {
      server.kill("SIGHUP");
    } else {
      server.stdin.end();
    }
    const exit = await waitForExit(server, 8000);
    // Once the server has exited it can spawn nothing more, so the set of
    // processes to check is final: everything logged or tagged for this run.
    const pids = [...new Set([...tracked, ...runPids()])];
    let childrenGone = false;
    try {
      await waitFor(() => pids.every((pid) => !alive(pid)), { timeoutMs: 5000, label: "children exit" });
      childrenGone = true;
    } catch {
      childrenGone = false;
    }
    const survivors = pids.filter(alive);
    return {
      pluginRoot,
      realHome,
      idleSeconds,
      idleWallSeconds,
      idleCpuSeconds: Number(idleCpuSeconds.toFixed(3)),
      idleCpuPercent: Number(((idleCpuSeconds / idleWallSeconds) * 100).toFixed(2)),
      spawnsDuringIdle,
      spawnsAfterFirstCall,
      spawnsAfterThreeCalls,
      firstCallIsError: first?.isError === true,
      shutdown,
      serverExit: exit,
      childrenGoneAfterShutdown: childrenGone,
      survivorPids: survivors,
      stderrTail: stderr.slice(-400)
    };
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    // Never leave stub processes behind, even if an assertion path failed.
    for (const pid of runPids()) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

function cpuSeconds(pid) {
  // macOS/BSD ps: cumulative CPU time as [[dd-]hh:]mm:ss.cc
  const raw = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const [clock, days] = raw.includes("-") ? [raw.split("-")[1], Number(raw.split("-")[0])] : [raw, 0];
  const parts = clock.split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds + days * 86400;
}

function makeRpc(child) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    }
  });
  return {
    call(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`timeout waiting for ${method}`));
          }
        }, 30000);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    }
  };
}
