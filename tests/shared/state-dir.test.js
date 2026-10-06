// tests/shared/state-dir.test.js
//
// Design doc section 4.5: the ~/.agent-link state directory, migration from
// the 0.4.x locations, and agreement between the hook and the server.
//
//   T-4.2  the hook and the server, run with the same env from different
//          working directories, use the same mailbox
//   T-4.3  a legacy-only mailbox with 3 pending messages stays readable, new
//          events land in ~/.agent-link/mailbox.jsonl, the legacy file is
//          byte-identical afterwards (receipts likewise)
//   T-4.4  created state files are 0600 and directories 0700
//
// Every case uses a throwaway HOME; nothing here can touch the real
// ~/.agent-link, ~/.claude or ~/.codex.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mailboxStatus, openMailbox } from "../../src/claude/mailbox.js";
import { PathConfigError } from "../../src/shared/paths.js";
import { appendReceipt, buildReceipt, listReceipts, receiptIndexSummary } from "../../src/shared/receipt-index.js";
import { hermeticEnv, makeTempHome } from "../helpers/env.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOTIFY_HOOK = path.join(repoRoot, "src", "claude", "notify-hook.js");

const RECEIVER = "state-dir-receiver-0001";
const SENDER = "local_1a2b3c4d-0000-4000-8000-00000000000b";
const OTHER_SENDER = "local_1a2b3c4d-0000-4000-8000-00000000000c";

// In-process cases resolve paths from process.env: start from a clean slate
// and give each case its own HOME.
for (const key of Object.keys(process.env)) {
  if (/^(CODEX_|CLAUDE_|AGENT_LINK_)/.test(key)) delete process.env[key];
}
function useHome() {
  const home = makeTempHome("agent-link-state-");
  process.env.HOME = home;
  process.env.CODEX_HOME = path.join(home, ".codex");
  return home;
}

const mode = (file) => fs.statSync(file).mode & 0o777;
const legacyMailbox = (home) => path.join(home, ".claude", "agent-link", "mailbox.jsonl");
const newMailbox = (home) => path.join(home, ".agent-link", "mailbox.jsonl");

function writeLegacyMailbox(home, count) {
  const file = legacyMailbox(home);
  const mb = openMailbox({ mailboxPath: file });
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(mb.insertMessage({
      fromSessionId: SENDER,
      fromSessionKind: "claude",
      toSessionId: RECEIVER,
      toSessionKind: "claude",
      body: `legacy message ${i}`
    }));
  }
  return { file, ids, bytes: fs.readFileSync(file) };
}

