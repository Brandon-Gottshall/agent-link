// tests/codex/prompt-hook.test.js
//
// The Codex UserPromptSubmit hook (design R1.14). The payload shape is the
// one captured live from codex-cli 0.159.2 (ids from a throwaway, archived
// probe thread; paths scrubbed). Everything here is hermetic: temp HOME,
// CODEX_HOME, state dir and mailbox; spawned hooks get hermeticEnv().
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openMailbox, readMailboxRows } from "../../src/claude/mailbox.js";
import { promptHookOutput, runCodexPromptHook, threadFromPayload } from "../../src/codex/prompt-hook.js";
import { createRoleStore } from "../../src/registry/roles.js";
import { hermeticEnv } from "../helpers/env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = path.join(root, "src/codex/prompt-hook.js");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-prompt-hook-")));
process.once("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const THREAD = "01a11760-2a3b-73e3-9838-aac3c6162070";
const OTHER_THREAD = "01a11760-2a3b-73e3-9838-aac3c61620ff";
const SENDER = "7b000000-0000-4000-8000-000000000001";
const SECRET_BODY = "SECRET-BODY-do-not-leak";
const SETTINGS = { limit: 3, intervalMs: 30_000, warnings: [] };
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

// Captured live (codex-cli 0.159.2), scrubbed.
const PAYLOAD = {
  session_id: THREAD,
  turn_id: "01a11760-2cd6-79e0-a712-ef8510c8302d",
  transcript_path: "/home/user/.codex/sessions/2026/10/07/rollout-2026-10-07T13-19-01-01a11760-2a3b-73e3-9838-aac3c6162070.jsonl",
  cwd: "/tmp/probe-cwd",
  hook_event_name: "UserPromptSubmit",
  model: "gpt-6-astra",
  permission_mode: "bypassPermissions",
  prompt: "agent-link hook probe (throwaway)"
};

let n = 0;
function sandbox() {
  n += 1;
  const dir = path.join(tmp, `case-${n}`);
  const state = path.join(dir, "state");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  return { dir, state, mailboxPath: path.join(state, "mailbox.jsonl") };
}

function insert(mailboxPath, fields) {
  const mb = openMailbox({ mailboxPath });
  try {
    return mb.insertMessage({
      fromSessionId: `claude:${SENDER}`,
      fromSessionKind: "claude",
      toSessionId: THREAD,
      toSessionKind: "codex",
      body: SECRET_BODY,
      sentAt: T0,
      ...fields
    });
  } finally {
    mb.close();
  }
}

function deliver(mailboxPath, messageId, to = `codex:${THREAD}`) {
  const mb = openMailbox({ mailboxPath });
  try {
    mb.markDelivered({ messageId, deliveredAt: T0 + 1_000, to });
  } finally {
    mb.close();
  }
}

function run(mailboxPath, payload = PAYLOAD, { table = null, now = T0 + 5_000 } = {}) {
  return runCodexPromptHook(payload, {
    readRows: () => readMailboxRows({ mailboxPath }),
    roleTable: () => table,
    now: () => now,
    settings: SETTINGS
  });
}

function spawnHook(input, env) {
  return spawnSync(process.execPath, [HOOK], { input, env, encoding: "utf8" });
}

function hookEnv(sb, extra = {}) {
  return hermeticEnv({
    home: sb.dir,
    overrides: {
      CODEX_HOME: path.join(sb.dir, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(sb.dir, ".claude"),
      AGENT_LINK_STATE_DIR: sb.state,
      AGENT_LINK_MAILBOX_PATH: sb.mailboxPath,
      ...extra
    }
  });
}

test("payload parsing: session_id is the thread id", () => {
  assert.deepEqual(threadFromPayload(PAYLOAD), { threadId: THREAD, address: `codex:${THREAD}` });
  assert.equal(threadFromPayload({ ...PAYLOAD, hook_event_name: "SessionStart" }), null, "UserPromptSubmit only");
  assert.equal(threadFromPayload({ ...PAYLOAD, session_id: undefined }), null);
  assert.equal(threadFromPayload({ ...PAYLOAD, session_id: "" }), null);
  assert.equal(threadFromPayload({ ...PAYLOAD, session_id: `codex:${THREAD}` }), null, "never an address");
  assert.equal(threadFromPayload({ ...PAYLOAD, session_id: "../../etc" }), null, "id shape is validated");
  assert.equal(threadFromPayload(null), null);
  assert.equal(threadFromPayload("text"), null);
});

test("pending mail gives the section 2.4 notice, without the body", () => {
  const sb = sandbox();
  insert(sb.mailboxPath, {});
  insert(sb.mailboxPath, { toSessionId: `codex:${THREAD}`, sentAt: T0 + 1 });
  const out = run(sb.mailboxPath);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^Agent Link: 2 pending peer messages from claude:7b000000-0000-4000-8000-000000000001\. /);
  assert.match(ctx, /read_agent_link_inbox/);
  assert.match(ctx, /not from the user/);
  assert.ok(!ctx.includes(SECRET_BODY), "never the body");
  assert.equal(run(sb.mailboxPath).hookSpecificOutput.additionalContext, ctx, "repeats: the hook marks nothing delivered");
});

test("delivered reply/action mail still open gives the open notice", () => {
  const sb = sandbox();
  const reply = insert(sb.mailboxPath, { anticipation: "reply" });
  const fyi = insert(sb.mailboxPath, { anticipation: "fyi", sentAt: T0 + 1 });
  deliver(sb.mailboxPath, reply);
  deliver(sb.mailboxPath, fyi);
  const ctx = run(sb.mailboxPath).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^Agent Link: 1 peer message from claude:7b000000-0000-4000-8000-000000000001 awaiting your resolution\. /);
  assert.match(ctx, /reply_agent_link_message/);
  assert.ok(!/pending peer message/.test(ctx), "no new mail");
  assert.ok(!/reminder \d+ of/.test(ctx), "no reminder count: the hook claims none");

  const action = insert(sb.mailboxPath, { anticipation: "action", sentAt: T0 + 2 });
  const both = run(sb.mailboxPath).hookSpecificOutput.additionalContext.split("\n");
  assert.equal(both.length, 2, "pending notice, then the open notice");
  assert.match(both[0], /1 pending peer message/);
  assert.match(both[1], /1 peer message .* awaiting your resolution/);
  assert.ok(action);

  const mb = openMailbox({ mailboxPath: sb.mailboxPath });
  mb.recordResolution({ messageId: reply, kind: "done", by: THREAD });
  mb.close();
  deliver(sb.mailboxPath, action);
  assert.match(run(sb.mailboxPath).hookSpecificOutput.additionalContext, /^Agent Link: 1 peer message .* awaiting/, "resolved mail drops out");
});

