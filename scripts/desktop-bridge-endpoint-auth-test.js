#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "../src/app-server-client.js";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "codex-agent-link-endpoint-auth-"));
const endpointFile = path.join(tempDir, "desktop-app-server.json");
const server = http.createServer((req, res) => {
  if (req.url === "/readyz") {
    res.writeHead(200).end("ok");
    return;
  }
  res.writeHead(404).end("not found");
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  process.env.CODEX_AGENT_LINK_DESKTOP_ENDPOINT_FILE = endpointFile;

  await assertRejectedEndpoint("explicit non-Desktop parentCommand", {
    kind: "codex-desktop-quiet-route-bridge",
    url: `ws://127.0.0.1:${port}`,
    readyUrl: `http://127.0.0.1:${port}/readyz`,
    appServerPid: process.pid,
    bridgePid: process.pid,
    parentPid: process.ppid,
    parentCommand: process.argv.join(" "),
    createdAt: new Date().toISOString()
  });

  await assertRejectedEndpoint("legacy endpoint whose bridge parent is not Desktop", {
    kind: "codex-desktop-quiet-route-bridge",
    url: `ws://127.0.0.1:${port}`,
    readyUrl: `http://127.0.0.1:${port}/readyz`,
    appServerPid: process.pid,
    bridgePid: process.pid,
    createdAt: new Date().toISOString()
  });

  console.log("Desktop bridge endpoint authentication test passed");
} finally {
  delete process.env.CODEX_AGENT_LINK_DESKTOP_ENDPOINT_FILE;
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempDir, { recursive: true, force: true });
}

async function assertRejectedEndpoint(label, endpoint) {
  writeFileSync(endpointFile, `${JSON.stringify(endpoint, null, 2)}\n`);
  const client = new CodexAppServerClient({
    autoStart: false,
    requestTimeoutMs: 500,
    startupTimeoutMs: 500
  });

  try {
    await client.ensureConnected();
    assert.fail(`${label}: endpoint was accepted`);
  } catch (error) {
    assert.match(error.message, /No Codex app-server endpoint is configured/, label);
  } finally {
    await client.close();
  }
}
