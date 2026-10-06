// The managed app-server reports idle release and child exits to the logger
// (expected exits at info, unexpected ones at warn with the output tail).
// Uses the stub app-server; never launches Codex.app.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sleep, stubAppServer, waitFor } from "../helpers/codex-stub.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-link-applog-"));
process.env.CODEX_AGENT_LINK_APP_SERVER_BIN = stubAppServer;
process.env.CODEX_AGENT_LINK_STATE_DIR = path.join(tmp, "state");
delete process.env.CODEX_AGENT_LINK_URL;
delete process.env.CODEX_APP_SERVER_URL;
delete process.env.CODEX_AGENT_LINK_SOCK;
delete process.env.CODEX_APP_SERVER_SOCK;
delete process.env.AGENT_LINK_STUB_GRANDCHILD;

const { createLogger, setLogger } = await import("../../src/shared/log.js");
const { CodexAppServerClient } = await import("../../src/codex/app-server-client.js");

const stderrLines = [];
const logger = createLogger({ env: {}, stderr: { write: (chunk) => stderrLines.push(chunk) } });
setLogger(logger);
const events = (name) => logger.recentEvents().filter((event) => event.event === name);

const client = new CodexAppServerClient({ autoStart: true, idleTimeoutMs: 300, killGraceMs: 500 });
try {
  // Idle release: info events only, nothing on stderr at the default level.
  await client.request("thread/loaded/list", { limit: 1 });
  await waitFor(() => events("app_server.exit").length === 1, { timeoutMs: 5000, label: "idle exit logged" });
  const [release] = events("app_server.idle_release");
  assert.equal(release.level, "info");
  assert.equal(release.fields.idleMs, 300);
  assert.equal(typeof release.fields.managedPid, "number");
  const [expected] = events("app_server.exit");
  assert.equal(expected.level, "info");
  assert.equal(expected.fields.unexpected, false);
  assert.equal("outputTail" in expected.fields, false);
  assert.equal(stderrLines.length, 0, "expected exits stay off stderr");

  // Unexpected exit: warn, with the output tail, also on stderr.
  await client.request("thread/loaded/list", { limit: 1 });
  const pid = client.getConnectionSummary().managedPid;
  assert.equal(typeof pid, "number");
  process.kill(pid, "SIGKILL");
  await waitFor(() => events("app_server.exit").length === 2, { timeoutMs: 5000, label: "crash exit logged" });
  const crash = events("app_server.exit")[1];
  assert.equal(crash.level, "warn");
  assert.equal(crash.fields.unexpected, true);
  assert.equal(crash.fields.pid, pid);
  assert.equal(crash.fields.signal, "SIGKILL");
  assert.equal(typeof crash.fields.outputTail, "string");
  assert.ok(stderrLines.some((line) => line.startsWith("agent-link: [warn] app_server.exit")));
  await sleep(50);
} finally {
  await client.close();
  setLogger(null);
  rmSync(tmp, { recursive: true, force: true });
}
console.log("app-server logging tests passed");
