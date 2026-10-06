import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
// A managed app-server is expensive (70-80% of a core while it boots, plus
// steady RSS). Keep it only while it is being used: after this long with no
// in-flight request it is shut down, and the next real tool call starts a
// fresh one. Override with CODEX_AGENT_LINK_APP_SERVER_IDLE_MS (0 disables).
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 1500;

export class AppServerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AppServerError";
    this.details = details;
  }
}

export function managedAppServerStateDir() {
  return process.env.CODEX_AGENT_LINK_STATE_DIR
    || path.join(os.homedir(), ".claude", "agent-link", "managed-app-servers");
}

function envIdleTimeoutMs() {
  const raw = process.env.CODEX_AGENT_LINK_APP_SERVER_IDLE_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS;
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.options = {
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      autoStart: process.env.CODEX_AGENT_LINK_AUTOSTART !== "0",
      idleTimeoutMs: envIdleTimeoutMs(),
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      stateDir: null,
      ...options
    };
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.managedProcess = null;
    this.managedUrl = null;
    this.managedLaunch = null;
    this.lastNotifications = [];
    this.connectionInfo = null;
    this.managedProcessExitCleanup = null;
    this.managedRecordPath = null;
    this.managedSpawnCount = 0;
    this.connectPromise = null;
    this.managedStartPromise = null;
    this.activeRequests = 0;
    this.idleTimer = null;
    this.idleShutdowns = 0;
    this.reapedOrphans = false;
    this.closed = false;
  }

  async request(method, params = {}) {
    this.clearIdleTimer();
    this.activeRequests += 1;
    try {
      await this.ensureConnected();

      const id = `agent-link-${this.nextId++}`;
      const payload = { id, method, params };

      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new AppServerError(`Timed out waiting for ${method}`, { method }));
        }, this.options.requestTimeoutMs);

        this.pending.set(id, { resolve, reject, timeout, method });
        this.ws.send(JSON.stringify(payload), (error) => {
          if (!error) {
            return;
          }
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(new AppServerError(`Failed to send ${method}: ${error.message}`, { method }));
        });
      });
    } finally {
      this.activeRequests -= 1;
      this.scheduleIdleShutdown();
    }
  }

  async ensureConnected() {
    if (this.ws?.readyState === WebSocket.OPEN && this.initialized) {
      return;
    }

    // Single-flight: concurrent tool calls share one connect (and therefore at
    // most one managed app-server spawn). Without this, two calls racing
    // through resolveTarget() each spawned an app-server and the first child
    // handle was overwritten and never killed.
    if (!this.connectPromise) {
      this.connectPromise = this.connect().finally(() => {
        this.connectPromise = null;
      });
    }
    await this.connectPromise;
  }

  async connect() {
    const target = await this.resolveTarget();
    const previous = this.ws;
    if (previous && previous.readyState !== WebSocket.CLOSED) {
      previous.terminate();
    }
    const ws = target.socketPath
      ? new WebSocket("ws://localhost/", { socketPath: target.socketPath })
      : new WebSocket(target.url);

    this.ws = ws;
    this.initialized = false;
    this.connectionInfo = target;

    ws.on("message", (raw) => this.handleMessage(raw));
    ws.on("close", () => {
      if (this.ws === ws) {
        this.failAllPending("Codex app-server websocket closed");
      }
    });
    ws.on("error", (error) => {
      if (this.ws === ws) {
        this.failAllPending(`Codex app-server websocket error: ${error.message}`);
      }
    });

    try {
      await waitForOpen(ws, this.options.requestTimeoutMs);
      await this.initialize();
    } catch (error) {
      if (this.ws === ws) {
        ws.terminate();
      }
      throw error;
    }
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  scheduleIdleShutdown() {
    this.clearIdleTimer();
    const idleMs = this.options.idleTimeoutMs;
    if (!(idleMs > 0) || this.closed) {
      return;
    }
    if (this.activeRequests > 0 || this.pending.size > 0) {
      return;
    }
    if (!this.managedProcess && !this.ws) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeRequests > 0 || this.pending.size > 0 || this.connectPromise) {
        return;
      }
      this.releaseIdleConnection().catch((error) => {
        process.stderr.write(`agent-link: idle app-server shutdown failed: ${error.message}\n`);
      });
    }, idleMs);
    this.idleTimer.unref?.();
  }

  // Drop the websocket and stop the managed app-server after an idle period.
  // The client stays usable: the next request reconnects (and, for a managed
  // target, starts one new app-server).
  async releaseIdleConnection() {
    this.idleShutdowns += 1;
    this.closeSocket();
    await this.stopManagedAppServer();
  }

  closeSocket() {
    const ws = this.ws;
    this.ws = null;
    this.initialized = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    } else if (ws && ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  }

  async initialize() {
    const id = `agent-link-${this.nextId++}`;
    const params = {
      clientInfo: {
        name: "codex-agent-link",
        title: "Codex Agent Link",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    };

    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError("Timed out during app-server initialize"));
      }, this.options.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout, method: "initialize" });
      this.ws.send(JSON.stringify({ id, method: "initialize", params }), (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new AppServerError(`Failed to initialize app-server: ${error.message}`));
      });
    });

    this.initialized = true;
    this.ws.send(JSON.stringify({ method: "initialized", params: {} }));
    this.connectionInfo = {
      ...this.connectionInfo,
      initialized: true,
      userAgent: result.userAgent,
      codexHome: result.codexHome,
      platformOs: result.platformOs
    };
    return result;
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      this.lastNotifications.push({
        method: "parse-error",
        params: { error: error.message, raw: raw.toString() }
      });
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(new AppServerError(message.error.message, {
          method: pending.method,
          code: message.error.code,
          data: message.error.data
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.lastNotifications.push({
        method: message.method,
        params: message.params ?? null,
        receivedAt: new Date().toISOString()
      });
      if (this.lastNotifications.length > 100) {
        this.lastNotifications.shift();
      }
    }
  }

  failAllPending(message) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new AppServerError(message, { method: pending.method }));
      this.pending.delete(id);
    }
    this.initialized = false;
  }

  async resolveTarget() {
    const explicitUrl = process.env.CODEX_AGENT_LINK_URL || process.env.CODEX_APP_SERVER_URL;
    if (explicitUrl) {
      return { kind: "url", url: explicitUrl, managed: false };
    }

    const explicitSocket = process.env.CODEX_AGENT_LINK_SOCK || process.env.CODEX_APP_SERVER_SOCK;
    if (explicitSocket) {
      return { kind: "socket", socketPath: explicitSocket, managed: false };
    }

    if (!this.options.autoStart) {
      throw new AppServerError(
        "No Codex app-server endpoint is configured. Set CODEX_AGENT_LINK_URL, CODEX_APP_SERVER_URL, CODEX_AGENT_LINK_SOCK, or enable CODEX_AGENT_LINK_AUTOSTART."
      );
    }

    if (this.closed) {
      throw new AppServerError("Codex app-server client is closed; not starting a managed app-server");
    }

    if (!this.managedUrl) {
      if (!this.managedStartPromise) {
        this.managedStartPromise = this.startManagedAppServer().finally(() => {
          this.managedStartPromise = null;
        });
      }
      await this.managedStartPromise;
    }
    return { kind: "managed", url: this.managedUrl, managed: true };
  }

  stateDir() {
    return this.options.stateDir || managedAppServerStateDir();
  }

  async startManagedAppServer() {
    if (!this.reapedOrphans) {
      this.reapedOrphans = true;
      try {
        reapOrphanedManagedAppServers({ stateDir: this.stateDir() });
      } catch {
        // Best effort only; never block a real tool call on orphan cleanup.
      }
    }

    const port = await getFreePort();
    const url = `ws://127.0.0.1:${port}`;
    const launch = findAppServerLaunch();

    // detached: the app-server leads its own process group, so shutdown can
    // signal the whole group (app-server plus anything it launches) instead of
    // only the direct child.
    const child = spawn(launch.command, [...launch.args, "--listen", url], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Agent Link"
      }
    });
    this.managedSpawnCount += 1;
    this.managedLaunch = launch;
    this.managedProcess = child;

    const logs = [];
    const remember = (chunk) => {
      logs.push(chunk.toString());
      if (logs.length > 20) {
        logs.shift();
      }
    };
    child.stdout.on("data", remember);
    child.stderr.on("data", remember);
    let spawnError = null;
    child.on("error", (error) => {
      spawnError = error;
      remember(`spawn error: ${error.message}\n`);
    });

    child.on("exit", (code, signal) => {
      removeManagedRecord(child.__agentLinkRecordPath);
      if (this.managedProcess !== child) {
        return;
      }
      if (this.managedProcessExitCleanup) {
        process.removeListener("exit", this.managedProcessExitCleanup);
        this.managedProcessExitCleanup = null;
      }
      this.managedUrl = null;
      this.managedProcess = null;
      this.managedLaunch = null;
      this.managedRecordPath = null;
      this.failAllPending(`Managed Codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
    });
    this.managedProcessExitCleanup = () => {
      signalProcessGroup(child, "SIGTERM");
    };
    process.once("exit", this.managedProcessExitCleanup);

    if (child.pid) {
      child.__agentLinkRecordPath = writeManagedRecord(this.stateDir(), {
        ownerPid: process.pid,
        pid: child.pid,
        pgid: child.pid,
        url,
        command: launch.command,
        startedAt: new Date().toISOString()
      });
      this.managedRecordPath = child.__agentLinkRecordPath;
    }

    try {
      await waitForReady(`http://127.0.0.1:${port}/readyz`, this.options.startupTimeoutMs, () => {
        if (spawnError) {
          return spawnError;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          return new Error(`app-server exited during startup (code ${child.exitCode ?? "null"} signal ${child.signalCode ?? "null"})`);
        }
        return null;
      });
    } catch (error) {
      await this.stopManagedAppServer(child);
      throw new AppServerError("Managed Codex app-server did not become ready", {
        cause: error.message,
        logs: logs.join("")
      });
    }

    if (this.managedProcess !== child) {
      throw new AppServerError("Managed Codex app-server was stopped during startup");
    }
    this.managedUrl = url;
    return url;
  }

  // Stop the managed app-server's whole process group: SIGTERM, bounded wait,
  // then SIGKILL for the leader and any group members left behind.
  async stopManagedAppServer(child = this.managedProcess) {
    if (!child) {
      return;
    }
    if (this.managedProcess === child) {
      if (this.managedProcessExitCleanup) {
        process.removeListener("exit", this.managedProcessExitCleanup);
        this.managedProcessExitCleanup = null;
      }
      this.managedProcess = null;
      this.managedUrl = null;
      this.managedLaunch = null;
      this.managedRecordPath = null;
    }
    const graceMs = this.options.killGraceMs;
    if (child.exitCode === null && child.signalCode === null) {
      signalProcessGroup(child, "SIGTERM");
      let exited = await waitForProcessExit(child, graceMs);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        signalProcessGroup(child, "SIGKILL");
        exited = await waitForProcessExit(child, 1000);
      }
    }
    if (child.pid && processGroupAlive(child.pid)) {
      await sleep(Math.min(250, graceMs));
      if (processGroupAlive(child.pid)) {
        signalProcessGroup(child, "SIGKILL", { groupOnly: true });
      }
    }
    removeManagedRecord(child.__agentLinkRecordPath);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }

  // Synchronous last-resort cleanup for process "exit" handlers, where no
  // awaiting is possible.
  killManagedSync(signal = "SIGTERM") {
    const child = this.managedProcess;
    if (!child) {
      return;
    }
    signalProcessGroup(child, signal);
  }

  getConnectionSummary() {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN && this.initialized,
      ...this.connectionInfo,
      managedPid: this.managedProcess?.pid ?? null,
      managedLaunch: this.managedLaunch ?? null,
      managedSpawnCount: this.managedSpawnCount,
      idleTimeoutMs: this.options.idleTimeoutMs,
      idleShutdowns: this.idleShutdowns,
      notificationsBuffered: this.lastNotifications.length
    };
  }

  async close() {
    this.closed = true;
    this.clearIdleTimer();
    this.failAllPending("Codex app-server client closed");
    this.closeSocket();
    const starting = this.managedStartPromise;
    await this.stopManagedAppServer();
    if (starting) {
      // A spawn in flight when close() was called stops itself once it sees
      // it is no longer the current managed process; wait for it to settle.
      await starting.catch(() => {});
    }
  }
}

