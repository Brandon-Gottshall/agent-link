#!/usr/bin/env node
// Stub for `codex app-server --listen ws://127.0.0.1:<port>` used by the
// lifecycle tests. It never touches Codex.app. Behaviour knobs (env):
//   AGENT_LINK_STUB_SPAWN_LOG     append "<pid> start <url>" / "<pid> grandchild <gpid>"
//   AGENT_LINK_STUB_GRANDCHILD=1  launch a long-lived child (tests group kill)
//   AGENT_LINK_STUB_NO_READY=1    never answer /readyz with 200
//   AGENT_LINK_STUB_TERM_DELAY_MS delay before exiting on SIGTERM
//   AGENT_LINK_STUB_IGNORE_TERM=1 ignore SIGTERM entirely (needs SIGKILL)
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import http from "node:http";
import { WebSocketServer } from "ws";

const listenIndex = process.argv.indexOf("--listen");
const url = listenIndex >= 0 ? process.argv[listenIndex + 1] : null;
if (!url) {
  process.stderr.write("stub: missing --listen\n");
  process.exit(2);
}
const port = Number(new URL(url).port);
const log = (line) => {
  if (process.env.AGENT_LINK_STUB_SPAWN_LOG) {
    appendFileSync(process.env.AGENT_LINK_STUB_SPAWN_LOG, `${line}\n`);
  }
};
log(`${process.pid} start ${url}`);

if (process.env.AGENT_LINK_STUB_GRANDCHILD === "1") {
  const grandchild = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  log(`${process.pid} grandchild ${grandchild.pid}`);
}

const server = http.createServer((req, res) => {
  if (req.url === "/readyz" && process.env.AGENT_LINK_STUB_NO_READY !== "1") {
    res.writeHead(200).end("ok");
    return;
  }
  res.writeHead(503).end("not ready");
});
const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
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
    const reply = (payload) => socket.send(JSON.stringify({ id: msg.id, ...payload }));
    switch (msg.method) {
      case "initialize":
        reply({ result: { userAgent: "stub-app-server", codexHome: "/tmp/stub-codex-home", platformOs: "macos" } });
        break;
      case "thread/loaded/list":
        reply({ result: { data: [], nextCursor: null } });
        break;
      case "thread/list":
        reply({ result: { data: [], nextCursor: null, backwardsCursor: null } });
        break;
      default:
        reply({ error: { code: -32601, message: `stub: method not found: ${msg.method}` } });
    }
  });
});
server.listen(port, "127.0.0.1");

process.on("SIGTERM", () => {
  if (process.env.AGENT_LINK_STUB_IGNORE_TERM === "1") {
    return;
  }
  const delay = Number(process.env.AGENT_LINK_STUB_TERM_DELAY_MS || 0);
  setTimeout(() => process.exit(0), delay);
});
