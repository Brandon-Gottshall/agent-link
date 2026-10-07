// R7.10 under concurrency (review item I1): several processes resolve the
// same message at once. Exactly one resolution may succeed; the others get
// already_resolved, and the mailbox holds exactly one `resolved` event.
// Each trial starts 4 child processes behind a barrier (ready files, then one
// go file) so they race as tightly as separate processes can.
//
// AGENT_LINK_RACE_SRC_ROOT points the children at another checkout's src/
// (for example the pre-fix commit, which must fail this test).
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openMailbox } from "../../src/claude/mailbox.js";
import { hermeticEnv } from "../helpers/env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..", "..");
const srcRoot = process.env.AGENT_LINK_RACE_SRC_ROOT || pluginRoot;
const racer = path.join(pluginRoot, "tests", "helpers", "resolve-racer.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-race-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const uuid = (n) => `7a000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const TRIALS = 12;

function seed(mailboxPath) {
  const mb = openMailbox({ mailboxPath });
  try {
    return mb.insertMessage({
      fromSessionId: `local_${uuid(1)}`,
      fromSessionKind: "claude",
      toSessionId: `local_${uuid(2)}`,
      toSessionKind: "claude",
      body: "which option?",
      anticipation: "action"
    });
  } finally {
    mb.close();
  }
}

function resolvedEvents(mailboxPath, messageId) {
  return fs.readFileSync(mailboxPath, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "resolved" && event.messageId === messageId);
}

async function trial(index, modes) {
  const dir = fs.mkdtempSync(path.join(tmp, `t${index}-`));
  const mailboxPath = path.join(dir, "mailbox.jsonl");
  const messageId = seed(mailboxPath);
  const goFile = path.join(dir, "go");
  const env = hermeticEnv({ home: dir, overrides: { AGENT_LINK_RECEIPT_LOG: path.join(dir, "receipts.jsonl") } });
  const children = modes.map((mode, i) => {
    const ready = path.join(dir, `ready-${i}`);
    const child = spawn(process.execPath, [racer, srcRoot, mailboxPath, messageId, mode, ready, goFile], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, out, err })));
    return { ready, done };
  });
  const deadline = Date.now() + 15_000;
  while (!children.every((c) => fs.existsSync(c.ready))) {
    assert.ok(Date.now() < deadline, "children became ready");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fs.writeFileSync(goFile, "go");
  const results = await Promise.all(children.map((c) => c.done));
  for (const r of results) assert.equal(r.code, 0, r.err);
  return { outcomes: results.map((r) => JSON.parse(r.out)), events: resolvedEvents(mailboxPath, messageId) };
}

test("concurrent reply_agent_link_message resolutions: exactly one wins", async () => {
  for (let i = 0; i < TRIALS; i++) {
    const { outcomes, events } = await trial(i, ["reply", "decline", "done", "reply"]);
    const wins = outcomes.filter((o) => o.ok);
    assert.equal(wins.length, 1, `trial ${i}: ${JSON.stringify(outcomes)}`);
    assert.ok(outcomes.filter((o) => !o.ok).every((o) => o.code === "already_resolved"), JSON.stringify(outcomes));
    assert.equal(events.length, 1, `trial ${i}: one resolved event`);
    assert.equal(events[0].kind, wins[0].mode);
  }
});

test("a resolution racing a send with replyToMessageId writes one resolved event", async () => {
  for (let i = 0; i < TRIALS; i++) {
    const { outcomes, events } = await trial(100 + i, ["send", "decline", "send", "done"]);
    assert.equal(events.length, 1, `trial ${i}: ${JSON.stringify(outcomes)}`);
    const toolWins = outcomes.filter((o) => o.ok && o.mode !== "send");
    // When the tool lost, a send resolved it; when it won, its kind stands.
    assert.ok(toolWins.length <= 1);
    if (toolWins.length) assert.equal(events[0].kind, toolWins[0].mode);
    else assert.equal(events[0].kind, "reply");
  }
});