test("nothing when there is no mail for this thread", () => {
  const sb = sandbox();
  assert.equal(run(sb.mailboxPath), null, "missing mailbox");
  const fyi = insert(sb.mailboxPath, { anticipation: "fyi" });
  deliver(sb.mailboxPath, fyi);
  insert(sb.mailboxPath, { toSessionId: OTHER_THREAD });
  insert(sb.mailboxPath, { toSessionId: `claude:${SENDER}`, toSessionKind: "claude" });
  assert.equal(run(sb.mailboxPath), null, "delivered fyi and mail for others");
  assert.equal(run(sb.mailboxPath, { ...PAYLOAD, hook_event_name: "Stop" }), null);
});

test("role handover: the role's current Codex holder gets the notice", () => {
  const sb = sandbox();
  const role = { role: { via: "role:lead", address: `codex:${OTHER_THREAD}` } };
  insert(sb.mailboxPath, { toSessionId: OTHER_THREAD, anticipation: "reply", metadata: role });
  const table = { version: 1, roles: { lead: { address: `codex:${THREAD}` } } };
  const holder = run(sb.mailboxPath, PAYLOAD, { table });
  assert.match(holder.hookSpecificOutput.additionalContext, /1 pending peer message/);
  assert.equal(run(sb.mailboxPath, { ...PAYLOAD, session_id: OTHER_THREAD }, { table }), null, "the previous holder no longer sees it");
  assert.equal(run(sb.mailboxPath, PAYLOAD, { table: null }), null, "without the table it stays with the stored recipient");
  assert.match(run(sb.mailboxPath, { ...PAYLOAD, session_id: OTHER_THREAD }, { table: null }).hookSpecificOutput.additionalContext, /1 pending/);
});

test("spawned hook: reads the real role table and mailbox, writes nothing", () => {
  const sb = sandbox();
  const roles = createRoleStore({ env: { AGENT_LINK_STATE_DIR: sb.state }, homedir: sb.dir });
  roles.set({ role: "lead", address: `codex:${THREAD}` });
  insert(sb.mailboxPath, { toSessionId: OTHER_THREAD, anticipation: "action", metadata: { role: { via: "role:lead", address: `codex:${OTHER_THREAD}` } } });
  const snapshot = () => fs.readdirSync(sb.state, { recursive: true }).sort().map((f) => {
    const p = path.join(sb.state, String(f));
    const st = fs.statSync(p);
    return `${f}:${st.isFile() ? fs.readFileSync(p, "utf8") : "dir"}:${st.mode}`;
  });
  const before = snapshot();
  const res = spawnHook(JSON.stringify(PAYLOAD), hookEnv(sb));
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /^Agent Link: 1 pending peer message from claude:/);
  assert.deepEqual(snapshot(), before, "no file in the state dir changed");
  assert.equal(fs.existsSync(`${sb.mailboxPath}.claims`), false, "no claim");
});

