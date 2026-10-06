#!/usr/bin/env node
// Measure managed app-server churn and idle CPU of one agent-link MCP server.
// Uses the stub app-server (tests/fixtures/stub-codex-app-server.js); never
// launches Codex.app.
//
//   node scripts/idle-churn-measure.js [--idle-seconds 120] [--plugin-root DIR]
//        [--real-home] [--session-id ID]
//
// --plugin-root lets you measure another build (e.g. the installed 0.2.2 copy)
// with the same harness. --real-home keeps HOME so the Claude channel bridge
// indexes the real session corpus (read-only; the mailbox is always a temp
// file so no real message is consumed).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const selfRoot = path.resolve(here, "..");
const stub = path.join(selfRoot, "tests", "fixtures", "stub-codex-app-server.js");

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
  const home = realHome ? os.homedir() : path.join(tmp, "home");
  if (!realHome) mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CODE_SESSION_ID: sessionId,
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    AGENT_LINK_MAILBOX_PATH: path.join(tmp, "mailbox.jsonl"),
    CODEX_AGENT_LINK_APP_SERVER_BIN: stub,
    CODEX_AGENT_LINK_STATE_DIR: path.join(tmp, "state"),
    CODEX_HOME: path.join(tmp, "codex-home"),
    AGENT_LINK_STUB_SPAWN_LOG: spawnLog,
    AGENT_LINK_STUB_GRANDCHILD: "1",
    ...extraEnv
  };
  const { readSpawnLog, alive, waitFor, sleep } = await import(path.join(selfRoot, "tests", "codex", "test-helpers.js"));

  const server = spawn(process.execPath, [path.join(pluginRoot, "src", "server.js")], {
    cwd: pluginRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const rpc = makeRpc(server);
  const exited = new Promise((resolve) => server.once("exit", (code, signal) => resolve({ code, signal })));

  try {
    await rpc.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "idle-churn-measure", version: "1.0.0" }
    });
    rpc.notify("notifications/initialized", {});

    const cpu0 = cpuSeconds(server.pid);
    const t0 = Date.now();
    await sleep(idleSeconds * 1000);
    const idleWallSeconds = (Date.now() - t0) / 1000;
    const idleCpuSeconds = cpuSeconds(server.pid) - cpu0;
    const spawnsDuringIdle = readSpawnLog(spawnLog).starts.length;

    const first = await rpc.call("tools/call", { name: "agent_link_health", arguments: {} });
    const spawnsAfterFirstCall = readSpawnLog(spawnLog).starts.length;
    await rpc.call("tools/call", { name: "list_loaded_codex_threads", arguments: {} });
    await rpc.call("tools/call", { name: "agent_link_health", arguments: {} });
    const spawnsAfterThreeCalls = readSpawnLog(spawnLog).starts.length;
    const { starts, grandchildren } = readSpawnLog(spawnLog);

    if (shutdown === "sigterm") {
      server.kill("SIGTERM");
    } else if (shutdown === "sighup") {
      server.kill("SIGHUP");
    } else {
      server.stdin.end();
    }
    const exit = await Promise.race([exited, sleep(8000).then(() => ({ timeout: true }))]);
    let childrenGone = false;
    try {
      await waitFor(() => [...starts, ...grandchildren].every((p) => !alive(p.pid)), { timeoutMs: 5000, label: "children exit" });
      childrenGone = true;
    } catch {
      childrenGone = false;
    }
    const survivors = [...starts, ...grandchildren].filter((p) => alive(p.pid)).map((p) => p.pid);
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
    for (const p of [...readSpawnLog(spawnLog).starts, ...readSpawnLog(spawnLog).grandchildren]) {
      try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ }
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
        const { resolve, reject } = pending.get(msg.id);
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
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`timeout waiting for ${method}`));
          }
        }, 30000).unref();
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const result = await measure({
    idleSeconds: Number(opt("--idle-seconds", "120")),
    pluginRoot: path.resolve(opt("--plugin-root", selfRoot)),
    realHome: args.includes("--real-home"),
    sessionId: opt("--session-id", undefined),
    shutdown: opt("--shutdown", "stdin")
  });
  console.log(JSON.stringify(result, null, 2));
}
