// App-server client correctness: transport (Unix socket in a 0700 dir, or a
// capability-token websocket), server->client requests answered at once,
// bounded notification bookkeeping, a closed client never reconnects, startup
// failures are cached, binary discovery order, and clientInfo.version.
// Uses the stub app-server and in-process fake servers; never launches Codex.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { alive, readSpawnLog, sleep, stubAppServer, waitFor } from "../helpers/codex-stub.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-link-client-"));
const spawnLog = path.join(tmp, "spawns.log");
const argsLog = path.join(tmp, "args.log");
// Short on purpose: Unix socket paths are limited to ~104 bytes.
const stateDir = path.join(tmp, "st");
process.env.CODEX_AGENT_LINK_APP_SERVER_BIN = stubAppServer;
process.env.CODEX_AGENT_LINK_STATE_DIR = stateDir;
process.env.AGENT_LINK_STUB_SPAWN_LOG = spawnLog;
process.env.AGENT_LINK_STUB_ARGS_LOG = argsLog;
for (const name of ["CODEX_AGENT_LINK_URL", "CODEX_APP_SERVER_URL", "CODEX_AGENT_LINK_SOCK", "CODEX_APP_SERVER_SOCK", "CODEX_AGENT_LINK_APP_SERVER_STARTUP_MS", "CODEX_AGENT_LINK_APP_SERVER_TRANSPORT", "CODEX_AGENT_LINK_AUTOSTART", "CODEX_AGENT_LINK_APP_SERVER_IDLE_MS", "CODEX_AGENT_LINK_CODEX_BIN", "CODEX_BIN", "AGENT_LINK_STUB_GRANDCHILD"]) {
  delete process.env[name];
}

const {
  AGENT_LINK_VERSION,
  CodexAppServerClient,
  codexBinaryCandidates,
  describeCodexInstall,
  findCodexBinary
} = await import("../../src/codex/app-server-client.js");
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const lastArgs = () => JSON.parse(readFileSync(argsLog, "utf8").trim().split("\n").at(-1));

// In-process fake app-server listening on a Unix socket; lets a test script
// server->client traffic and see exactly what the client sent.
async function fakeUnixServer(onMessage, dir = tmp) {
  mkdirSync(dir, { recursive: true });
  const socketPath = path.join(dir, `f${Math.random().toString(36).slice(2, 8)}.sock`);
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const received = [];
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      onMessage(msg, socket, received);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    received,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      server.close(() => resolve());
    })
  };
}