test("T-4.3 mailbox: legacy-only pending mail is read, new events go to ~/.agent-link, legacy is byte-identical", () => {
  const home = useHome();
  const legacy = writeLegacyMailbox(home, 3);
  const legacyDirBefore = fs.readdirSync(path.dirname(legacy.file)).sort();

  // Health-style status is read-only: it counts legacy mail without creating
  // the state dir.
  const status = mailboxStatus();
  assert.equal(status.path, newMailbox(home));
  assert.equal(status.exists, false);
  assert.equal(status.pendingMessagesCount, 3);
  assert.deepEqual(status.legacyReadPaths, [legacy.file]);
  assert.equal(fs.existsSync(path.join(home, ".agent-link")), false, "status must not create ~/.agent-link");

  const mb = openMailbox();
  const pending = mb.listPendingFor({ toSessionId: RECEIVER });
  assert.deepEqual(pending.map((m) => m.id), legacy.ids, "all 3 legacy messages are pending after upgrade");

  // Deliver one, acknowledge-with-reply another, and send a new message.
  const drained = mb.drainFor({ toSessionId: RECEIVER, limit: 1 });
  assert.deepEqual(drained.map((m) => m.id), [legacy.ids[0]]);
  const replyId = mb.ackMessage({ messageId: legacy.ids[1], body: "reply from the new plugin" });
  assert.ok(replyId);
  const fresh = mb.insertMessage({ fromSessionId: OTHER_SENDER, fromSessionKind: "claude", toSessionId: RECEIVER, toSessionKind: "claude", body: "new" });

  assert.deepEqual(fs.readFileSync(legacy.file), legacy.bytes, "legacy mailbox is byte-identical");
  assert.deepEqual(fs.readdirSync(path.dirname(legacy.file)).sort(), legacyDirBefore, "nothing new in the legacy dir");

  const newEvents = fs.readFileSync(newMailbox(home), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(newEvents.map((e) => e.type), ["delivered", "acknowledged", "message", "message"]);
  assert.equal(newEvents[2].message.id, replyId);
  assert.equal(newEvents[2].message.to_session_id, SENDER, "the reply goes back to the legacy sender");

  const after = mb.listPendingFor({ toSessionId: RECEIVER }).map((m) => m.id);
  assert.deepEqual(after, [legacy.ids[1], legacy.ids[2], fresh], "delivery recorded in the new file applies to a legacy message");
  const acked = mb.getMessage({ messageId: legacy.ids[1] });
  assert.ok(acked.acknowledged_at, "acknowledgement in the new file applies to a legacy message");
  assert.equal(mb.inspect({ limit: 100 }).length, 5);
});

test("T-4.3 mailbox: a message in both files is listed once and state events apply in time order", () => {
  const home = useHome();
  const legacy = writeLegacyMailbox(home, 1);
  const [id] = legacy.ids;
  const legacyLine = fs.readFileSync(legacy.file, "utf8").trim();
  const at = JSON.parse(legacyLine).at;
  fs.mkdirSync(path.join(home, ".agent-link"), { recursive: true, mode: 0o700 });
  // A copy of the same message in the new file, plus deliver (newer) in the
  // new file and release (older) in the legacy file.
  fs.writeFileSync(newMailbox(home), [
    legacyLine,
    JSON.stringify({ type: "delivered", at: at + 20, messageId: id })
  ].join("\n") + "\n", { mode: 0o600 });
  fs.appendFileSync(legacy.file, JSON.stringify({ type: "released", at: at + 10, messageId: id }) + "\n");
  const bytes = fs.readFileSync(legacy.file);

  const mb = openMailbox();
  const rows = mb.inspect({ limit: 100 });
  assert.equal(rows.length, 1, "deduped by id");
  assert.equal(rows[0].delivered_at, at + 20, "the later delivery wins over the earlier release");
  assert.deepEqual(fs.readFileSync(legacy.file), bytes);
});

test("an explicit mailbox path is read alone (no legacy merge)", () => {
  const home = useHome();
  writeLegacyMailbox(home, 2);
  const explicit = path.join(home, "explicit", "box.jsonl");
  process.env.AGENT_LINK_MAILBOX_PATH = explicit;
  try {
    const mb = openMailbox();
    assert.equal(mb.inspect({ limit: 100 }).length, 0);
    assert.equal(mailboxStatus().pendingMessagesCount, 0);
    assert.equal(fs.existsSync(path.join(home, ".agent-link")), false, "an explicit mailbox does not create the state dir");
  } finally {
    delete process.env.AGENT_LINK_MAILBOX_PATH;
  }
});

test("relative mailbox and receipt settings fail clearly instead of resolving against cwd", async () => {
  useHome();
  process.env.AGENT_LINK_MAILBOX_PATH = "relative/mailbox.jsonl";
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = "receipts.jsonl";
  try {
    assert.throws(() => openMailbox(), PathConfigError);
    assert.throws(() => mailboxStatus(), /AGENT_LINK_MAILBOX_PATH must be an absolute path/);
    await assert.rejects(listReceipts(), /CODEX_AGENT_LINK_RECEIPT_LOG must be an absolute path/);
    const summary = receiptIndexSummary();
    assert.equal(summary.path, null);
    assert.match(summary.error, /CODEX_AGENT_LINK_RECEIPT_LOG/);
  } finally {
    delete process.env.AGENT_LINK_MAILBOX_PATH;
    delete process.env.CODEX_AGENT_LINK_RECEIPT_LOG;
  }
});

function receipt(threadId) {
  return buildReceipt({ action: "message_thread", receipt: { purpose: "state-dir test" }, target: { threadId }, message: "m", appServer: {} });
}

test("T-4.3 receipts: legacy and new logs merge, duplicates by id once, writes only to ~/.agent-link", async () => {
  const home = useHome();
  const legacyLog = path.join(home, ".codex", "agent-link-receipts.jsonl");
  const old1 = receipt("thread-old-1");
  const old2 = receipt("thread-old-2");
  fs.writeFileSync(legacyLog, [old1, old2].map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o644 });
  const bytes = fs.readFileSync(legacyLog);

  assert.deepEqual(receiptIndexSummary().readPaths, [legacyLog, path.join(home, ".agent-link", "receipts.jsonl")]);
  const appended = await appendReceipt(receipt("thread-new"));
  assert.equal(appended.path, path.join(home, ".agent-link", "receipts.jsonl"));
  // A copied receipt (same id) in the new log is listed once.
  await appendReceipt(old2);

  const listed = await listReceipts({ limit: 50 });
  assert.equal(listed.path, appended.path);
  assert.equal(listed.scannedReceipts, 3);
  assert.deepEqual(listed.data.map((r) => r.target.threadId).sort(), ["thread-new", "thread-old-1", "thread-old-2"]);
  assert.deepEqual(fs.readFileSync(legacyLog), bytes, "legacy receipt log is byte-identical");
  assert.equal(mode(legacyLog), 0o644, "legacy file mode is left alone");

  // An explicit receipt log is read alone.
  const explicit = path.join(home, "only.jsonl");
  assert.deepEqual((await listReceipts({ path: explicit })).data, []);
});

