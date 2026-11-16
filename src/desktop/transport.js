import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { stateDir } from "../shared/paths.js";
import { failure, refuse, success, VERSION } from "./protocol.js";
import { controllerKey, privateDirectory } from "./journal.js";
import { invokeNative } from "./host.js";

const MAX_REQUEST_BYTES = 96 * 1024;
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
const SOCKET_MAX_BYTES = 103;

export function desktopDirectory() {
  return path.join(stateDir(), "desktop");
}

export function endpoint(directory) {
  const socket = path.join(directory, "broker.sock");
  if (Buffer.byteLength(socket) > SOCKET_MAX_BYTES) refuse("desktop_socket_path_too_long", "The reserved-screen state path exceeds the local socket limit.");
  return socket;
}

function rawMessage(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length &&
    fields.every(key => Object.hasOwn(value, key));
}

function attachReader(socket, onMessage, limit) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffer += chunk;
    while (true) {
      const delimiter = buffer.indexOf("\n");
      if (delimiter < 0) break;
      if (Buffer.byteLength(buffer.slice(0, delimiter)) > limit) return socket.destroy();
      let message;
      try {
        message = JSON.parse(buffer.slice(0, delimiter));
      } catch {
        return socket.destroy();
      }
      buffer = buffer.slice(delimiter + 1);
      onMessage(message);
    }
    if (Buffer.byteLength(buffer) > limit) socket.destroy();
  });
}

function write(socket, value) {
  if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n");
}

function controlProof(secret, challenge) {
  return createHmac("sha256", Buffer.from(secret, "hex")).update("agent-link-reserved-screen-v1:" + challenge).digest("hex");
}

function acceptedProof(key, challenge, proof) {
  return typeof proof === "string" && /^[a-f0-9]{64}$/.test(proof) &&
    timingSafeEqual(Buffer.from(controlProof(key, challenge), "hex"), Buffer.from(proof, "hex"));
}

