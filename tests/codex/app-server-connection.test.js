// The real CodexAppServerClient against an in-process WebSocket fake
// (fix round a3, N4): isConnected, onConnectionChange on connect, on a
// dropped socket and on reconnect, notifications to onNotification, and the
// idle shutdown, which the background delivery relies on (a tracker cleared
// on every connect and close; no pass without a connection). Never
// launches Codex.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";

test("connection events, isConnected, reconnect and idle shutdown on the real client", async () => {
  const sockets = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === undefined) return;
      if (msg.method === "initialize") {
        socket.send(JSON.stringify({ id: msg.id, result: { userAgent: "fake", codexHome: "/tmp/none", platformOs: "macos" } }));
        socket.send(JSON.stringify({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } }));
        return;
      }
      socket.send(JSON.stringify({ id: msg.id, result: { data: [], nextCursor: null } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.AGENT_LINK_CODEX_URL = `ws://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const { CodexAppServerClient } = await import("../../src/codex/app-server-client.js");
  const { makeCodexDelivery } = await import("../../src/delivery/codex-delivery.js");
  const client = new CodexAppServerClient({ idleTimeoutMs: 300 });
  const events = [];
  const notifications = [];
  client.onConnectionChange((event) => events.push(event));
  client.onNotification((message) => notifications.push(message.method));
  const delivery = makeCodexDelivery({ appServer: client, mailboxExists: () => false });
  const until = async (predicate, label) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    assert.equal(client.isConnected(), false);
    assert.deepEqual(await delivery.pass(), { skipped: "not_connected" }, "a pass never connects");
    assert.equal(sockets.length, 0);

    await client.request("thread/loaded/list", { limit: 1 });
    assert.equal(client.isConnected(), true);
    assert.deepEqual(events, ["connecting"]);
    await until(() => notifications.includes("thread/status/changed"), "notification");

    // The tracker learns from notifications and is cleared on close.
    delivery.onNotification({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });
    client.onConnectionChange(delivery.onConnectionChange);
    assert.equal(delivery.tracker.size, 1);

    // The server drops the socket: closed, and no longer connected.
    sockets[0].terminate();
    await until(() => events.includes("closed"), "closed event");
    assert.equal(client.isConnected(), false);
    assert.equal(delivery.tracker.size, 0, "what the old endpoint said is forgotten");

    // The next request reconnects.
    await client.request("thread/loaded/list", { limit: 1 });
    assert.equal(client.isConnected(), true);
    assert.equal(sockets.length, 2);
    assert.deepEqual(events.slice(-1), ["connecting"]);

    // With no requests, the idle shutdown closes the connection.
    await until(() => !client.isConnected(), "idle shutdown");
    assert.equal(events.at(-1), "closed");
    assert.equal(client.getConnectionSummary().connected, false);
  } finally {
    delete process.env.AGENT_LINK_CODEX_URL;
    await client.close?.();
    wss.close();
    server.close();
  }
});