test("T-4.4 created state files are 0600 and directories 0700; migration.json records legacy files", async () => {
  const home = useHome();
  const legacy = writeLegacyMailbox(home, 1);
  const state = path.join(home, ".agent-link");
  // A pre-existing, looser state dir (made by hand) is tightened.
  fs.mkdirSync(state, { mode: 0o755 });
  fs.chmodSync(state, 0o755);

  openMailbox().insertMessage({ fromSessionId: SENDER, fromSessionKind: "claude", toSessionId: RECEIVER, toSessionKind: "claude", body: "x" });
  await appendReceipt(receipt("thread-mode"));

  assert.equal(mode(state), 0o700);
  assert.equal(mode(path.join(state, "mailbox.jsonl")), 0o600);
  assert.equal(mode(path.join(state, "receipts.jsonl")), 0o600);
  const migrationFile = path.join(state, "migration.json");
  assert.equal(mode(migrationFile), 0o600);
  const migration = JSON.parse(fs.readFileSync(migrationFile, "utf8"));
  assert.deepEqual(migration.from, [legacy.file]);
  assert.ok(!Number.isNaN(Date.parse(migration.at)));

  // Written once: a later open keeps the first record.
  const first = fs.readFileSync(migrationFile, "utf8");
  openMailbox();
  assert.equal(fs.readFileSync(migrationFile, "utf8"), first);
});

test("T-4.4 with AGENT_LINK_STATE_DIR the state dir and its files are created private", () => {
  const home = useHome();
  const custom = path.join(home, "custom", "state");
  process.env.AGENT_LINK_STATE_DIR = custom;
  try {
    const mb = openMailbox();
    mb.insertMessage({ fromSessionId: SENDER, fromSessionKind: "claude", toSessionId: RECEIVER, toSessionKind: "claude", body: "x" });
    assert.equal(mode(custom), 0o700);
    assert.equal(mode(path.join(custom, "mailbox.jsonl")), 0o600);
    assert.equal(fs.existsSync(path.join(home, ".agent-link")), false);
  } finally {
    delete process.env.AGENT_LINK_STATE_DIR;
  }
});

