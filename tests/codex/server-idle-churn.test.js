// End-to-end over MCP stdio with the stub app-server: an idle server spawns no
// app-server; the first tool call spawns exactly one, later calls reuse it;
// every shutdown path (stdin end, SIGTERM, SIGHUP) takes the whole app-server
// process group down with the server. The three variants run concurrently.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../helpers/idle-churn.js";

const idleSeconds = Number(process.env.AGENT_LINK_IDLE_TEST_SECONDS || 3);

test("server idle churn and shutdown", { concurrency: true }, async (t) => {
  await Promise.all(["stdin", "sigterm", "sighup"].map((shutdown) =>
    t.test(`${shutdown} shutdown`, async () => {
      const r = await measure({ idleSeconds, shutdown });
      assert.equal(r.spawnsDuringIdle, 0, `${shutdown}: no app-server while idle`);
      assert.equal(r.firstCallIsError, false, `${shutdown}: health call succeeded (${r.stderrTail})`);
      assert.equal(r.spawnsAfterFirstCall, 1, `${shutdown}: first tool call spawns one app-server`);
      assert.equal(r.spawnsAfterThreeCalls, 1, `${shutdown}: later calls reuse it`);
      assert.ok(!r.serverExit.timeout, `${shutdown}: server exited`);
      assert.equal(r.childrenGoneAfterShutdown, true, `${shutdown}: app-server group gone, survivors ${r.survivorPids}`);
    })
  ));
});
