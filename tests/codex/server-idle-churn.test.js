// End-to-end over MCP stdio with the stub app-server: an idle server spawns no
// app-server; the first tool call spawns exactly one, later calls reuse it;
// every shutdown path (stdin end, SIGTERM, SIGHUP) takes the whole app-server
// process group down with the server.
import assert from "node:assert/strict";
import { measure } from "../../scripts/idle-churn-measure.js";

const idleSeconds = Number(process.env.AGENT_LINK_IDLE_TEST_SECONDS || 5);

for (const shutdown of ["stdin", "sigterm", "sighup"]) {
  const r = await measure({ idleSeconds: shutdown === "stdin" ? idleSeconds : 1, shutdown });
  assert.equal(r.spawnsDuringIdle, 0, `${shutdown}: no app-server while idle`);
  assert.equal(r.firstCallIsError, false, `${shutdown}: health call succeeded (${r.stderrTail})`);
  assert.equal(r.spawnsAfterFirstCall, 1, `${shutdown}: first tool call spawns one app-server`);
  assert.equal(r.spawnsAfterThreeCalls, 1, `${shutdown}: later calls reuse it`);
  assert.ok(!r.serverExit.timeout, `${shutdown}: server exited`);
  assert.equal(r.childrenGoneAfterShutdown, true, `${shutdown}: app-server group gone, survivors ${r.survivorPids}`);
}
console.log("server idle-churn tests passed");
