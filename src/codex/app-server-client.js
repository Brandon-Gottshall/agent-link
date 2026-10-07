import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import {
  codexBinaryCandidateEntries,
  codexBinaryVersion,
  discoverCodexBinary
} from "./install-layout.js";
import { env, envFlag, envValue } from "../shared/env.js";
import { AgentLinkError } from "../shared/errors.js";
import { getLogger } from "../shared/log.js";
import { legacyManagedAppServerDirs, managedAppServerDir, stateDir as agentLinkStateDir } from "../shared/paths.js";
import { ensureStateDir } from "../shared/state.js";

/**
 * A spawned app-server tagged with what exit and stop cleanup must remove.
 * @typedef {import("node:child_process").ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable> & {
 *   __agentLinkEndpoint?: any,
 *   __agentLinkRecordPath?: string | null
 * }} ManagedChildProcess
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
// A managed app-server is expensive (70-80% of a core while it boots, plus
// steady RSS). Keep it only while it is being used: after this long with no
// in-flight request it is shut down, and the next real tool call starts a
// fresh one. Override with AGENT_LINK_CODEX_IDLE_MS (0 disables).
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 1500;
// A Codex binary that hangs or crashes at startup would otherwise cost every
// Codex tool call a full startup timeout. Remember the failure for this long.
const DEFAULT_STARTUP_FAILURE_CACHE_MS = 60 * 1000;
// sun_path is 104 bytes on macOS and 108 on Linux, including the NUL.
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const RECENT_NOTIFICATIONS = 20;
const MAX_TRACKED_METHODS = 64;

// Same source as the MCP server's own version: scripts/build.mjs defines
// __AGENT_LINK_VERSION__ from package.json when it bundles dist/server.mjs.
// Running from source (tests, dev) falls back to reading package.json.
export const AGENT_LINK_VERSION = typeof __AGENT_LINK_VERSION__ === "string"
  ? __AGENT_LINK_VERSION__
  : readPackageVersion();

// Requests the app-server sends to its client (approval prompts, user-input
// prompts, elicitation). On an app-server Agent Link manages there is no human
// to ask, so each one is answered at once: approvals are declined, anything
// else gets a JSON-RPC error. An unanswered request would leave the target
// turn waiting forever. External endpoints are not answered (see
// answerServerRequest).
export const SERVER_REQUEST_DECLINES = Object.freeze({
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  execCommandApproval: { decision: "denied" },
  applyPatchApproval: { decision: "denied" },
  "mcpServer/elicitation/request": { action: "decline" },
  "item/permissions/requestApproval": { permissions: {} }
});
const METHOD_NOT_HANDLED = -32601;

// `code` keeps the app-server's own value (a transport tag such as
// "open-failed", or the JSON-RPC error number). `errorCode` is the section 3.2
// code: a JSON-RPC error from the app-server is upstream_error; anything else
// means Codex could not be reached.
export class AppServerError extends AgentLinkError {
  constructor(message, details = {}) {
    super(typeof details.code === "number" ? "upstream_error" : "codex_unavailable", message, { details });
    this.name = "AppServerError";
    this.details = details;
    this.code = details.code ?? null;
    // What a tool result shows (section 3.2): a JSON-RPC error is
    // {method, rpcCode, rpcMessage}; the legacy `details` stay for callers.
    if (typeof details.code === "number") {
      this.envelopeDetails = {
        method: typeof details.method === "string" ? details.method : null,
        rpcCode: details.code,
        rpcMessage: String(message ?? "").slice(0, 500)
      };
    }
  }
}

// <state>/managed-app-servers, or AGENT_LINK_MANAGED_DIR (legacy alias
// CODEX_AGENT_LINK_STATE_DIR). See src/shared/paths.js.
export function managedAppServerStateDir() {
  return managedAppServerDir();
}

// Orphan reaping scans the current directory plus, with no override, the
// 0.4.x directory under ~/.claude/agent-link (R4.5).
export function managedAppServerReapDirs() {
  return [managedAppServerDir(), ...legacyManagedAppServerDirs()];
}

function envNonNegativeMs(name, fallback) {
  const raw = envValue(name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envPositiveMs(name, fallback) {
  const value = envNonNegativeMs(name, fallback);
  return value > 0 ? value : fallback;
}

// unix (default): the managed app-server listens on a Unix socket inside a
// 0700 state directory, so only this user can reach it. ws-token: loopback
// websocket gated by a capability token (for platforms without Unix sockets).
function envTransport() {
  const raw = envValue("AGENT_LINK_CODEX_TRANSPORT");
  if (raw === "ws-token" || raw === "unix") {
    return raw;
  }
  return process.platform === "win32" ? "ws-token" : "unix";
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.options = {
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      startupTimeoutMs: envPositiveMs("AGENT_LINK_CODEX_STARTUP_TIMEOUT_MS", DEFAULT_STARTUP_TIMEOUT_MS),
      autoStart: envFlag("AGENT_LINK_CODEX_AUTOSTART", true),
      idleTimeoutMs: envNonNegativeMs("AGENT_LINK_CODEX_IDLE_MS", DEFAULT_IDLE_TIMEOUT_MS),
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      startupFailureCacheMs: DEFAULT_STARTUP_FAILURE_CACHE_MS,
      transport: envTransport(),
      stateDir: null,
      ...options
    };
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.managedProcess = null;
    this.managedEndpoint = null;
    this.managedLaunch = null;
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
    this.lastStartupFailure = null;
    this.pendingStops = new Set();
    this.notifications = { total: 0, parseErrors: 0, byMethod: {}, recent: [] };
    this.serverRequests = { total: 0, declined: 0, rejected: 0, unanswered: 0, byMethod: {}, last: null };
  }

  async request(method, params = {}) {
    if (this.closed) {
      throw closedError(method);
    }
    this.clearIdleTimer();
    this.activeRequests += 1;
    try {
      await this.ensureConnected();
      return await this.sendRequest(this.ws, method, params);
    } finally {
      this.activeRequests -= 1;
      this.scheduleIdleShutdown();
    }
  }

  // The only place a JSON-RPC request is written. `ws` is captured by the
  // caller so a reconnect in between cannot redirect this request.
  sendRequest(ws, method, params) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(closedError(method));
        return;
      }
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new AppServerError(`Codex app-server connection is not open for ${method}`, { method, code: "not-connected" }));
        return;
      }
      const id = `agent-link-${this.nextId++}`;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`Timed out waiting for ${method}`, { method, code: "request-timeout" }));
      }, this.options.requestTimeoutMs);
      const fail = (error) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new AppServerError(`Failed to send ${method}: ${error.message}`, { method, code: "send-failed" }));
      };

      this.pending.set(id, { resolve, reject, timeout, method });
      try {
        ws.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) {
            fail(error);
          }
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  async ensureConnected() {
    if (this.closed) {
      throw closedError();
    }
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
    if (this.closed) {
      throw closedError();
    }
  }

  async connect() {
    const target = await this.resolveTarget();
    if (this.closed) {
      throw closedError();
    }
    const previous = this.ws;
    if (previous && previous.readyState !== WebSocket.CLOSED) {
      previous.terminate();
    }
    // A socketPath option is ignored by ws (it silently dials localhost:80),
    // and its ws+unix: URL form splits on ":" and keeps %-escapes, so paths
    // with a colon or a space break. Hand ws the Unix-socket connection itself.
    const ws = target.socketPath
      ? new WebSocket("ws://localhost/", { createConnection: () => net.connect(target.socketPath) })
      : new WebSocket(target.url, target.headers ? { headers: target.headers } : undefined);

    this.ws = ws;
    this.initialized = false;
    const { headers: _headers, ...publicTarget } = target;
    this.connectionInfo = publicTarget;

    ws.on("message", (raw) => this.handleMessage(ws, raw));
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
      if (this.closed || this.ws !== ws) {
        throw closedError();
      }
      await this.initialize(ws);
      if (this.closed || this.ws !== ws) {
        throw closedError();
      }
    } catch (error) {
      ws.terminate();
      if (this.ws === ws) {
        this.ws = null;
        this.initialized = false;
      }
      // close() tears the socket down mid-connect; report that, not the
      // transport error it caused.
      throw this.closed ? closedError() : error;
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
      getLogger().info("app_server.idle_release", { idleMs, managedPid: this.managedProcess?.pid ?? null });
      this.releaseIdleConnection().catch((error) => {
        getLogger().warn("app_server.idle_release_failed", { error });
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

  async initialize(ws) {
    const result = await this.sendRequest(ws, "initialize", {
      clientInfo: {
        name: "codex-agent-link",
        title: "Codex Agent Link",
        version: AGENT_LINK_VERSION
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.initialized = true;
    try {
      ws.send(JSON.stringify({ method: "initialized", params: {} }));
    } catch {
      // The close handler fails pending work; nothing else to do here.
    }
    this.connectionInfo = {
      ...this.connectionInfo,
      initialized: true,
      userAgent: result?.userAgent,
      codexHome: result?.codexHome,
      platformOs: result?.platformOs
    };
    return result;
  }

  handleMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      this.notifications.parseErrors += 1;
      return;
    }

    if (message.method && message.id !== undefined && message.id !== null) {
      this.answerServerRequest(ws, message);
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
      this.notifications.total += 1;
      countMethod(this.notifications.byMethod, message.method);
      this.notifications.recent.push({ method: message.method, receivedAt: new Date().toISOString() });
      if (this.notifications.recent.length > RECENT_NOTIFICATIONS) {
        this.notifications.recent.shift();
      }
    }
  }

  // Only an app-server Agent Link started itself is answered automatically.
  // An explicitly configured endpoint (AGENT_LINK_CODEX_URL / _SOCK) may be a
  // Desktop or IDE app-server whose prompts belong to a human; those requests
  // are counted and left for that app-server's other clients.
  answerServerRequest(ws, message) {
    const method = String(message.method);
    this.serverRequests.total += 1;
    countMethod(this.serverRequests.byMethod, method);
    if (this.connectionInfo?.managed !== true) {
      this.serverRequests.unanswered += 1;
      this.serverRequests.last = { method, answer: "unanswered", at: new Date().toISOString() };
      return;
    }
    const decline = Object.prototype.hasOwnProperty.call(SERVER_REQUEST_DECLINES, method)
      ? SERVER_REQUEST_DECLINES[method]
      : null;
    const reply = decline
      ? { id: message.id, result: decline }
      : {
          id: message.id,
          error: {
            code: METHOD_NOT_HANDLED,
            message: `Agent Link cannot answer app-server request ${method}; it was refused automatically so the turn does not wait on it.`
          }
        };
    if (decline) {
      this.serverRequests.declined += 1;
    } else {
      this.serverRequests.rejected += 1;
    }
    this.serverRequests.last = {
      method,
      answer: decline ? "declined" : "error",
      at: new Date().toISOString()
    };
    try {
      ws.send(JSON.stringify(reply));
    } catch {
      // Socket already gone; the app-server drops the request with it.
    }
  }

  failAllPending(message, code = "connection-lost") {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new AppServerError(message, { method: pending.method, code }));
      this.pending.delete(id);
    }
    this.initialized = false;
  }

  async resolveTarget() {
    const explicitUrl = envValue("AGENT_LINK_CODEX_URL");
    if (explicitUrl) {
      return { kind: "url", url: explicitUrl, managed: false };
    }

    const explicitSocket = envValue("AGENT_LINK_CODEX_SOCK");
    if (explicitSocket) {
      return { kind: "socket", socketPath: path.resolve(explicitSocket), managed: false };
    }

    if (!this.options.autoStart) {
      throw new AppServerError(
        "No Codex app-server endpoint is configured. Set AGENT_LINK_CODEX_URL or AGENT_LINK_CODEX_SOCK, or remove AGENT_LINK_CODEX_AUTOSTART=0 (legacy CODEX_AGENT_LINK_AUTOSTART) so Agent Link manages its own app-server.",
        { code: "autostart-disabled" }
      );
    }

    if (this.closed) {
      throw closedError();
    }

    if (!this.managedEndpoint) {
      this.throwIfStartupFailureCached();
      if (!this.managedStartPromise) {
        this.managedStartPromise = this.startManagedAppServer()
          .catch((error) => {
            if (!this.closed && error?.details?.cacheable) {
              this.lastStartupFailure = { error, at: Date.now() };
            }
            throw error;
          })
          .finally(() => {
            this.managedStartPromise = null;
          });
      }
      await this.managedStartPromise;
    }
    const endpoint = this.managedEndpoint;
    if (!endpoint) {
      throw new AppServerError("Managed Codex app-server was stopped during startup", { code: "stopped-during-startup" });
    }
    return {
      kind: "managed",
      managed: true,
      transport: endpoint.transport,
      url: endpoint.url ?? null,
      socketPath: endpoint.socketPath ?? null,
      headers: endpoint.headers
    };
  }

  throwIfStartupFailureCached() {
    const failure = this.lastStartupFailure;
    if (!failure) {
      return;
    }
    const ageMs = Date.now() - failure.at;
    const cacheMs = this.options.startupFailureCacheMs;
    if (!(cacheMs > 0) || ageMs >= cacheMs) {
      this.lastStartupFailure = null;
      return;
    }
    throw new AppServerError(`${failure.error.message} (cached startup failure; not retrying for another ${Math.ceil((cacheMs - ageMs) / 1000)} s)`, {
      ...failure.error.details,
      code: "startup-failure-cached",
      cachedCode: failure.error.details?.code ?? null,
      retryAfterMs: cacheMs - ageMs
    });
  }

  stateDir() {
    return this.options.stateDir || managedAppServerStateDir();
  }

  // Where the managed app-server listens. By default a Unix socket; other
  // users are kept out by the directory it lives in, which ensurePrivateDir
  // creates or tightens to 0700 and requires to be a real directory owned by
  // this user (Codex also creates the socket itself 0600). The fallback is a
  // capability-token websocket for platforms without Unix sockets.
  //
  // The name is fixed per Agent Link process (<pid>.sock): Codex keeps
  // per-socket lock files, so a fresh name per spawn would pile them up.
  allocateEndpoint() {
    // The default managed dir sits inside the Agent Link state dir; create
    // that 0700 first (and record the migration) so its parent is private too.
    if (path.resolve(path.dirname(this.stateDir())) === path.resolve(agentLinkStateDir())) {
      ensureStateDir();
    }
    const stateDir = ensurePrivateDir(this.stateDir());
    const stem = `${process.pid}`;
    if (this.options.transport === "ws-token") {
      const token = randomBytes(32).toString("hex");
      const tokenFile = path.join(stateDir, `${stem}.token`);
      writeFileSync(tokenFile, token, { mode: 0o600 });
      chmodSync(tokenFile, 0o600);
      return {
        transport: "ws-token",
        tokenFile,
        headers: { Authorization: `Bearer ${token}` },
        // The port is chosen just before spawn; the token keeps a process that
        // wins the port race from being driven by us or driving our server.
        pendingPort: true,
        args: ["--ws-auth", "capability-token", "--ws-token-file", tokenFile]
      };
    }
    let socketDir = stateDir;
    if (Buffer.byteLength(path.join(socketDir, `${stem}.sock`)) > MAX_UNIX_SOCKET_PATH_BYTES) {
      // macOS gives each user a private temp dir; elsewhere use /tmp with the
      // same ownership/symlink checks.
      const base = process.platform === "darwin" ? os.tmpdir() : "/tmp";
      socketDir = ensurePrivateDir(path.join(base, `agent-link-${process.getuid?.() ?? "user"}`));
    }
    const socketPath = path.join(socketDir, `${stem}.sock`);
    rmSync(socketPath, { force: true });
    return {
      transport: "unix",
      socketPath,
      listen: `unix://${socketPath}`,
      args: []
    };
  }

  async startManagedAppServer() {
    if (!this.reapedOrphans) {
      this.reapedOrphans = true;
      try {
        const dirs = this.options.stateDir ? [this.options.stateDir] : managedAppServerReapDirs();
        for (const dir of dirs) {
          reapOrphanedManagedAppServers({ stateDir: dir });
        }
      } catch {
        // Best effort only; never block a real tool call on orphan cleanup.
      }
    }

    const launch = findAppServerLaunch();
    // The socket name is reused, and an exiting app-server unlinks its socket:
    // let any previous one finish exiting before the next one binds the name.
    await Promise.allSettled([...this.pendingStops]);
    if (this.closed) {
      throw closedError();
    }
    const endpoint = this.allocateEndpoint();
    if (endpoint.pendingPort) {
      const port = await getFreePort();
      endpoint.url = `ws://127.0.0.1:${port}`;
      endpoint.listen = endpoint.url;
      endpoint.readyUrl = `http://127.0.0.1:${port}/readyz`;
      delete endpoint.pendingPort;
    }

    // detached: the app-server leads its own process group, so shutdown can
    // signal the whole group (app-server plus anything it launches) instead of
    // only the direct child.
    /** @type {ManagedChildProcess} */
    const child = spawn(launch.command, [...launch.args, "--listen", endpoint.listen, ...endpoint.args], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...managedAppServerEnv(process.env),
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Agent Link"
      }
    });
    child.__agentLinkEndpoint = endpoint;
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
      removeEndpointFiles(child.__agentLinkEndpoint);
      // stopChild() detaches the child before signalling it, so a child that
      // is still the managed process exited on its own.
      const unexpected = this.managedProcess === child;
      getLogger().log(unexpected ? "warn" : "info", "app_server.exit", {
        pid: child.pid ?? null,
        code,
        signal,
        unexpected,
        outputTail: unexpected ? logs.join("").slice(-2000) : undefined
      });
      if (!unexpected) {
        return;
      }
      if (this.managedProcessExitCleanup) {
        process.removeListener("exit", this.managedProcessExitCleanup);
        this.managedProcessExitCleanup = null;
      }
      this.managedEndpoint = null;
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
        url: endpoint.listen,
        transport: endpoint.transport,
        socketPath: endpoint.socketPath ?? null,
        tokenFile: endpoint.tokenFile ?? null,
        command: launch.command,
        startedAt: new Date().toISOString()
      });
      this.managedRecordPath = child.__agentLinkRecordPath;
    }

    const checkAbort = () => {
      if (spawnError) {
        return tagged(spawnError, spawnError.code === "ENOENT" ? "codex-binary-not-found" : "spawn-failed");
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        return tagged(
          new Error(`app-server exited during startup (code ${child.exitCode ?? "null"} signal ${child.signalCode ?? "null"})`),
          "app-server-exited-during-startup"
        );
      }
      return null;
    };
    try {
      if (endpoint.socketPath) {
        await waitForSocket(endpoint.socketPath, this.options.startupTimeoutMs, checkAbort);
      } else {
        await waitForReady(endpoint.readyUrl, this.options.startupTimeoutMs, checkAbort);
      }
    } catch (error) {
      await this.stopManagedAppServer(child);
      if (this.closed) {
        throw closedError();
      }
      const code = error.agentLinkCode ?? "readiness-timeout";
      throw new AppServerError("Managed Codex app-server did not become ready", {
        code,
        cacheable: this.managedProcess === null && !this.closed,
        cause: error.message,
        command: launch.command,
        launchSource: launch.source ?? null,
        startupTimeoutMs: this.options.startupTimeoutMs,
        logs: logs.join("")
      });
    }

    if (this.closed) {
      throw closedError();
    }
    if (this.managedProcess !== child) {
      throw new AppServerError("Managed Codex app-server was stopped during startup", { code: "stopped-during-startup" });
    }
    this.lastStartupFailure = null;
    this.managedEndpoint = endpoint;
    return endpoint;
  }

  // Stop the managed app-server's whole process group: SIGTERM, bounded wait,
  // then SIGKILL for the leader and any group members left behind.
  async stopManagedAppServer(child = this.managedProcess) {
    if (!child) {
      return;
    }
    const stopping = this.stopChild(child);
    this.pendingStops.add(stopping);
    try {
      await stopping;
    } finally {
      this.pendingStops.delete(stopping);
    }
  }

  async stopChild(child) {
    if (this.managedProcess === child) {
      if (this.managedProcessExitCleanup) {
        process.removeListener("exit", this.managedProcessExitCleanup);
        this.managedProcessExitCleanup = null;
      }
      this.managedProcess = null;
      this.managedEndpoint = null;
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
    removeEndpointFiles(child.__agentLinkEndpoint);
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
    const failure = this.lastStartupFailure;
    const failureAgeMs = failure ? Date.now() - failure.at : null;
    return {
      connected: this.ws?.readyState === WebSocket.OPEN && this.initialized,
      ...this.connectionInfo,
      closed: this.closed,
      clientVersion: AGENT_LINK_VERSION,
      managedPid: this.managedProcess?.pid ?? null,
      managedLaunch: this.managedLaunch ?? null,
      managedTransport: this.managedEndpoint?.transport ?? this.options.transport,
      managedSpawnCount: this.managedSpawnCount,
      idleTimeoutMs: this.options.idleTimeoutMs,
      idleShutdowns: this.idleShutdowns,
      startupTimeoutMs: this.options.startupTimeoutMs,
      startupFailure: failure && failureAgeMs < this.options.startupFailureCacheMs
        ? {
            code: failure.error.details?.code ?? null,
            message: failure.error.message,
            retryAfterMs: this.options.startupFailureCacheMs - failureAgeMs
          }
        : null,
      notifications: {
        total: this.notifications.total,
        parseErrors: this.notifications.parseErrors,
        byMethod: { ...this.notifications.byMethod },
        recent: [...this.notifications.recent]
      },
      serverRequests: {
        total: this.serverRequests.total,
        declined: this.serverRequests.declined,
        rejected: this.serverRequests.rejected,
        unanswered: this.serverRequests.unanswered,
        byMethod: { ...this.serverRequests.byMethod },
        last: this.serverRequests.last
      }
    };
  }

  async close() {
    this.closed = true;
    this.clearIdleTimer();
    this.failAllPending("Codex app-server client is closed", "client-closed");
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

function closedError(method = null) {
  return new AppServerError("Codex app-server client is closed", { method, code: "client-closed" });
}

function tagged(error, code) {
  error.agentLinkCode = code;
  return error;
}

function countMethod(table, method) {
  if (Object.prototype.hasOwnProperty.call(table, method)) {
    table[method] += 1;
  } else if (Object.keys(table).length < MAX_TRACKED_METHODS) {
    table[method] = 1;
  } else {
    table["(other)"] = (table["(other)"] ?? 0) + 1;
  }
}

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version || "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

// Create (or tighten) a directory only this user can enter. The leaf must be
// a real directory (not a symlink someone else could have planted) owned by
// this user.
function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) {
    throw new AppServerError(`Managed app-server state path is a symlink: ${dir}`, { code: "state-dir-unsafe" });
  }
  if (!stat.isDirectory()) {
    throw new AppServerError(`Managed app-server state path is not a directory: ${dir}`, { code: "state-dir-unsafe" });
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new AppServerError(`Managed app-server state directory is owned by another user: ${dir}`, { code: "state-dir-unsafe" });
  }
  if ((stat.mode & 0o777) !== 0o700) {
    chmodSync(dir, 0o700);
  }
  return dir;
}