try {
  // 17. clientInfo.version comes from package.json; W2A-05 explicit sockets
  // (CODEX_AGENT_LINK_SOCK) really connect over the Unix socket.
  {
    assert.equal(AGENT_LINK_VERSION, pkg.version);
    const fake = await fakeUnixServer((msg, socket) => {
      if (msg.id !== undefined && msg.method === "initialize") {
        socket.send(JSON.stringify({ id: msg.id, result: { userAgent: "fake" } }));
      } else if (msg.id !== undefined) {
        socket.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
      }
    }, path.join(tmp, "a b:c"));
    // A relative path, in a directory whose name has a space and a colon
    // (ws's ws+unix: URL form breaks on both).
    process.env.CODEX_AGENT_LINK_SOCK = path.relative(process.cwd(), fake.socketPath);
    assert.ok(!path.isAbsolute(process.env.CODEX_AGENT_LINK_SOCK));
    const client = new CodexAppServerClient({ idleTimeoutMs: 0 });
    assert.deepEqual(await client.request("thread/loaded/list", {}), { ok: true });
    assert.equal(client.getConnectionSummary().socketPath, fake.socketPath, "explicit socket path is resolved");
    const init = fake.received.find((msg) => msg.method === "initialize");
    assert.equal(init.params.clientInfo.version, pkg.version, "clientInfo.version is the package version");
    assert.notEqual(init.params.clientInfo.version, "0.1.0");
    assert.equal(client.getConnectionSummary().connected, true);
    await client.close();
    await fake.close();
    delete process.env.CODEX_AGENT_LINK_SOCK;
  }

  // P3-05: on an app-server Agent Link manages, server->client requests are
  // answered immediately (approvals declined, everything else refused), so a
  // turn never waits on them.
  {
    process.env.AGENT_LINK_STUB_SERVER_REQUEST = [
      "item/commandExecution/requestApproval",
      "item/permissions/requestApproval",
      "applyPatchApproval",
      "item/tool/requestUserInput"
    ].join(",");
    const client = new CodexAppServerClient({ idleTimeoutMs: 0, killGraceMs: 300, requestTimeoutMs: 3000 });
    const result = await client.request("thread/loaded/list", {});
    const [command, permissions, patch, userInput] = result.serverRequestAnswers;
    assert.deepEqual(command.result, { decision: "decline" });
    assert.deepEqual(permissions.result, { permissions: {} });
    assert.deepEqual(patch.result, { decision: "denied" });
    assert.equal(userInput.error.code, -32601);
    assert.match(userInput.error.message, /item\/tool\/requestUserInput/);
    const summary = client.getConnectionSummary();
    assert.equal(summary.serverRequests.total, 4);
    assert.equal(summary.serverRequests.declined, 3);
    assert.equal(summary.serverRequests.rejected, 1);
    assert.equal(summary.serverRequests.unanswered, 0);
    assert.equal(summary.serverRequests.byMethod["item/commandExecution/requestApproval"], 1);
    await client.close();
    delete process.env.AGENT_LINK_STUB_SERVER_REQUEST;
  }

  // An explicitly configured endpoint (CODEX_AGENT_LINK_SOCK/URL) may be a
  // Desktop app-server whose prompts belong to a human: never answer them.
  // P3-06: notifications are counters plus a capped ring without params.
  {
    const fake = await fakeUnixServer((msg, socket, received) => {
      if (msg.method === "initialize") {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      if (msg.method === "turn/start") {
        for (let i = 0; i < 30; i += 1) {
          socket.send(JSON.stringify({ method: "item/updated", params: { big: "x".repeat(10000) } }));
        }
        socket.send(JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "rm -rf /" } }));
        setTimeout(() => {
          const answered = received.filter((m) => m.id === "approval-1" && !m.method);
          socket.send(JSON.stringify({ id: msg.id, result: { answered: answered.length } }));
        }, 300);
      }
    });
    process.env.CODEX_AGENT_LINK_SOCK = fake.socketPath;
    const client = new CodexAppServerClient({ idleTimeoutMs: 0, requestTimeoutMs: 3000 });
    const result = await client.request("turn/start", {});
    assert.equal(result.answered, 0, "external app-server requests are left for its human client");
    const summary = client.getConnectionSummary();
    assert.equal(summary.serverRequests.total, 1);
    assert.equal(summary.serverRequests.unanswered, 1);
    assert.equal(summary.serverRequests.declined, 0);
    assert.equal(summary.notifications.total, 30);
    assert.equal(summary.notifications.byMethod["item/updated"], 30);
    assert.equal(summary.notifications.recent.length, 20, "notification ring is capped");
    assert.equal(summary.notifications.recent[0].params, undefined, "params are not retained");
    assert.equal(client.lastNotifications, undefined, "unbounded lastNotifications buffer is gone");
    await client.close();
    await fake.close();
    delete process.env.CODEX_AGENT_LINK_SOCK;
  }

  // W2A-05: the managed app-server listens on a Unix socket inside a 0700
  // state dir; no loopback websocket and no port probing.
  {
    const client = new CodexAppServerClient({ idleTimeoutMs: 0, killGraceMs: 300 });
    await client.request("thread/loaded/list", {});
    const args = lastArgs();
    const listen = args[args.indexOf("--listen") + 1];
    assert.match(listen, /^unix:\/\//, "managed app-server listens on a Unix socket");
    assert.ok(!args.some((arg) => String(arg).startsWith("ws://")), "no websocket listener");
    const socketPath = listen.slice("unix://".length);
    assert.equal(path.dirname(socketPath), stateDir, "socket lives in the state dir");
    assert.equal(statSync(stateDir).mode & 0o777, 0o700, "state dir is 0700");
    assert.equal(path.basename(socketPath), `${process.pid}.sock`, "one socket name per server process");
    const summary = client.getConnectionSummary();
    assert.equal(summary.managedTransport, "unix");
    assert.equal(summary.socketPath, socketPath);
    // A respawn (after idle shutdown) reuses the same name rather than adding one.
    await client.releaseIdleConnection();
    await client.request("thread/loaded/list", {});
    assert.equal(client.getConnectionSummary().managedSpawnCount, 2);
    assert.equal(client.getConnectionSummary().socketPath, socketPath);
    await client.close();
    await waitFor(() => {
      try {
        statSync(socketPath);
        return false;
      } catch {
        return true;
      }
    }, { label: "socket removed after close" });
  }

  // A state dir that is a symlink is refused, even one pointing at a directory
  // this user owns.
  {
    const realDir = path.join(tmp, "real-state");
    mkdirSync(realDir, { recursive: true, mode: 0o700 });
    const linkDir = path.join(tmp, "link-state");
    symlinkSync(realDir, linkDir);
    const client = new CodexAppServerClient({ idleTimeoutMs: 0, killGraceMs: 300, stateDir: linkDir, startupFailureCacheMs: 0 });
    await assert.rejects(client.request("thread/loaded/list", {}), (error) => error.code === "state-dir-unsafe");
    await client.close();
  }

  // An over-long state dir path falls back to a private temp dir, not a
  // truncated socket path.
  {
    const longStateDir = path.join(tmp, "x".repeat(90));
    const client = new CodexAppServerClient({ idleTimeoutMs: 0, killGraceMs: 300, stateDir: longStateDir });
    await client.request("thread/loaded/list", {});
    const socketPath = client.getConnectionSummary().socketPath;
    assert.ok(Buffer.byteLength(socketPath) <= 100, socketPath);
    assert.equal(statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
    await client.close();
  }

  // W2A-05 fallback: capability-token websocket; the token file is 0600 and a
  // connection without the bearer token is refused by the (emulated) server.
  {
    const client = new CodexAppServerClient({ idleTimeoutMs: 0, killGraceMs: 300, transport: "ws-token" });
    await client.request("thread/loaded/list", {});
    const args = lastArgs();
    assert.equal(args[args.indexOf("--ws-auth") + 1], "capability-token");
    const tokenFile = args[args.indexOf("--ws-token-file") + 1];
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    const summary = client.getConnectionSummary();
    assert.equal(summary.managedTransport, "ws-token");
    assert.equal(JSON.stringify(summary).includes(readFileSync(tokenFile, "utf8")), false, "token never appears in the summary");
    const { default: WebSocket } = await import("ws");
    const status = await new Promise((resolve) => {
      const probe = new WebSocket(summary.url);
      probe.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      probe.on("open", () => resolve("open"));
      probe.on("error", () => resolve("error"));
    });
    assert.equal(status, 401, "unauthenticated websocket is refused");
    await client.close();
  }

  // P3-07: a client closed while connecting never finishes the connect, never
  // respawns, and rejects new requests without touching the app-server.
  {
    process.env.AGENT_LINK_STUB_GRANDCHILD = "1";
    // The stub never listens, so the client is guaranteed to still be starting.
    process.env.AGENT_LINK_STUB_NO_READY = "1";
    const before = readSpawnLog(spawnLog).starts.length;
    const client = new CodexAppServerClient({ idleTimeoutMs: 0, killGraceMs: 300 });
    // Settle into a value right away so the rejection is never "unhandled"
    // while close() is awaiting the process-group shutdown.
    const inflight = client.request("thread/loaded/list", {}).then(() => null, (error) => error);
    const beforeGrandchildren = readSpawnLog(spawnLog).grandchildren.length;
    // Close once the stub is up (and has started its grandchild) but before
    // the client has finished connecting.
    await waitFor(() => readSpawnLog(spawnLog).grandchildren.length > beforeGrandchildren, { label: "spawn started" });
    await client.close();
    const inflightError = await inflight;
    assert.ok(inflightError, "in-flight request does not succeed after close");
    assert.equal(inflightError.code, "client-closed", inflightError.message);
    await assert.rejects(client.request("thread/loaded/list", {}), (error) => error.code === "client-closed");
    await sleep(500);
    const { starts, grandchildren } = readSpawnLog(spawnLog);
    assert.equal(starts.length, before + 1, "no respawn after close");
    await waitFor(() => !alive(starts.at(-1).pid) && !alive(grandchildren.at(-1).pid), { timeoutMs: 3000, label: "closed client left nothing running" });
    delete process.env.AGENT_LINK_STUB_GRANDCHILD;
    delete process.env.AGENT_LINK_STUB_NO_READY;
  }

  // W2C-07: startup failures are cached, so a broken Codex costs one startup,
  // not one per tool call. CODEX_AGENT_LINK_APP_SERVER_STARTUP_MS overrides the
  // readiness timeout.
  {
    process.env.AGENT_LINK_STUB_EXIT_AT_START = "3";
    const before = readSpawnLog(spawnLog).starts.length;
    const client = new CodexAppServerClient({ idleTimeoutMs: 0, killGraceMs: 300 });
    await assert.rejects(client.request("thread/loaded/list", {}), (error) => error.code === "app-server-exited-during-startup");
    const started = Date.now();
    await assert.rejects(client.request("thread/loaded/list", {}), (error) => {
      assert.equal(error.code, "startup-failure-cached");
      assert.equal(error.details.cachedCode, "app-server-exited-during-startup");
      assert.ok(error.details.retryAfterMs > 0);
      return true;
    });
    assert.ok(Date.now() - started < 200, "cached failure returns immediately");
    assert.equal(readSpawnLog(spawnLog).starts.length, before + 1, "cached failure does not respawn");
    assert.equal(client.getConnectionSummary().startupFailure.code, "app-server-exited-during-startup");
    await client.close();
    delete process.env.AGENT_LINK_STUB_EXIT_AT_START;

    const retry = new CodexAppServerClient({ idleTimeoutMs: 0, killGraceMs: 300, startupFailureCacheMs: 1 });
    process.env.AGENT_LINK_STUB_EXIT_AT_START = "3";
    await assert.rejects(retry.request("thread/loaded/list", {}));
    delete process.env.AGENT_LINK_STUB_EXIT_AT_START;
    await sleep(5);
    await retry.request("thread/loaded/list", {});
    assert.equal(retry.getConnectionSummary().startupFailure, null, "expired failure is retried and cleared");
    await retry.close();

    process.env.CODEX_AGENT_LINK_APP_SERVER_STARTUP_MS = "400";
    process.env.AGENT_LINK_STUB_NO_READY = "1";
    const slow = new CodexAppServerClient({ idleTimeoutMs: 0, killGraceMs: 300 });
    assert.equal(slow.options.startupTimeoutMs, 400);
    const t0 = Date.now();
    await assert.rejects(slow.request("thread/loaded/list", {}), (error) => error.code === "readiness-timeout");
    assert.ok(Date.now() - t0 < 3000, "startup timeout env override is honoured");
    await slow.close();
    delete process.env.CODEX_AGENT_LINK_APP_SERVER_STARTUP_MS;
    delete process.env.AGENT_LINK_STUB_NO_READY;
  }

  // W2C-05: a missing binary is a specific, cached error with what was searched.
  {
    delete process.env.CODEX_AGENT_LINK_APP_SERVER_BIN;
    process.env.CODEX_AGENT_LINK_CODEX_BIN = path.join(tmp, "missing", "codex");
    const client = new CodexAppServerClient({ idleTimeoutMs: 0 });
    await assert.rejects(client.request("thread/loaded/list", {}), (error) => {
      assert.equal(error.code, "codex-binary-not-found");
      assert.ok(error.details.searched.includes(process.env.CODEX_AGENT_LINK_CODEX_BIN));
      return true;
    });
    const install = describeCodexInstall();
    assert.equal(install.available, false);
    assert.match(install.reason, /CODEX_AGENT_LINK_CODEX_BIN/);
    await client.close();
    delete process.env.CODEX_AGENT_LINK_CODEX_BIN;
    process.env.CODEX_AGENT_LINK_APP_SERVER_BIN = stubAppServer;
  }

  // W2C-06 / P3-10: discovery order env -> app bundles (ChatGPT.app first) ->
  // PATH -> well-known dirs, from one install layout.
  {
    const root = path.join(tmp, "layout");
    const makeExe = (file) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "#!/bin/sh\necho codex-cli 9.9.9\n");
      chmodSync(file, 0o755);
      return file;
    };
    const apps = path.join(root, "Applications");
    const pathDir = path.join(root, "path-bin");
    const wellKnown = path.join(root, "well-known");
    const options = { env: {}, applicationDirs: [apps], pathDirs: [pathDir], wellKnownDirs: [wellKnown], platform: "darwin" };
    assert.equal(findCodexBinary(options).found, false);
    assert.match(findCodexBinary(options).reason, /No Codex binary/);

    const wellKnownBin = makeExe(path.join(wellKnown, "codex"));
    assert.equal(findCodexBinary(options).path, wellKnownBin);
    const pathBin = makeExe(path.join(pathDir, "codex"));
    assert.equal(findCodexBinary(options).path, pathBin, "PATH beats well-known dirs");
    assert.equal(findCodexBinary(options).source, "PATH");
    const staleDesktop = makeExe(path.join(apps, "Codex.app", "Contents", "Resources", "codex"));
    assert.equal(findCodexBinary(options).path, staleDesktop, "app bundle beats PATH");
    const chatgpt = makeExe(path.join(apps, "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"));
    assert.equal(findCodexBinary(options).path, chatgpt, "ChatGPT.app beats Codex.app");
    assert.equal(findCodexBinary(options).source, "app:ChatGPT.app");
    const explicit = makeExe(path.join(root, "explicit", "codex"));
    assert.equal(findCodexBinary({ ...options, env: { CODEX_AGENT_LINK_CODEX_BIN: explicit } }).path, explicit, "env wins");
    assert.equal(findCodexBinary({ ...options, env: { CODEX_BIN: "codex" } }).path, pathBin, "bare env name resolves on PATH");
    const order = codexBinaryCandidates({ ...options, env: { CODEX_BIN: explicit } });
    assert.deepEqual(order, [explicit, chatgpt, path.join(apps, "ChatGPT.app", "Contents", "Resources", "codex"), staleDesktop, pathBin, wellKnownBin]);
  }

  console.log("app-server client tests passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
