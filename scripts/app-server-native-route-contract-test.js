#!/usr/bin/env node
import assert from "node:assert/strict";
import { CodexAppServerClient } from "../src/app-server-client.js";

if (!process.env.CODEX_AGENT_LINK_APP_SERVER_BIN && !process.env.CODEX_APP_SERVER_BIN) {
  throw new Error("Set CODEX_AGENT_LINK_APP_SERVER_BIN to a standalone codex-app-server binary before running this contract test.");
}

const appServer = new CodexAppServerClient({
  autoStart: true
});

try {
  const start = await appServer.request("thread/start", { ephemeral: true });
  const threadId = start.thread?.id;
  assert.equal(typeof threadId, "string");
  assert.ok(threadId.length > 0);

  const route = await appServer.request("desktop/thread/route", { threadId, focus: false });
  assert.equal(route.routed, false);
  assert.equal(route.authority, "validatedOnly");
  assert.equal(route.selection, null);
  assert.match(route.reason, /desktop host|adapter/i);

  const readback = await appServer.request("desktop/thread/selection/read", {});
  assert.equal(readback.selection, null);
  assert.equal(readback.authority, "unsupported");
  assert.match(readback.reason, /desktop.*host|adapter/i);

  console.log(`App-server native route contract test passed; thread=${threadId}; routeAuthority=${route.authority}; readbackAuthority=${readback.authority}`);
} finally {
  await appServer.close();
}