function removeEndpointFiles(endpoint) {
  if (!endpoint) {
    return;
  }
  for (const file of [endpoint.socketPath, endpoint.tokenFile]) {
    if (file) {
      try {
        rmSync(file, { force: true });
      } catch {
        // Best-effort cleanup: force already ignores a missing file, and a
        // leftover socket or token file is replaced on the next start.
      }
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
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const file = path.join(stateDir, `${record.pid}.json`);
    writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
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
    // Best-effort cleanup: force already ignores a missing file, and the
    // orphan reaper re-checks a leftover record before acting on it.
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
    const recordEndpoint = {
      socketPath: typeof record.socketPath === "string" ? record.socketPath : null,
      tokenFile: typeof record.tokenFile === "string" ? record.tokenFile : null
    };
    if (!pidIsAlive(pid)) {
      removeManagedRecord(file);
      removeEndpointFiles(recordEndpoint);
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
      removeEndpointFiles(recordEndpoint);
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

// Ordered candidate paths: env overrides, app bundles (ChatGPT.app first),
// PATH, then well-known install dirs. See install-layout.js.
export function codexBinaryCandidates(options = {}) {
  return codexBinaryCandidateEntries(options).map((entry) => entry.path);
}

export function findCodexBinary(options = {}) {
  return discoverCodexBinary(options);
}

// What health reports about the local Codex install: which binary would be
// launched, where it came from, its version, and what was searched. The
// version needs a blocking `codex --version`; with probeVersion=false only an
// already-cached version is reported (versionProbed tells which).
export function describeCodexInstall(options = {}) {
  const probeVersion = options.probeVersion !== false;
  const { value: appServerBin, source: appServerBinSource } = env("AGENT_LINK_CODEX_APP_SERVER_BIN");
  if (appServerBin) {
    const exists = !appServerBin.includes("/") || existsSync(appServerBin);
    return {
      available: exists,
      path: appServerBin,
      source: `env:${appServerBinSource}`,
      version: null,
      versionProbed: false,
      searched: [appServerBin],
      reason: exists ? null : `Configured Codex app-server binary does not exist: ${appServerBin}`
    };
  }
  const found = discoverCodexBinary(options);
  const version = found.found ? codexBinaryVersion(found.path, { cachedOnly: !probeVersion }) : null;
  return {
    available: found.found,
    path: found.path,
    source: found.source,
    version: version ?? null,
    versionProbed: version !== undefined,
    searched: found.searched,
    reason: found.found ? null : found.reason
  };
}

export function findAppServerLaunch() {
  const { value: appServerBin, source: appServerBinSource } = env("AGENT_LINK_CODEX_APP_SERVER_BIN");
  if (appServerBin) {
    if (appServerBin.includes("/") && !existsSync(appServerBin)) {
      throw new AppServerError(`Configured Codex app-server binary does not exist: ${appServerBin}`, {
        code: "codex-binary-not-found",
        cacheable: true,
        searched: [appServerBin]
      });
    }
    return {
      kind: "app-server-bin",
      command: appServerBin,
      source: `env:${appServerBinSource}`,
      args: []
    };
  }

  const found = discoverCodexBinary();
  if (!found.found) {
    throw new AppServerError(`No Codex binary found: ${found.reason}`, {
      code: "codex-binary-not-found",
      cacheable: true,
      reason: found.reason,
      searched: found.searched
    });
  }
  return {
    kind: "codex-bin",
    command: found.path,
    source: found.source,
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
      reject(new AppServerError("Timed out opening Codex app-server websocket", { code: "open-timeout" }));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(new AppServerError(`Codex app-server websocket failed: ${error.message}`, { code: "open-failed" }));
    };
    const onClose = () => {
      cleanup();
      reject(new AppServerError("Codex app-server websocket closed before it opened", { code: "open-failed" }));
    };

    ws.on("open", onOpen);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      // A TCP listen always reports an AddressInfo (a string is a pipe path).
      const address = /** @type {import("node:net").AddressInfo} */ (server.address());
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

  throw tagged(lastError ?? new Error("readyz timed out"), "readiness-timeout");
}

// The Unix-socket listener has no /readyz; it is ready once it accepts a
// connection.
async function waitForSocket(socketPath, timeoutMs, checkAbort = () => null) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const abort = checkAbort();
    if (abort) {
      throw abort;
    }
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);
        socket.setTimeout(1000, () => socket.destroy(new Error("connect timed out")));
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw tagged(lastError ?? new Error("socket did not accept connections"), "readiness-timeout");
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

/**
 * Settings that grant or change role administration on this Agent Link
 * server. They are never inherited by the managed Codex app-server, so the
 * agent sessions it runs (and any Agent Link server they start) do not get
 * role administration or a different enforcement mode from this one.
 */
export const MANAGED_APP_SERVER_STRIPPED_ENV = Object.freeze(["AGENT_LINK_ROLE_ADMIN", "AGENT_LINK_ROLE_ENFORCEMENT"]);

/**
 * The environment for the managed app-server child: this process's, minus
 * MANAGED_APP_SERVER_STRIPPED_ENV.
 * @param {Record<string, string | undefined>} source
 * @returns {Record<string, string | undefined>}
 */
export function managedAppServerEnv(source) {
  const out = { ...source };
  for (const name of MANAGED_APP_SERVER_STRIPPED_ENV) delete out[name];
  return out;
}