// --- T-4.2: hook and server agree -------------------------------------------

function spawnHook(env, cwd, payload) {
  const out = execFileSync(process.execPath, [NOTIFY_HOOK], {
    input: JSON.stringify(payload),
    env,
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  return JSON.parse(out);
}

async function serverHealth(env) {
  const client = new Client({ name: "state-dir-test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "src", "server.js")],
    cwd: repoRoot,
    env,
    stderr: "ignore"
  }));
  try {
    const result = await client.callTool({ name: "agent_link_health", arguments: { startAppServer: false } });
    return JSON.parse(result.content[0].text);
  } finally {
    await client.close();
  }
}

test("T-4.2 the hook (another cwd) and the server resolve the same mailbox, legacy mail included", async () => {
  const home = makeTempHome("agent-link-agree-");
  const env = hermeticEnv({
    home,
    overrides: { AGENT_LINK_CODEX_AUTOSTART: "0", AGENT_LINK_DISABLE_CHANNEL: "1", AGENT_LINK_HOST: "claude" }
  });
  const health = await serverHealth(env);
  const serverMailbox = health.claude.mailbox.path;
  assert.equal(serverMailbox, newMailbox(home));
  assert.equal(health.receiptIndex.path, path.join(home, ".agent-link", "receipts.jsonl"));
  assert.equal(health.host, "claude");
  assert.equal(health.hostDetection, "AGENT_LINK_HOST=claude");
  assert.equal(fs.existsSync(path.join(home, ".agent-link")), false, "health and startup never create ~/.agent-link");

  // One message in the legacy file, one in the file the server reported.
  const legacyBox = openMailbox({ mailboxPath: legacyMailbox(home) });
  legacyBox.insertMessage({ fromSessionId: SENDER, fromSessionKind: "claude", toSessionId: RECEIVER, toSessionKind: "claude", body: "legacy" });
  const box = openMailbox({ mailboxPath: serverMailbox });
  box.insertMessage({ fromSessionId: OTHER_SENDER, fromSessionKind: "claude", toSessionId: RECEIVER, toSessionKind: "claude", body: "new" });

  const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-hook-cwd-"));
  try {
    const transcriptPath = path.join(otherCwd, `${RECEIVER}.jsonl`);
    fs.writeFileSync(transcriptPath, JSON.stringify({ sessionId: RECEIVER }) + "\n");
    const parsed = spawnHook(env, otherCwd, { session_id: RECEIVER, transcript_path: transcriptPath, hook_event_name: "UserPromptSubmit" });
    const context = parsed.hookSpecificOutput?.additionalContext ?? "";
    assert.match(context, /2 pending messages/, "the hook sees both the server's mailbox and the legacy one");
    assert.match(context, new RegExp(SENDER));
    assert.match(context, new RegExp(OTHER_SENDER));

    // Same env with a relative override: the hook stays silent and names the
    // misconfigured variable on stderr (it must never fail the prompt).
    const run = spawnSync(process.execPath, [NOTIFY_HOOK], {
      input: JSON.stringify({ session_id: RECEIVER, transcript_path: transcriptPath, hook_event_name: "UserPromptSubmit" }),
      env: { ...env, AGENT_LINK_MAILBOX_PATH: "mailbox.jsonl" },
      cwd: otherCwd,
      encoding: "utf8"
    });
    assert.equal(run.status, 0, "the hook must exit 0");
    assert.deepEqual(JSON.parse(run.stdout), {});
    assert.match(run.stderr, /notify-hook: mailbox error: AGENT_LINK_MAILBOX_PATH must be an absolute path/);
    assert.equal(fs.existsSync(path.join(otherCwd, "mailbox.jsonl")), false, "no file created relative to the hook's cwd");
  } finally {
    fs.rmSync(otherCwd, { recursive: true, force: true });
  }
});
