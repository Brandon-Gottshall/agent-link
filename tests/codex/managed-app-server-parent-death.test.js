// A managed app-server must not outlive its Agent Link server, even when the
// server is SIGKILLed or its shutdown stalls past the host's 1 s kill. The
// app-server leads its own process group, so the host's group signals never
// reach it and a killed server runs no code to stop it: it used to survive
// with ppid 1, along with its managed record and socket. The watchdog that
// leads the app-server's group holds a pipe from the server and takes the
// group down when that pipe reaches EOF.
// Uses a stub app-server; never launches Codex.app.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { alive, pluginRoot, readSpawnLog, taggedProcesses, taggedStub, waitFor, waitForExit } from "../helpers/codex-stub.js";
import { hermeticEnv } from "../helpers/env.js";

// Short prefix: the unix socket lives in the state dir only when its path fits
// sun_path, and the test wants to look for it where the server put it.
const tmp = mkdtempSync(path.join(os.tmpdir(), "al-death-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const preload = path.join(pluginRoot, "tests", "fixtures", "stall-shutdown-preload.mjs");

function startServer(name, { stallMs = 0 } = {}) {
  const dir = path.join(tmp, name);
  mkdirSync(dir);
  const stateDir = path.join(dir, "state");
  const spawnLog = path.join(dir, "spawns.log");
  const stub = taggedStub(dir);
  const child = spawn(process.execPath, ["--import", preload, path.join(pluginRoot, "src", "server.js")], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: hermeticEnv({
      home: path.join(dir, "home"),
      overrides: {
        CODEX_AGENT_LINK_APP_SERVER_BIN: stub,
        CODEX_AGENT_LINK_STATE_DIR: stateDir,
        AGENT_LINK_MAILBOX_PATH: path.join(dir, "mailbox.jsonl"),
        AGENT_LINK_STUB_SPAWN_LOG: spawnLog,
        AGENT_LINK_STUB_GRANDCHILD: "1",
        AGENT_LINK_TEST_STALL_MS: stallMs || undefined
      }
    })
  });
  child.stderr.resume();
  let buffer = "";
  const replies = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      try { const msg = JSON.parse(line); if (msg.id !== undefined) replies.set(msg.id, msg); } catch { /* not JSON */ }
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "parent-death", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_loaded_codex_threads", arguments: {} } });

  const records = () => {
    try { return readdirSync(stateDir).filter((file) => file.endsWith(".json")); } catch { return []; }
  };
  // The socket is <server pid>.sock in the state dir, or in a private dir under
  // the temp dir when the state path is too long for a unix socket.
  const sockets = () => [
    path.join(stateDir, `${child.pid}.sock`),
    path.join(os.tmpdir(), `agent-link-${process.getuid?.() ?? "user"}`, `${child.pid}.sock`)
  ].filter((file) => existsSync(file));
  return { child, spawnLog, stub, records, sockets, replies };
}

// Everything a managed app-server could leave running: the stub and its
// grandchild from the spawn log, plus anything carrying this run's stub path.
function appServerPids({ spawnLog, stub }) {
  const { starts, grandchildren } = readSpawnLog(spawnLog);
  let tagged = [];
  try { tagged = taggedProcesses(stub); } catch { /* the spawn log still names them */ }
  return [...new Set([...starts.map((s) => s.pid), ...grandchildren.map((g) => g.pid), ...tagged])];
}

function reap(server) {
  const { child } = server;
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
  for (const pid of appServerPids(server)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
}

async function runningServer(name, options) {
  const server = startServer(name, options);
  await waitFor(() => server.replies.has(2), { timeoutMs: 15000, label: `${name}: tool call reply` });
  assert.ok(server.replies.get(2).result?.isError !== true, "the tool call succeeded, so an app-server is running");
  const { starts, grandchildren } = readSpawnLog(server.spawnLog);
  assert.equal(starts.length, 1, "exactly one app-server started");
  assert.ok(starts.every((s) => alive(s.pid)) && grandchildren.every((g) => alive(g.pid)), "the app-server and its grandchild are running");
  assert.equal(server.records().length, 1, "the managed record is written while it runs");
  assert.equal(server.sockets().length, 1, "the managed socket exists while it runs");
  return server;
}

async function assertNothingLeft(server, label) {
  const pids = appServerPids(server);
  assert.ok(pids.length >= 2, `${label}: the app-server and its grandchild were seen`);
  await waitFor(() => pids.every((pid) => !alive(pid)), { timeoutMs: 6000, label: `${label}: no app-server outlives the server` })
    .catch(() => assert.fail(`${label}: app-server process(es) outlived the server: ${pids.filter(alive).join(", ")}`));
  await waitFor(() => server.records().length === 0 && server.sockets().length === 0, { timeoutMs: 3000, label: `${label}: record and socket removed` })
    .catch(() => assert.fail(`${label}: left behind records=${server.records().join(",")} sockets=${server.sockets().join(",")}`));
}

test("a SIGKILLed server takes its managed app-server, record and socket with it", async () => {
  const server = await runningServer("sigkill");
  try {
    process.kill(-server.child.pid, "SIGKILL");
    const exit = await waitForExit(server.child, 5000);
    assert.equal(exit.signal, "SIGKILL");
    await assertNothingLeft(server, "sigkill");
  } finally {
    reap(server);
  }
});

// The host's close(): stdin end plus SIGTERM to the server's group, then SIGKILL
// 1 s later. The server's handlers are stalled for 5 s, so it never reaches its
// own shutdown (the incident's shape).
test("a server whose shutdown stalls past the host's SIGKILL leaves no app-server behind", async () => {
  const server = await runningServer("stalled", { stallMs: 5000 });
  try {
    server.child.stdin.end();
    process.kill(-server.child.pid, "SIGTERM");
    const killTimer = setTimeout(() => {
      try { process.kill(-server.child.pid, "SIGKILL"); } catch { /* already exited */ }
    }, 1000);
    const exit = await waitForExit(server.child, 8000);
    clearTimeout(killTimer);
    assert.equal(exit.signal, "SIGKILL", "the stalled server was killed by the host, not by its own shutdown");
    await assertNothingLeft(server, "stalled");
  } finally {
    reap(server);
  }
});