test("spawned hook never creates a missing state dir", () => {
  const sb = sandbox();
  fs.rmSync(sb.state, { recursive: true, force: true });
  const res = spawnHook(JSON.stringify(PAYLOAD), hookEnv(sb));
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(fs.existsSync(sb.state), false);
});

test("errors: exit 0 and no output", () => {
  const sb = sandbox();
  insert(sb.mailboxPath, {});
  for (const input of ["", "not json", "[]", "null", JSON.stringify({ ...PAYLOAD, session_id: 7 })]) {
    const res = spawnHook(input, hookEnv(sb));
    assert.equal(res.status, 0, `input ${JSON.stringify(input)}`);
    assert.equal(res.stdout, "", `input ${JSON.stringify(input)}`);
  }
  // A mailbox path the state rules reject throws inside the hook.
  const bad = spawnHook(JSON.stringify(PAYLOAD), hookEnv(sb, { AGENT_LINK_MAILBOX_PATH: "relative/mailbox.jsonl" }));
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
  assert.equal(promptHookOutput(JSON.stringify(PAYLOAD), { readRows: () => { throw new Error("boom"); } }), "");
});

test("hooks file command: missing node or a broken install exits 0 silently", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks/codex-hooks.json"), "utf8"));
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  const sb = sandbox();
  insert(sb.mailboxPath, {});
  const sh = (pluginRoot, env) => spawnSync("/bin/sh", ["-c", command.replaceAll("${PLUGIN_ROOT}", pluginRoot)], {
    input: JSON.stringify(PAYLOAD), env, encoding: "utf8"
  });
  // Working install.
  const ok = sh(root, hookEnv(sb));
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /1 pending peer message/);
  // No node on PATH.
  const noNode = sh(root, { ...hookEnv(sb), PATH: path.join(tmp, "no-such-bin") });
  assert.equal(noNode.status, 0);
  assert.equal(noNode.stdout, "");
  // A broken install: the script throws at load.
  const broken = path.join(tmp, "broken-plugin");
  fs.mkdirSync(path.join(broken, "src/codex"), { recursive: true });
  fs.writeFileSync(path.join(broken, "src/codex/prompt-hook.js"), "throw new Error('broken install');\n");
  const bad = sh(broken, hookEnv(sb));
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
  assert.equal(bad.stderr, "", "stderr is discarded, so Codex shows no hook error");
});

test("hook latency with a large mailbox: 20k rows", () => {
  const sb = sandbox();
  const ulid = (i) => `01K${String(i).padStart(23, "0")}`;
  const lines = [];
  for (let i = 0; i < 20_000; i++) {
    const mine = i % 1_000 === 0;
    const id = ulid(i);
    lines.push(JSON.stringify({ type: "message", at: T0, message: {
      id,
      from_session_id: `claude:${SENDER}`,
      from_session_kind: "claude",
      to_session_id: mine ? THREAD : OTHER_THREAD,
      to_session_kind: "codex",
      body: `row ${i}`,
      sent_at: T0 - 100_000 + i,
      anticipation: i % 3 ? "fyi" : "reply",
      metadata_json: i % 7 ? null : JSON.stringify({ role: { via: "role:lead", address: `codex:${OTHER_THREAD}` } })
    } }));
    if (i % 2) lines.push(JSON.stringify({ type: "delivered", at: T0, messageId: id, to: `codex:${OTHER_THREAD}` }));
  }
  fs.writeFileSync(sb.mailboxPath, `${lines.join("\n")}\n`);
  // In process: the work the hook adds on top of node startup.
  const started = process.hrtime.bigint();
  const out = run(sb.mailboxPath);
  const inProcess = Number(process.hrtime.bigint() - started) / 1e6;
  assert.match(out.hookSpecificOutput.additionalContext, /pending peer message/);
  // Spawned: what the user waits for.
  const t1 = process.hrtime.bigint();
  const res = spawnHook(JSON.stringify(PAYLOAD), hookEnv(sb));
  const spawned = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.equal(res.status, 0);
  assert.match(res.stdout, /pending peer message/);
  if (process.env.AGENT_LINK_PERF_LOG) console.log(`prompt hook 20k rows: in-process ${Math.round(inProcess)} ms, spawned ${Math.round(spawned)} ms`);
  // Target ~100 ms on a developer machine; CI runners are slower and noisy.
  assert.ok(inProcess < 1_000, `in-process hook took ${Math.round(inProcess)} ms`);
  assert.ok(spawned < 2_000, `spawned hook took ${Math.round(spawned)} ms`);
});

test("execFileSync smoke: fixture payload through node", () => {
  const sb = sandbox();
  const out = execFileSync(process.execPath, [HOOK], { input: JSON.stringify(PAYLOAD), env: hookEnv(sb), encoding: "utf8" });
  assert.equal(out, "", "empty mailbox: no output");
});