export function signalProcessGroup(child, signal, { groupOnly = false } = {}) {
  const pid = typeof child === "number" ? child : child?.pid;
  if (!pid) {
    return false;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    if (groupOnly) {
      return false;
    }
    try {
      if (typeof child === "number") {
        process.kill(pid, signal);
      } else {
        child.kill(signal);
      }
      return true;
    } catch {
      return false;
    }
  }
}

function processGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function writeManagedRecord(stateDir, record) {
  try {
    mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, `${record.pid}.json`);
    writeFileSync(file, `${JSON.stringify(record)}\n`);
    return file;
  } catch {
    return null;
  }
}

function removeManagedRecord(file) {
  if (!file) {
    return;
  }
  try {
    rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

// Kill managed app-servers left behind by an agent-link server that died
// without cleanup (SIGKILL, crash). Each spawn writes <stateDir>/<pid>.json;
// a record is acted on only when its owner is gone AND the recorded pid is
// still running an app-server command listening on the recorded URL, so a
// reused pid is never signalled.
export function reapOrphanedManagedAppServers({ stateDir = managedAppServerStateDir(), graceMs = 2000 } = {}) {
  const result = { reaped: [], removed: [], kept: [] };
  let entries;
  try {
    entries = readdirSync(stateDir);
  } catch {
    return result;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const file = path.join(stateDir, name);
    let record;
    try {
      record = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      removeManagedRecord(file);
      result.removed.push({ file, reason: "unreadable" });
      continue;
    }
    const pid = Number(record?.pid);
    const ownerPid = Number(record?.ownerPid);
    if (!Number.isInteger(pid) || pid <= 1) {
      removeManagedRecord(file);
      result.removed.push({ file, reason: "invalid" });
      continue;
    }
    if (Number.isInteger(ownerPid) && ownerPid > 1 && pidIsAlive(ownerPid)) {
      result.kept.push({ file, pid, ownerPid });
      continue;
    }
    if (!pidIsAlive(pid)) {
      removeManagedRecord(file);
      result.removed.push({ file, pid, reason: "not-running" });
      continue;
    }
    const command = processCommand(pid);
    if (!command.includes("app-server") || typeof record.url !== "string" || !command.includes(record.url)) {
      removeManagedRecord(file);
      result.removed.push({ file, pid, reason: "pid-reused" });
      continue;
    }
    const pgid = Number(record.pgid) || pid;
    signalProcessGroup(pgid, "SIGTERM");
    const escalate = setTimeout(() => {
      if (pidIsAlive(pid) && processCommand(pid).includes(record.url)) {
        signalProcessGroup(pgid, "SIGKILL");
      }
    }, graceMs);
    escalate.unref?.();
    removeManagedRecord(file);
    result.reaped.push({ pid, pgid, url: record.url, ownerPid });
  }
  return result;
}

export function asUserTextInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

export function codexBinaryCandidates() {
  return [
    process.env.CODEX_AGENT_LINK_CODEX_BIN,
    process.env.CODEX_BIN,
    // The live Codex Desktop ships inside ChatGPT.app; /Applications/Codex.app can be a stale
    // older copy whose app-server rejects current models (threads end in systemError at once)
    // and cannot resume threads written by newer Codex versions.
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "codex"
  ].filter(Boolean);
}

export function findCodexBinary() {
  const candidates = codexBinaryCandidates();

  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) {
      continue;
    }
    return candidate;
  }
  return "codex";
}

