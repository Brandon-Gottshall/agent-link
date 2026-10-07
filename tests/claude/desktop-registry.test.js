// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidecar } from "../../src/claude/desktop-registry.js";

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url)) + "/../fixtures/claude-sidecars";

// parseSidecar picks the documented fields and ignores the rest (older
// local-agent-mode sidecar shape, which still carries processName).
{
  const fp = FIXTURE_DIR + "/local_4acb50b2-5a15-49d1-a68e-afa1c409030d.json";
  const sess = parseSidecar(fp);
  assert.equal(sess.sessionId, "local_4acb50b2-5a15-49d1-a68e-afa1c409030d");
  assert.equal(sess.cliSessionId, "36a85a98-8e81-409b-8c1c-07cdaf004d57");
  assert.ok(sess.title.length > 0);
  assert.equal(sess.isArchived, true);
  assert.ok(Array.isArray(sess.userSelectedFolders));
  assert.equal(sess.sourceSidecar, fp);
  assert.equal(sess.processName, "blissful-wonderful-goldberg");
}

// P4-01: a current Claude Code sidecar has no processName. It must parse,
// keeping its title, archive state and prior CLI ids.
{
  const fp = FIXTURE_DIR + "/code-2026-10/local_0b5e7c1a-3f2d-4a6e-9c8b-1d2e3f4a5b6c.json";
  const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
  assert.equal(raw.processName, undefined, "fixture mirrors real sidecars: no processName");
  const sess = parseSidecar(fp);
  assert.equal(sess.sessionId, "local_0b5e7c1a-3f2d-4a6e-9c8b-1d2e3f4a5b6c");
  assert.equal(sess.cliSessionId, "7f3c2b1a-0e9d-4c8b-a7f6-5e4d3c2b1a09");
  assert.equal(sess.title, "Sample real-shaped Code session");
  assert.equal(sess.isArchived, true);
  assert.deepEqual(sess.priorCliSessionIds, ["11111111-2222-4333-8444-555555555555"]);
  assert.equal(sess.processName, undefined);
  assert.equal(sess.permissionMode, undefined, "unlisted fields are not copied");
}

// Sidecars written before the CLI starts have no cliSessionId, and untitled
// sessions have no title. Both still parse; title is null, not missing.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-registry-"));
  const fp = path.join(tmp, "local_fresh.json");
  fs.writeFileSync(fp, JSON.stringify({ sessionId: "local_fresh", cwd: "/tmp/x", model: "opus", isArchived: false }));
  const sess = parseSidecar(fp);
  assert.equal(sess.sessionId, "local_fresh");
  assert.equal(sess.cliSessionId, undefined);
  assert.equal(sess.title, null);

  // Only sessionId is required, and it must be a non-empty string.
  const bad = path.join(tmp, "local_bad.json");
  fs.writeFileSync(bad, JSON.stringify({ cwd: "/tmp/x" }));
  assert.throws(() => parseSidecar(bad), /missing required field sessionId/);
  fs.writeFileSync(bad, JSON.stringify(["not", "an", "object"]));
  assert.throws(() => parseSidecar(bad), /not a JSON object/);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("desktop-registry tests passed");
