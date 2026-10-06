#!/usr/bin/env node
import assert from "node:assert/strict";
import { CodexAppServerClient } from "../src/app-server-client.js";
import { DesktopRouteHost } from "./desktop-route-host-harness.js";

if (!process.env.CODEX_AGENT_LINK_APP_SERVER_BIN && !process.env.CODEX_APP_SERVER_BIN) {
  throw new Error("Set CODEX_AGENT_LINK_APP_SERVER_BIN to a standalone codex-app-server binary before running this contract test.");
}

const appServer = new CodexAppServerClient({
  autoStart: true
});
let desktopHost = null;

try {
  await appServer.ensureConnected();
  const connection = appServer.getConnectionSummary();
  assert.equal(connection.kind, "managed");
  assert.equal(typeof connection.url, "string");

  desktopHost = await DesktopRouteHost.connect(connection.url);
  const start = await appServer.request("thread/start", { ephemeral: true });
  const threadId = start.thread?.id;
  assert.equal(typeof threadId, "string");
  assert.ok(threadId.length > 0);
  desktopHost.selectedThreadId = threadId;

  const routePromise = appServer.request("desktop/thread/route", { threadId, focus: false });
  const routeRequest = await desktopHost.nextRequest();
  assert.equal(routeRequest.method, "desktop/thread/route/request");
  assert.equal(routeRequest.params?.threadId, threadId);
  assert.equal(routeRequest.params?.focus ?? false, false);
  desktopHost.respond(routeRequest.id, {
    threadId,
    focus: false,
    routed: true,
    authority: "nativeQuietRoute",
    selection: {
      threadId,
      focused: false
    },
    reason: null
  });

  const route = await routePromise;
  assert.equal(route.routed, true);
  assert.equal(route.authority, "nativeQuietRoute");
  assert.deepEqual(route.selection, { threadId, focused: false });

  const readPromise = appServer.request("desktop/thread/selection/read", {});
  const readRequest = await desktopHost.nextRequest();
  assert.equal(readRequest.method, "desktop/thread/selection/read/request");
  assert.deepEqual(readRequest.params, {});
  desktopHost.respond(readRequest.id, {
    selection: {
      threadId,
      focused: false
    },
    authority: "nativeQuietRoute",
    reason: null
  });

  const readback = await readPromise;
  assert.equal(readback.authority, "nativeQuietRoute");
  assert.deepEqual(readback.selection, { threadId, focused: false });

  console.log(`App-server native route host success test passed; thread=${threadId}; routeAuthority=${route.authority}; readbackAuthority=${readback.authority}`);
} finally {
  desktopHost?.close();
  await appServer.close();
}