export function findAppServerLaunch() {
  const appServerBin = process.env.CODEX_AGENT_LINK_APP_SERVER_BIN || process.env.CODEX_APP_SERVER_BIN;
  if (appServerBin) {
    if (appServerBin.includes("/") && !existsSync(appServerBin)) {
      throw new AppServerError(`Configured Codex app-server binary does not exist: ${appServerBin}`);
    }
    return {
      kind: "app-server-bin",
      command: appServerBin,
      args: []
    };
  }

  return {
    kind: "codex-bin",
    command: findCodexBinary(),
    args: ["app-server"]
  };
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommand(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 1000
  });
  if (result.status !== 0 || result.error) {
    return "";
  }
  return result.stdout.trim();
}

async function waitForOpen(ws, timeoutMs) {
  if (ws.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new AppServerError("Timed out opening Codex app-server websocket"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(new AppServerError(`Codex app-server websocket failed: ${error.message}`));
    };

    ws.on("open", onOpen);
    ws.on("error", onError);
  });
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForReady(url, timeoutMs, checkAbort = () => null) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    const abort = checkAbort();
    if (abort) {
      throw abort;
    }
    try {
      const status = await httpGetStatus(url);
      if (status >= 200 && status < 300) {
        return;
      }
      lastError = new Error(`readyz returned HTTP ${status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }

  throw lastError ?? new Error("readyz timed out");
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function httpGetStatus(url) {
  return await new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.setTimeout(1000, () => {
      req.destroy(new Error("HTTP request timed out"));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
