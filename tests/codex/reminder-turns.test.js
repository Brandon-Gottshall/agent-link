// Design doc R7.14, Codex path (B7a, behind AGENT_LINK_CODEX_REMINDERS,
// default off until the B7 spike, B7b): a due reminder for a Codex thread
// becomes a reminder turn (turn/start, turnTrigger "agent-link-reminder")
// whose text is exactly the reminder notice, only when the thread is idle.
// An active turn is never steered; a thread that is not loaded is left to
// inbox pull. Runs against the stub app-server (managed spawn); never
// launches Codex.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stubAppServer } from "../helpers/codex-stub.js";

// Short on purpose: Unix socket paths are limited to ~104 bytes.
const tmp = mkdtempSync(path.join(os.tmpdir(), "al-rem-"));
const turnLog = path.join(tmp, "turns.log");
const IDLE = "7c000000-0000-4000-8000-000000000001";
const ACTIVE = "7c000000-0000-4000-8000-000000000002";
const COLD = "7c000000-0000-4000-8000-000000000003";
for (const name of Object.keys(process.env)) {
  if (/^(CODEX_AGENT_LINK_|CODEX_APP_SERVER_|AGENT_LINK_)/.test(name)) delete process.env[name];
}
process.env.CODEX_AGENT_LINK_APP_SERVER_BIN = stubAppServer;
process.env.CODEX_AGENT_LINK_STATE_DIR = path.join(tmp, "st");
process.env.AGENT_LINK_STUB_TURN_LOG = turnLog;
process.env.AGENT_LINK_STUB_THREAD_STATUS = JSON.stringify({ [IDLE]: "idle", [ACTIVE]: "active" });

const { CodexAppServerClient } = await import("../../src/codex/app-server-client.js");
const { openMailbox } = await import("../../src/claude/mailbox.js");
const { CODEX_REMINDER_TURN_TRIGGER, codexRemindersEnabled, deliverCodexReminders } = await import("../../src/delivery/reminders.js");
const { renderReminderNotice } = await import("../../src/shared/envelope.js");
const { loadConfig } = await import("../../src/server/config.js");

const SETTINGS = { limit: 3, intervalMs: 30_000, warnings: [] };
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const SENDER = "local_7c000000-0000-4000-8000-0000000000aa";

const turns = () => {
  try {
    return readFileSync(turnLog, "utf8").trim().split("\n").filter(Boolean).map((line) => {
      const space = line.indexOf(" ");
      return { method: line.slice(0, space), params: JSON.parse(line.slice(space + 1)) };
    });
  } catch {
    return [];
  }
};

const mailboxPath = path.join(tmp, "mailbox.jsonl");
const mb = openMailbox({ mailboxPath });
/** @type {Record<string, string>} */
const ids = {};
for (const threadId of [IDLE, ACTIVE, COLD]) {
  ids[threadId] = mb.insertMessage({
    fromSessionId: SENDER,
    fromSessionKind: "claude",
    toSessionId: threadId,
    toSessionKind: "codex",
    body: "please confirm the schema",
    anticipation: "reply"
  });
  mb.markDelivered({ messageId: ids[threadId], deliveredAt: T0 });
}
// fyi mail to an idle thread never produces a reminder.
const fyi = mb.insertMessage({ fromSessionId: SENDER, fromSessionKind: "claude", toSessionId: IDLE, toSessionKind: "codex", body: "fyi", anticipation: "fyi" });
mb.markDelivered({ messageId: fyi, deliveredAt: T0 - 600_000 });

const client = new CodexAppServerClient({ idleTimeoutMs: 0 });
try {
  // Off by default (B7b decides).
  assert.equal(codexRemindersEnabled({}), false);
  assert.equal(codexRemindersEnabled({ AGENT_LINK_CODEX_REMINDERS: "1" }), true);
  assert.equal(loadConfig({}).codexReminders, false);

  // Not due yet: nothing is read or sent.
  assert.deepEqual(await deliverCodexReminders({ appServer: client, mailbox: mb, now: T0 + 29_999, settings: SETTINGS }), []);
  assert.equal(turns().length, 0);

  // Due: only the idle thread gets a turn.
  const results = await deliverCodexReminders({ appServer: client, mailbox: mb, now: T0 + 30_000, settings: SETTINGS });
  const byThread = Object.fromEntries(results.map((r) => [r.threadId, r.outcome]));
  assert.deepEqual(byThread, { [IDLE]: "sent", [ACTIVE]: "busy", [COLD]: "not_loaded" });
  const sent = turns();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "turn/start");
  assert.equal(sent[0].params.threadId, IDLE);
  assert.equal(sent[0].params.turnTrigger, CODEX_REMINDER_TURN_TRIGGER);
  const expected = renderReminderNotice([mb.getMessage({ messageId: ids[IDLE] })], { reminder: 1, limit: 3 });
  assert.deepEqual(sent[0].params.input, [{ type: "text", text: expected, text_elements: [] }]);
  assert.ok(!expected.includes("please confirm"), "the turn quotes no peer text");
  assert.deepEqual(mb.getMessage({ messageId: ids[IDLE] }).reminders.map((r) => [r.n, r.via]), [[1, "codex-turn"]]);
  assert.equal(mb.getMessage({ messageId: ids[ACTIVE] }).reminders.length, 0, "an active thread waits for its turn to end");

  // Inside the interval: no second turn.
  await deliverCodexReminders({ appServer: client, mailbox: mb, now: T0 + 45_000, settings: SETTINGS });
  assert.equal(turns().length, 1);

  // A second server racing for the same due reminder sends nothing.
  const other = openMailbox({ mailboxPath });
  const [mine, theirs] = await Promise.all([
    deliverCodexReminders({ appServer: client, mailbox: mb, now: T0 + 60_000, settings: SETTINGS }),
    deliverCodexReminders({ appServer: client, mailbox: other, now: T0 + 60_000, settings: SETTINGS })
  ]);
  const idleOutcomes = [...mine, ...theirs].filter((r) => r.threadId === IDLE).map((r) => r.outcome).sort();
  assert.deepEqual(idleOutcomes, ["claimed_elsewhere", "sent"]);
  assert.equal(turns().length, 2);
  other.close();

  // Never a turn/steer for a reminder.
  assert.ok(turns().every((t) => t.method === "turn/start"));
  console.log("reminder-turns tests passed");
} finally {
  await client.close?.();
  mb.close();
  rmSync(tmp, { recursive: true, force: true });
}
