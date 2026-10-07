#!/usr/bin/env node
// Stub for `codex app-server --listen <unix://PATH | ws://127.0.0.1:PORT>` used
// by the lifecycle tests. It never touches Codex.app. Behaviour knobs (env):
//   AGENT_LINK_STUB_SPAWN_LOG     append "<pid> start <url>" / "<pid> grandchild <gpid>"
//   AGENT_LINK_STUB_GRANDCHILD=1  launch a long-lived child (tests group kill)
//   AGENT_LINK_STUB_NO_READY=1    never become ready (no /readyz 200, no unix listener)
//   AGENT_LINK_STUB_TERM_DELAY_MS delay before exiting on SIGTERM
//   AGENT_LINK_STUB_IGNORE_TERM=1 ignore SIGTERM entirely (needs SIGKILL)
//   AGENT_LINK_STUB_EXIT_AT_START=<code> exit immediately with that code
//   AGENT_LINK_STUB_SERVER_REQUEST=<method>[,<method>...] before answering
//     thread/loaded/list, send those server->client requests and include the
//     client's answers (in order) as serverRequestAnswers
//   AGENT_LINK_STUB_ARGS_LOG      append the full argv (JSON) for transport assertions
//   AGENT_LINK_STUB_THREAD_STATUS JSON {threadId: statusType} answered by thread/read
//     (default "notLoaded" for an unlisted thread)
//   AGENT_LINK_STUB_TURN_LOG      append "<method> <params JSON>" for turn/start and turn/steer
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import { WebSocketServer } from "ws";

const listenIndex = process.argv.indexOf("--listen");
const url = listenIndex >= 0 ? process.argv[listenIndex + 1] : null;
if (!url) {
  process.stderr.write("stub: missing --listen\n");
  process.exit(2);
}
const log = (line) => {
  if (process.env.AGENT_LINK_STUB_SPAWN_LOG) {
    appendFileSync(process.env.AGENT_LINK_STUB_SPAWN_LOG, `${line}\n`);
  }
};
log(`${process.pid} start ${url}`);
if (process.env.AGENT_LINK_STUB_ARGS_LOG) {
  appendFileSync(process.env.AGENT_LINK_STUB_ARGS_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
}
if (process.env.AGENT_LINK_STUB_EXIT_AT_START) {
  process.exit(Number(process.env.AGENT_LINK_STUB_EXIT_AT_START));
}

if (process.env.AGENT_LINK_STUB_GRANDCHILD === "1") {
  const grandchild = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  log(`${process.pid} grandchild ${grandchild.pid}`);
}

const notReady = process.env.AGENT_LINK_STUB_NO_READY === "1";
const server = http.createServer((req, res) => {
  if (req.url === "/readyz" && !notReady) {
    res.writeHead(200).end("ok");
    return;
  }
  res.writeHead(503).end("not ready");
});
// Mirrors `--ws-auth capability-token --ws-token-file F`: upgrades without
// "Authorization: Bearer <contents of F>" are refused with 401.
const tokenFileIndex = process.argv.indexOf("--ws-token-file");
const requiredToken = process.argv.includes("capability-token") && tokenFileIndex >= 0
  ? readFileSync(process.argv[tokenFileIndex + 1], "utf8").trim()
  : null;
const wss = new WebSocketServer({
  server,
  verifyClient: (info, done) => {
    if (!requiredToken) {
      done(true);
      return;
    }
    done(info.req.headers.authorization === `Bearer ${requiredToken}`, 401);
  }
});
wss.on("connection", (socket) => {
  const awaiting = new Map();
  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.id === undefined) {
      return;
    }
    if (!msg.method && awaiting.has(msg.id)) {
      const resume = awaiting.get(msg.id);
      awaiting.delete(msg.id);
      resume(msg);
      return;
    }
    const reply = (payload) => socket.send(JSON.stringify({ id: msg.id, ...payload }));
    switch (msg.method) {
      case "initialize":
        reply({ result: { userAgent: "stub-app-server", codexHome: "/tmp/stub-codex-home", platformOs: "macos", clientInfo: msg.params?.clientInfo ?? null } });
        break;
      case "thread/loaded/list": {
        const methods = (process.env.AGENT_LINK_STUB_SERVER_REQUEST || "").split(",").filter(Boolean);
        if (methods.length === 0) {
          reply({ result: { data: [], nextCursor: null } });
          break;
        }
        // Send every server request, then answer the original call once all
        // of them were answered, echoing the client's answers in order.
        const answers = new Array(methods.length);
        let pending = methods.length;
        methods.forEach((method, index) => {
          const requestId = `srv-${msg.id}-${index}`;
          awaiting.set(requestId, (answer) => {
            answers[index] = answer;
            pending -= 1;
            if (pending === 0) {
              reply({ result: { data: [], nextCursor: null, serverRequestAnswers: answers } });
            }
          });
          socket.send(JSON.stringify({ id: requestId, method, params: { threadId: "stub-thread", turnId: "stub-turn", itemId: "stub-item" } }));
        });
        break;
      }
      case "thread/list":
        reply({ result: { data: [], nextCursor: null, backwardsCursor: null } });
        break;
      case "thread/read": {
        let statuses = {};
        try {
          statuses = JSON.parse(process.env.AGENT_LINK_STUB_THREAD_STATUS || "{}");
        } catch {
          statuses = {};
        }
        const threadId = msg.params?.threadId;
        reply({ result: { thread: { id: threadId, status: { type: statuses[threadId] ?? "notLoaded" }, turns: [] } } });
        break;
      }
      case "turn/start":
      case "turn/steer":
        if (process.env.AGENT_LINK_STUB_TURN_LOG) {
          appendFileSync(process.env.AGENT_LINK_STUB_TURN_LOG, `${msg.method} ${JSON.stringify(msg.params ?? {})}\n`);
        }
        reply({ result: { turn: { id: `stub-turn-${msg.id}`, status: "inProgress", items: [] } } });
        break;
      default:
        reply({ error: { code: -32601, message: `stub: method not found: ${msg.method}` } });
    }
  });
});
if (url.startsWith("unix://")) {
  if (notReady) {
    setInterval(() => {}, 1000);
  } else {
    server.listen(url.slice("unix://".length));
  }
} else {
  server.listen(Number(new URL(url).port), "127.0.0.1");
}

process.on("SIGTERM", () => {
  if (process.env.AGENT_LINK_STUB_IGNORE_TERM === "1") {
    return;
  }
  const delay = Number(process.env.AGENT_LINK_STUB_TERM_DELAY_MS || 0);
  setTimeout(() => process.exit(0), delay);
});