async function holdWriter(directory, helper, probe) {
  privateDirectory(directory);
  const fd = fs.openSync(path.join(directory, "writer.lock"),
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
      refuse("desktop_writer_lock_invalid", "The reserved-screen writer lock has unexpected ownership or permissions.");
    }
    if (!(await probe(helper, "hold-writer", { fd }))?.locked) refuse("desktop_writer_held", "Another reserved-screen broker holds the sole writer lock.");
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

// Create the broker only after the native flock is held. The inherited file
// descriptor shares the Node process's open-file description, so the lock
// remains held until this broker closes it or exits.
export async function serveDesktop({ directory, helper, createBroker, probe = invokeNative }) {
  const socketPath = endpoint(directory);
  const fd = await holdWriter(directory, helper, probe);
  let server;
  let timer;
  let ownedSocket = false;
  const channels = new Set();
  try {
    const key = controllerKey(directory);
    const broker = createBroker();
    const existing = fs.lstatSync(socketPath, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.getuid?.()) refuse("desktop_socket_invalid", "The reserved-screen endpoint is not an owned socket.");
      fs.unlinkSync(socketPath);
    }
    server = net.createServer(socket => {
      if (channels.size >= 64) return socket.destroy();
      channels.add(socket);
      socket.on("error", () => { /* The client receives disconnection. */ });
      const challenge = randomBytes(32).toString("hex");
      let mode = null;
      let connection = null;
      let pending = 0;
      const deadline = setTimeout(() => {
        if (!mode) socket.destroy();
      }, 4_000);
      deadline.unref?.();
      socket.on("close", () => {
        clearTimeout(deadline);
        channels.delete(socket);
        if (connection) broker.disconnect(connection);
      });
      const peerIdentity = () => {
        // Node's pipe handle is runtime-dependent. No PID proof is better than
        // a guessed caller, so missing handle inheritance refuses enrollment.
        const peerFd = socket["_handle"]?.fd;
        return Number.isInteger(peerFd) && peerFd >= 0 ? broker.host.peer(peerFd) : null;
      };
      attachReader(socket, msg => {
        if (!msg || typeof msg.id !== "string" || !/^[a-f0-9-]{36}$/.test(msg.id)) return socket.destroy();
        const id = msg.id;
        async function request() {
          if (!mode) {
            if (msg.mode === "controller" && rawMessage(msg, ["id", "mode", "proof"]) && acceptedProof(key, challenge, msg.proof)) {
              mode = "controller";
              return { connected: true };
            }
            if (msg.mode !== "desktop" || !rawMessage(msg, ["id", "mode"]) || pending > 1) refuse("desktop_connection_refused", "The requested private channel could not be authenticated.");
            const peer = await peerIdentity();
            if (socket.destroyed || mode) refuse("desktop_connection_refused", "The connection changed during admission.");
            connection = broker.connect(peer);
            mode = "desktop";
            return { connected: true };
          }
          if (mode === "controller") {
            if (!rawMessage(msg, ["id", "method", "params"])) refuse("invalid_desktop_request", "Invalid controller envelope.");
            return broker.control(msg.method, msg.params);
          }
          if (!rawMessage(msg, ["id", "method", "params", "runtime_session"]) ||
            (msg.runtime_session !== null && (typeof msg.runtime_session !== "string" || msg.runtime_session.length > 128))) {
            refuse("invalid_desktop_request", "Invalid desktop connection envelope.");
          }
          return broker.call(connection, msg.method, msg.params, msg.runtime_session);
        }
        if (++pending > 16) return socket.destroy();
        void request().then(result => write(socket, { id, ...success(result) }), error => write(socket, { id, ...failure(error) }))
          .finally(() => pending--);
      }, MAX_REQUEST_BYTES);
      write(socket, { protocol_version: VERSION, challenge });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    ownedSocket = true;
    fs.chmodSync(socketPath, 0o600);
    let ticking = false;
    const tick = () => {
      if (ticking) return;
      ticking = true;
      void broker.tick().catch(() => { /* Persisted/closed status carries the fault. */ }).finally(() => { ticking = false; });
    };
    timer = setInterval(tick, 2_000);
    timer.unref?.();
    tick();
    return {
      broker,
      async close() {
        broker.storageFailure = true;
        broker.liveInvocation?.terminate();
        clearInterval(timer);
        for (const socket of channels) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        fs.closeSync(fd);
      }
    };
  } catch (error) {
    clearInterval(timer);
    for (const channel of channels) channel.destroy();
    server?.close();
    if (ownedSocket) fs.rmSync(socketPath, { force: true });
    fs.closeSync(fd);
    throw error;
  }
}

async function openClient(directory, mode) {
  const socket = net.createConnection(endpoint(directory));
  let alive = true;
  let challengeResolve;
  const challenge = new Promise(resolve => { challengeResolve = resolve; });
  const pending = new Map();
  function lost() {
    alive = false;
    challengeResolve(null);
    for (const { resolve } of pending.values()) resolve(null);
    pending.clear();
  }
  socket.on("error", lost);
  socket.on("close", lost);
  attachReader(socket, msg => {
    if (msg?.protocol_version === VERSION && /^[a-f0-9]{64}$/.test(msg.challenge ?? "")) challengeResolve(msg.challenge);
    else if (msg?.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }, MAX_REPLY_BYTES);
  function call(fields, timeout = 24_000) {
    if (!alive) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => socket.destroy(), timeout);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); } });
      write(socket, { id, ...fields });
    });
  }
  const timer = setTimeout(() => socket.destroy(), 3_000);
  const nonce = await challenge;
  clearTimeout(timer);
  if (!nonce) {
    socket.destroy();
    refuse("desktop_broker_unavailable", "The shared reserved-screen broker is unavailable. Ask its controller for current status.");
  }
  try {
    const hello = mode === "controller"
      ? { mode, proof: controlProof(controllerKey(directory), nonce) }
      : { mode };
    const handshake = await call(hello, 4_000);
    if (!handshake?.ok) {
      if (handshake?.error) refuse(handshake.error.code, handshake.error.message);
      refuse("desktop_connection_refused", "The reserved-screen connection could not be authenticated.");
    }
  } catch (error) {
    socket.destroy();
    throw error;
  }
  socket.unref();
  return {
    alive: () => alive,
    async call(method, params, runtimeSession = null) {
      const message = await call({ method, params, ...(mode === "desktop" ? { runtime_session: runtimeSession } : {}) });
      if (!message) refuse("desktop_connection_lost", "The broker reply was lost. Check ticket status before taking further action.");
      if (!message.ok) refuse(message.error.code, message.error.message);
      return message.result;
    },
    close: () => socket.destroy()
  };
}

export async function ownerCall(directory, method, params) {
  const client = await openClient(directory, "controller");
  try {
    return await client.call(method, params);
  } finally {
    client.close();
  }
}

export function createDesktopClient(directory) {
  let opened;
  return {
    async call(method, params, sessionId) {
      opened ??= openClient(directory(), "desktop");
      let client;
      try {
        client = await opened;
      } catch (error) {
        opened = null;
        throw error;
      }
      if (!client.alive()) {
        opened = null;
        refuse("desktop_connection_lost", "The enrolled connection has closed. The controller must confirm the old outcome before reenrollment.");
      }
      return client.call(method, params, sessionId);
    },
    close() {
      void opened?.then(client => client.close(), () => { /* Connection already failed. */ });
    }
  };
}
