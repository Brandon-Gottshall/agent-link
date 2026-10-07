#!/usr/bin/env node
// Regression: archiveLocalThread must survive a codexHome whose archived_sessions
// is a symlink onto a different filesystem (EXDEV). fs.rename alone throws EXDEV
// there; the archive path needs a copy+unlink fallback that preserves mtime and
// never leaves a partial .jsonl visible to discovery.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../tests/helpers/guard.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { archiveLocalThread, readLocalThread } from "../src/codex/session-index.js";

// Set AGENT_LINK_EXDEV_TEST_ROOT to a writable directory on a different volume.
const CROSS_DEVICE_ROOT = process.env.AGENT_LINK_EXDEV_TEST_ROOT || "";

async function crossDeviceAvailable() {
  try {
    const here = await stat(os.tmpdir());
    const there = await stat(CROSS_DEVICE_ROOT);
    return here.dev !== there.dev;
  } catch {
    return false;
  }
}

async function writeSession({ root, archived, id }) {
  const dir = path.join(root, archived ? "archived_sessions" : "sessions", "2026", "05", "03");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${id}.jsonl`);
  const records = [
    {
      timestamp: "2026-05-03T13:00:00.000Z",
      type: "session_meta",
      payload: {
        id,
        timestamp: "2026-05-03T13:00:00.000Z",
        cwd: "/tmp/codex-agent-link",
        source: "test",
        cli_version: "0.128.0-alpha.1",
        model_provider: "openai"
      }
    },
    {
      timestamp: "2026-05-03T13:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "exdev archive regression fixture" }
    }
  ];
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return file;
}

if (!(await crossDeviceAvailable())) {
  console.log(`SKIP archive-exdev-regression-test: no cross-device root at ${CROSS_DEVICE_ROOT}`);
  process.exit(0);
}

const tempHome = await mkdtemp(path.join(os.tmpdir(), "codex-agent-link-exdev-"));
const remoteArchive = await mkdtemp(path.join(CROSS_DEVICE_ROOT, ".agent-link-exdev-test-"));

try {
  // archived_sessions lives on the other filesystem, reached through a symlink.
  await symlink(remoteArchive, path.join(tempHome, "archived_sessions"));

  const threadId = "4ae8408d-a7da-7e0f-9c66-c434c07d7c71";
  const sourceFile = await writeSession({ root: tempHome, archived: false, id: threadId });
  const sourceStat = await stat(sourceFile);

  const result = await archiveLocalThread(threadId, { codexHome: tempHome });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyArchived, false);
  assert.equal(result.archiveStateAfter.scope, "archived");

  // Source is gone; destination holds identical content with preserved mtime.
  await assert.rejects(stat(sourceFile), { code: "ENOENT" });
  const destStat = await stat(result.to);
  assert.equal(destStat.size, sourceStat.size);
  assert.equal(
    Math.floor(destStat.mtimeMs / 1000),
    Math.floor(sourceStat.mtimeMs / 1000),
    "mtime must survive the cross-device fallback (thread ordering depends on it)"
  );
  const content = await readFile(result.to, "utf8");
  assert.match(content, /exdev archive regression fixture/);

  // No temp debris left where discovery scans.
  const archivedDir = path.dirname(result.to);
  const leftovers = (await readdir(archivedDir)).filter((name) => !name.endsWith(".jsonl"));
  assert.deepEqual(leftovers, [], `unexpected non-jsonl debris: ${leftovers.join(", ")}`);

  // The archived thread is still discoverable end-to-end.
  const found = await readLocalThread(threadId, { codexHome: tempHome });
  assert.equal(found.thread.archiveState.scope, "archived");

  // Second archive call reports alreadyArchived instead of erroring.
  const again = await archiveLocalThread(threadId, { codexHome: tempHome });
  assert.equal(again.alreadyArchived, true);

  console.log("PASS archive-exdev-regression-test");
} finally {
  await rm(tempHome, { recursive: true, force: true });
  await rm(remoteArchive, { recursive: true, force: true });
}
