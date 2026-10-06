// health.legacyState (R4.7) and health.recentEvents redaction.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGACY_STILL_WRITTEN_WARNING, legacyStateReport } from "../../src/shared/legacy-state.js";
import { redactEvents } from "../../src/tools/health.js";
import { reapOrphanedManagedAppServers } from "../../src/codex/app-server-client.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-legacy-"));
const env = { HOME: home, CODEX_HOME: path.join(home, ".codex") };
const options = { env, homedir: home };

try {
  // Nothing on disk: no files, no migration record, nothing created.
  let report = legacyStateReport(options);
  assert.deepEqual(report, { files: [], migration: null, stillWritten: false, warning: null });
  assert.equal(fs.existsSync(path.join(home, ".agent-link")), false, "health never creates the state dir");

  // Legacy files present, no migration record yet: reported, writtenAfterMigration unknown.
  const legacyMailbox = path.join(home, ".claude", "agent-link", "mailbox.jsonl");
  const legacyReceipts = path.join(home, ".codex", "agent-link-receipts.jsonl");
  fs.mkdirSync(path.dirname(legacyMailbox), { recursive: true });
  fs.mkdirSync(path.dirname(legacyReceipts), { recursive: true });
  fs.writeFileSync(legacyMailbox, "{}\n");
  fs.writeFileSync(legacyReceipts, "{}\n");
  const old = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(legacyMailbox, old, old);
  fs.utimesSync(legacyReceipts, old, old);
  report = legacyStateReport(options);
  assert.deepEqual(report.files.map((file) => [file.kind, file.path, file.modifiedAt, file.writtenAfterMigration]), [
    ["mailbox", legacyMailbox, old.toISOString(), null],
    ["receipts", legacyReceipts, old.toISOString(), null]
  ]);
  assert.equal(report.stillWritten, false);

  // With a migration record: files older than it are fine; one modified
  // after it means an older plugin copy is still writing.
  fs.mkdirSync(path.join(home, ".agent-link"), { recursive: true });
  fs.writeFileSync(path.join(home, ".agent-link", "migration.json"), JSON.stringify({ from: [legacyMailbox], at: "2026-06-01T00:00:00.000Z", version: "0.5.0" }));
  report = legacyStateReport(options);
  assert.equal(report.migration.at, "2026-06-01T00:00:00.000Z");
  assert.deepEqual(report.migration.from, [legacyMailbox]);
  assert.ok(report.files.every((file) => file.writtenAfterMigration === false));
  assert.equal(report.warning, null);
  fs.utimesSync(legacyMailbox, new Date(), new Date());
  report = legacyStateReport(options);
  assert.equal(report.files.find((file) => file.kind === "mailbox").writtenAfterMigration, true);
  assert.equal(report.stillWritten, true);
  assert.equal(report.warning, LEGACY_STILL_WRITTEN_WARNING);
  assert.match(report.warning, /Upgrade the plugin in every harness/);

  // Review I2: this version reaping a stale record in the legacy managed
  // app-server directory (which bumps the directory's mtime) is not "still
  // written"; a record written there after the migration is.
  fs.utimesSync(legacyMailbox, old, old);
  const legacyManaged = path.join(home, ".claude", "agent-link", "managed-app-servers");
  fs.mkdirSync(legacyManaged, { recursive: true });
  const kept = path.join(legacyManaged, "4242.json");
  fs.writeFileSync(kept, JSON.stringify({ pid: 4242, ownerPid: process.pid }));
  fs.utimesSync(kept, old, old);
  const stale = path.join(legacyManaged, "999999.json");
  fs.writeFileSync(stale, JSON.stringify({ pid: 999999, ownerPid: 999998 }));
  fs.utimesSync(stale, old, old);
  const reap = reapOrphanedManagedAppServers({ stateDir: legacyManaged });
  assert.deepEqual(reap.removed.map((entry) => entry.reason), ["not-running"]);
  assert.equal(fs.existsSync(stale), false);
  assert.ok(fs.statSync(legacyManaged).mtimeMs > Date.parse("2026-06-01T00:00:00.000Z"), "the reap bumped the directory mtime");
  report = legacyStateReport(options);
  const managed = report.files.find((file) => file.kind === "managedAppServers");
  assert.equal(managed.modifiedAt, old.toISOString(), "managed dirs report their newest record");
  assert.equal(managed.writtenAfterMigration, false);
  assert.equal(report.stillWritten, false);
  fs.writeFileSync(path.join(legacyManaged, "5151.json"), JSON.stringify({ pid: 5151, ownerPid: process.pid }));
  report = legacyStateReport(options);
  assert.equal(report.files.find((file) => file.kind === "managedAppServers").writtenAfterMigration, true);
  assert.equal(report.stillWritten, true);

  // An explicit mailbox path is never mixed with legacy files.
  report = legacyStateReport({ env: { ...env, AGENT_LINK_MAILBOX_PATH: path.join(home, "m.jsonl") }, homedir: home });
  assert.ok(!report.files.some((file) => file.kind === "mailbox"));
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

// recentEvents never carries stacks or app-server output to the model.
{
  const events = [
    { at: "2026-10-06T00:00:00.000Z", level: "error", event: "process.uncaught_exception", fields: { error: { name: "Error", message: "boom" }, stack: "Error: boom\n    at x (/path/file.js:1:1)" } },
    { at: "2026-10-06T00:00:01.000Z", level: "warn", event: "app_server.exit", fields: { code: 1, outputTail: "secret-ish output", stderr: "x", logs: ["a"] } },
    { at: "2026-10-06T00:00:02.000Z", level: "info", event: "app_server.idle_release" }
  ];
  const redacted = redactEvents(events);
  assert.equal(redacted[0].fields.stack, "[redacted]");
  assert.deepEqual(redacted[0].fields.error, { name: "Error", message: "boom" });
  assert.equal(redacted[1].fields.outputTail, "[redacted]");
  assert.equal(redacted[1].fields.stderr, "[redacted]");
  assert.equal(redacted[1].fields.logs, "[redacted]");
  assert.equal(redacted[1].fields.code, 1);
  assert.deepEqual(redacted[2], events[2]);
  assert.ok(!JSON.stringify(redacted).includes("/path/file.js"));
  assert.equal(events[0].fields.stack.includes("/path/file.js"), true, "the ring buffer itself is not modified");

  // Review m4: redaction is recursive, and an internal error's message is
  // hidden like the envelope hides it.
  const nested = redactEvents([
    { at: "t", level: "warn", event: "app_server.exit", fields: { details: { logs: ["x"], inner: [{ outputTail: "y", ok: 1 }] } } },
    { at: "t", level: "error", event: "tool.internal_error", fields: { tool: "get_codex_thread", error: { name: "TypeError", message: "secret /path detail" } } }
  ]);
  assert.equal(nested[0].fields.details.logs, "[redacted]");
  assert.deepEqual(nested[0].fields.details.inner, [{ outputTail: "[redacted]", ok: 1 }]);
  assert.deepEqual(nested[1].fields.error, { name: "TypeError", message: "[redacted]" });
  assert.equal(nested[1].fields.tool, "get_codex_thread");
}

console.log("legacy-state tests passed");
