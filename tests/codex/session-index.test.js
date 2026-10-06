// Local Codex transcript index: lookup by filename (newest first, confirmed by
// session_meta), status from the last lifecycle event, bounded head/tail
// reads (transcripts over V8's ~512 MB string limit), the (path, size, mtime)
// summary cache, recent items, archive without overwrite, and timestamps.
// Synthetic transcript trees only; never reads the real ~/.codex.
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveLocalThread,
  clearLocalThreadSummaryCache,
  findLocalThreadFile,
  listLocalThreadIds,
  listLocalThreads,
  readLocalThread
} from "../../src/codex/session-index.js";
import { rankThreadSummaries } from "../../src/codex/thread-utils.js";

const home = mkdtempSync(path.join(os.tmpdir(), "agent-link-index-"));
const sessions = path.join(home, "sessions");
const archived = path.join(home, "archived_sessions");
const id = (n) => `019d1000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const meta = (threadId, extra = {}) => ({
  timestamp: "2026-09-01T10:00:00.000Z",
  type: "session_meta",
  payload: { id: threadId, timestamp: "2026-09-01T10:00:00.000Z", cwd: "/tmp/project", source: "test", ...extra }
});
const event = (type, extra = {}, ts = "2026-09-01T10:00:05.000Z") => ({ timestamp: ts, type: "event_msg", payload: { type, ...extra } });
const userItem = (text) => event("item_completed", { item: { type: "UserMessage", id: "u", content: [{ type: "text", text }] } });
const agentItem = (text) => event("item_completed", { item: { type: "AgentMessage", id: "a", content: [{ type: "text", text }] } });
const agentResponse = (text) => ({ timestamp: "2026-09-01T10:00:06.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });

async function writeTranscript({ root = sessions, day = "2026/09/01", name, records }) {
  const dir = path.join(root, ...day.split("/"));
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fsp.writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

try {
  // --- P3-02: status comes from the last lifecycle event, real event names ---
  await writeTranscript({
    name: `rollout-2026-09-01T10-00-00-${id(1)}.jsonl`,
    records: [meta(id(1)), userItem("Idle thread"), event("task_started"), agentItem("Done."), agentResponse("Done."), event("task_complete"), event("token_count"), event("thread_settings_applied")]
  });
  await writeTranscript({
    name: `rollout-2026-09-01T10-00-00-${id(2)}.jsonl`,
    records: [meta(id(2)), userItem("Running thread"), event("task_started"), event("token_count"), event("item_completed", { item: { type: "CommandExecution", id: "c" } })]
  });
  await writeTranscript({
    name: `rollout-2026-09-01T10-00-00-${id(3)}.jsonl`,
    records: [meta(id(3)), userItem("Aborted thread"), event("task_started"), event("turn_aborted", { reason: "interrupted" }), event("token_count")]
  });
  await writeTranscript({
    name: `rollout-2026-09-01T10-00-00-${id(4)}.jsonl`,
    records: [meta(id(4), { timestamp: undefined }), userItem("No lifecycle yet"), event("token_count")]
  });
  const status = async (n) => (await readLocalThread(id(n), { codexHome: home })).thread.status;
  assert.equal((await status(1)).type, "idle", "task_complete then token_count is idle");
  assert.equal((await status(1)).lastLifecycleEvent, "task_complete");
  assert.equal((await status(2)).type, "possiblyActive");
  assert.equal((await status(3)).type, "idle", "turn_aborted ends the turn");
  assert.equal((await status(4)).type, "unknown");

  // A record straddling the 64 KiB head-window edge is read by the tail, not lost.
  {
    const edgeId = id(9);
    const lines = [JSON.stringify(meta(edgeId)), JSON.stringify(userItem("Edge thread")), JSON.stringify(event("task_started"))];
    const filler = JSON.stringify(event("token_count", { pad: "x".repeat(900) }));
    while (Buffer.byteLength(`${lines.join("\n")}\n${filler}\n`) < 65536 - 200) {
      lines.push(filler);
    }
    const prefixBytes = Buffer.byteLength(`${lines.join("\n")}\n`);
    // Pad so the record starts before byte 65,536 and ends ~200 bytes after it.
    const complete = JSON.stringify(event("task_complete", { pad: "y".repeat(65536 - prefixBytes + 200) }));
    assert.ok(prefixBytes < 65536 && prefixBytes + Buffer.byteLength(complete) > 65536, "task_complete spans byte 65,536");
    lines.push(complete);
    const dir = path.join(sessions, "2026", "09", "04");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `rollout-2026-09-04T10-00-00-${edgeId}.jsonl`), `${lines.join("\n")}\n`);
    const edge = (await readLocalThread(edgeId, { codexHome: home })).thread;
    assert.equal(edge.status.type, "idle", "boundary-straddling task_complete is seen");
    assert.equal(edge.status.lastLifecycleEvent, "task_complete");
  }

  // --- P3-18: createdAt is never NaN; updatedAt is whole seconds ---
  const noTimestamp = (await readLocalThread(id(4), { codexHome: home })).thread;
  assert.equal(noTimestamp.createdAt, null);
  assert.ok(Number.isInteger(noTimestamp.updatedAt), `updatedAt ${noTimestamp.updatedAt} is an integer`);
  const withTimestamp = (await readLocalThread(id(1), { codexHome: home })).thread;
  assert.equal(withTimestamp.createdAt, Date.parse("2026-09-01T10:00:00.000Z") / 1000);
  assert.ok(Number.isInteger(withTimestamp.updatedAt));
  assert.equal(withTimestamp.preview, "Idle thread", "preview from item_completed UserMessage");
  assert.equal(withTimestamp.lastAgentMessage, "Done.");

  // --- P3-01: filename lookup, newest directory first, confirmed by session_meta ---
  // Same id in an older day directory: the newest one wins without scanning.
  await writeTranscript({ day: "2026/08/01", name: `rollout-2026-08-01T10-00-00-${id(1)}.jsonl`, records: [meta(id(1), { cwd: "/tmp/older" })] });
  const found = await findLocalThreadFile(id(1), { codexHome: home });
  assert.equal(found.lookup, "filename");
  assert.match(found.file, /2026\/09\/01/);
  // A file whose name claims an id but whose session_meta says otherwise is not a match.
  await writeTranscript({ day: "2026/09/02", name: `rollout-2026-09-02T10-00-00-${id(5)}.jsonl`, records: [meta(id(6))] });
  // A transcript whose filename does not carry its id is still found by the fallback scan.
  await writeTranscript({ day: "2026/07/01", name: "legacy-name.jsonl", records: [meta(id(5)), userItem("Legacy file")] });
  const legacy = await readLocalThread(id(5), { codexHome: home });
  assert.equal(legacy.thread.lookup, "scan");
  assert.equal(legacy.thread.preview, "Legacy file");
  assert.equal(await findLocalThreadFile("../../etc/passwd", { codexHome: home }), null);
  assert.equal(await findLocalThreadFile(id(999), { codexHome: home }), null);
  // Filename ids without reading files (thread-id suggestions).
  const ids = (await listLocalThreadIds({ codexHome: home })).map((entry) => entry.id);
  assert.ok(ids.includes(id(1)) && ids.includes(id(2)));

  // --- P2-04 local path: recentItems counts items, newest last, duplicates folded ---
  const recent = await readLocalThread(id(1), { codexHome: home, includeTurns: true, recentItems: 3 });
  assert.equal(recent.thread.recentItems.length, 3);
  assert.deepEqual(recent.thread.recentItems.map((item) => item.type), ["task_started", "agentMessage", "task_complete"]);
  const all = await readLocalThread(id(1), { codexHome: home, includeTurns: true, recentItems: 100 });
  assert.equal(all.thread.recentItems.filter((item) => item.type === "agentMessage" && item.text === "Done.").length, 1, "response_item + item_completed copy of one message is folded");
  assert.equal(all.thread.recentItems.at(-1).type, "task_complete");

  // --- P3-03: a transcript larger than V8's string limit (sparse file) ---
  const hugeId = id(7);
  const hugeFile = path.join(sessions, "2026", "09", "03", `rollout-2026-09-03T10-00-00-${hugeId}.jsonl`);
  await fsp.mkdir(path.dirname(hugeFile), { recursive: true });
  const head = `${JSON.stringify(meta(hugeId))}\n${JSON.stringify(userItem("Huge transcript"))}\n`;
  const tail = `\n${[event("task_started"), agentItem("Tail answer"), event("task_complete"), event("token_count")].map((r) => JSON.stringify(r)).join("\n")}\n`;
  const hugeSize = 600 * 1024 * 1024;
  const handle = await fsp.open(hugeFile, "w");
  await handle.write(head, 0);
  await handle.truncate(hugeSize);
  await handle.write(tail, hugeSize);
  await handle.close();
  const hugeStat = await fsp.stat(hugeFile);
  assert.ok(hugeStat.size > 0x1fffffe8, "fixture exceeds V8's max string length");
  const huge = await readLocalThread(hugeId, { codexHome: home, includeTurns: true, recentItems: 2 });
  assert.equal(huge.thread.preview, "Huge transcript");
  assert.equal(huge.thread.status.type, "idle");
  assert.equal(huge.thread.lastAgentMessage, "Tail answer");
  assert.deepEqual(huge.thread.recentItems.map((item) => item.type), ["agentMessage", "task_complete"]);
  const listedHuge = await listLocalThreads({ codexHome: home, limit: 50 });
  assert.ok(listedHuge.data.some((thread) => thread.id === hugeId), "huge transcript is listed, not silently dropped");

  // --- P3-04: unchanged transcripts are served from the (path, size, mtime) cache ---
  clearLocalThreadSummaryCache();
  await listLocalThreads({ codexHome: home, archiveScope: "all", limit: 50 });
  const realOpen = fsp.open;
  let opens = 0;
  fsp.open = async (...args) => {
    opens += 1;
    return realOpen.apply(fsp, args);
  };
  try {
    await listLocalThreads({ codexHome: home, archiveScope: "all", limit: 50 });
    assert.equal(opens, 0, "second listing reopens no transcript");
    // Appending invalidates exactly that entry.
    const runningFile = (await findLocalThreadFile(id(1), { codexHome: home })).file;
    await fsp.appendFile(runningFile, `${JSON.stringify(event("task_started", {}, "2026-09-01T11:00:00.000Z"))}\n`);
    opens = 0;
    const relisted = await listLocalThreads({ codexHome: home, archiveScope: "all", limit: 50 });
    assert.equal(opens, 1, "only the changed transcript is reread");
    assert.equal(relisted.data.find((thread) => thread.id === id(1)).status.type, "possiblyActive");
  } finally {
    fsp.open = realOpen;
  }

  // --- P3-18: archive never overwrites an existing destination ---
  const archiveId = id(8);
  const source = await writeTranscript({ name: `rollout-2026-09-01T10-00-00-${archiveId}.jsonl`, records: [meta(archiveId), userItem("Archive me")] });
  const destination = path.join(archived, "2026", "09", "01", path.basename(source));
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, "precious existing archive\n");
  await assert.rejects(archiveLocalThread(archiveId, { codexHome: home }), /already exists/);
  assert.equal(await fsp.readFile(destination, "utf8"), "precious existing archive\n", "existing archive untouched");
  await fsp.access(source);
  await fsp.rm(destination);
  const moved = await archiveLocalThread(archiveId, { codexHome: home });
  assert.equal(moved.archiveStateAfter.scope, "archived");
  await assert.rejects(fsp.access(source));
  assert.match(await fsp.readFile(destination, "utf8"), /Archive me/);

  // --- P3-13: equal scores tie-break by recency for Unix-second timestamps ---
  const ranked = rankThreadSummaries([
    { id: "older", name: "Alpha Project", updatedAt: 1779000000 },
    { id: "newer", name: "Alpha Project", updatedAt: 1779086400 },
    { id: "iso", name: "Alpha Project", updatedAt: "2026-05-17T00:00:00.000Z" }
  ], "Alpha Project", 3);
  // newer = 1779086400 s, older = 1779000000 s, iso = 1778976000 s.
  assert.deepEqual(ranked.map((thread) => thread.id), ["newer", "older", "iso"]);

  console.log("session index tests passed");
} finally {
  rmSync(home, { recursive: true, force: true });
}
