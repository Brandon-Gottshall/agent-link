// Managed app-server lifecycle: lazy start, single spawn under concurrency,
// reuse, idle shutdown, process-group kill, startup-failure cleanup, and the
// orphan reaper. Uses a stub app-server; never launches Codex.app.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { alive, readSpawnLog, sleep, stubAppServer, waitFor } from "./test-helpers.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-link-lifecycle-"));
const spawnLog = path.join(tmp, "spawns.log");
const stateDir = path.join(tmp, "state");
process.env.CODEX_AGENT_LINK_APP_SERVER_BIN = stubAppServer;
process.env.CODEX_AGENT_LINK_STATE_DIR = stateDir;
process.env.CODEX_AGENT_LINK_USE_DESKTOP_BRIDGE = "0";
process.env.AGENT_LINK_STUB_SPAWN_LOG = spawnLog;
process.env.AGENT_LINK_STUB_GRANDCHILD = "1";
delete process.env.CODEX_AGENT_LINK_URL;
delete process.env.CODEX_APP_SERVER_URL;
delete process.env.CODEX_AGENT_LINK_SOCK;
delete process.env.CODEX_APP_SERVER_SOCK;

const { CodexAppServerClient, reapOrphanedManagedAppServers } = await import("../../src/codex/app-server-client.js");

const records = () => {
  try {
    return readdirSync(stateDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
};

try {
  // 1. Lazy: constructing a client starts nothing.
  {
    const client = new CodexAppServerClient({ autoStart: true, idleTimeoutMs: 800, killGraceMs: 500 });
    await sleep(300);
    assert.equal(readSpawnLog(spawnLog).starts.length, 0, "no spawn before first request");
    assert.equal(client.getConnectionSummary().managedSpawnCount, 0);

    // 2. Concurrent first calls share a single spawn.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.request("thread/loaded/list", { limit: 1 }))
    );
    assert.equal(results.length, 5);
    assert.equal(readSpawnLog(spawnLog).starts.length, 1, "5 concurrent calls -> 1 spawn");

    // 3. Reuse.
    await client.request("thread/loaded/list", { limit: 1 });
    await client.request("thread/loaded/list", { limit: 1 });
    const log1 = readSpawnLog(spawnLog);
    assert.equal(log1.starts.length, 1, "subsequent calls reuse the app-server");
    assert.equal(client.getConnectionSummary().managedSpawnCount, 1);
    assert.equal(records().length, 1, "one orphan-reaper record while running");
    const first = log1.starts[0].pid;
    const firstGrandchild = log1.grandchildren[0].pid;
    assert.ok(alive(first) && alive(firstGrandchild));

    // 4. Idle timeout stops the whole process group.
    await waitFor(() => !alive(first) && !alive(firstGrandchild), { timeoutMs: 5000, label: "idle shutdown" });
    assert.equal(client.getConnectionSummary().idleShutdowns, 1);
    assert.equal(client.getConnectionSummary().managedPid, null);
    assert.equal(records().length, 0, "record removed after idle shutdown");

    // 5. Next real call starts exactly one new app-server.
    await client.request("thread/loaded/list", { limit: 1 });
    const log2 = readSpawnLog(spawnLog);
    assert.equal(log2.starts.length, 2);
    const second = log2.starts[1].pid;
    const secondGrandchild = log2.grandchildren[1].pid;

    // 6. close() kills the group (leader + grandchild) and removes the record.
    await client.close();
    assert.ok(!alive(second), "app-server killed on close");
    await waitFor(() => !alive(secondGrandchild), { timeoutMs: 3000, label: "grandchild killed" });
    assert.equal(records().length, 0);
    await assert.rejects(client.request("thread/loaded/list", {}), /closed/);
    assert.equal(readSpawnLog(spawnLog).starts.length, 2, "closed client never respawns");
  }

  // 7. SIGTERM-ignoring app-server is SIGKILLed after the grace period.
  {
    process.env.AGENT_LINK_STUB_IGNORE_TERM = "1";
    const client = new CodexAppServerClient({ autoStart: true, idleTimeoutMs: 0, killGraceMs: 300 });
    await client.request("thread/loaded/list", {});
    const { starts, grandchildren } = readSpawnLog(spawnLog);
    const pid = starts.at(-1).pid;
    const gpid = grandchildren.at(-1).pid;
    await client.close();
    await waitFor(() => !alive(pid) && !alive(gpid), { timeoutMs: 3000, label: "SIGKILL escalation" });
    delete process.env.AGENT_LINK_STUB_IGNORE_TERM;
  }

  // 8. Startup that never becomes ready is killed, not leaked.
  {
    process.env.AGENT_LINK_STUB_NO_READY = "1";
    const before = readSpawnLog(spawnLog).starts.length;
    const client = new CodexAppServerClient({ autoStart: true, startupTimeoutMs: 700, killGraceMs: 300, idleTimeoutMs: 0 });
    await assert.rejects(client.request("thread/loaded/list", {}), /did not become ready/);
    const { starts, grandchildren } = readSpawnLog(spawnLog);
    assert.equal(starts.length, before + 1);
    await waitFor(() => !alive(starts.at(-1).pid) && !alive(grandchildren.at(-1).pid), { timeoutMs: 3000, label: "failed-start cleanup" });
    assert.equal(records().length, 0);
    await client.close();
    delete process.env.AGENT_LINK_STUB_NO_READY;
  }

  // 9. Orphan reaper: dead owner + matching command -> killed; reused pid -> left alone.
  {
    const deadOwner = spawn("/usr/bin/true");
    await new Promise((resolve) => deadOwner.once("exit", resolve));
    const port = 40000 + Math.floor(Math.random() * 20000);
    const url = `ws://127.0.0.1:${port}`;
    const orphan = spawn(process.execPath, [stubAppServer, "--listen", url], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AGENT_LINK_STUB_GRANDCHILD: "0" }
    });
    orphan.unref();
    await waitFor(() => readSpawnLog(spawnLog).starts.some((s) => s.url === url), { label: "orphan stub up" });
    writeFileSync(path.join(stateDir, `${orphan.pid}.json`), JSON.stringify({ ownerPid: deadOwner.pid, pid: orphan.pid, pgid: orphan.pid, url }));
    // A record whose pid now belongs to an unrelated live process (this test).
    writeFileSync(path.join(stateDir, `${process.pid}.json`), JSON.stringify({ ownerPid: deadOwner.pid, pid: process.pid, pgid: process.pid, url: "ws://127.0.0.1:1" }));
    // A record whose owner is still alive must be kept.
    writeFileSync(path.join(stateDir, "999999.json"), JSON.stringify({ ownerPid: process.pid, pid: 999999, url: "ws://127.0.0.1:2" }));

    const result = reapOrphanedManagedAppServers({ stateDir, graceMs: 500 });
    assert.equal(result.reaped.length, 1);
    assert.equal(result.reaped[0].pid, orphan.pid);
    assert.deepEqual(result.removed.map((r) => r.reason), ["pid-reused"]);
    assert.equal(result.kept.length, 1);
    await waitFor(() => !alive(orphan.pid), { timeoutMs: 3000, label: "orphan reaped" });
    assert.ok(alive(process.pid));
    assert.deepEqual(records(), ["999999.json"]);
  }

  console.log("app-server lifecycle tests passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
