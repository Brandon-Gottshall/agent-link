// Codex receive end to end over MCP stdio (B7b; design doc R1.10-R1.15,
// R7.7, R7.19, R7.20; T-1.4, T-1.5, T-1.6, T-1.7, T-7.3 Codex half) against
// an in-process fake Codex app-server and a fixture Claude transcript:
//   - mailbox-first Codex sends: push success (turn/start with turnTrigger
//     and clientUserMessageId = messageId), push failure (queued), a thread
//     held by the desktop app (mailbox-only: no turn at all);
//   - B7 spike facts: turn/start that returns the active turn id is a steer;
//     clientId on the userMessage item confirms a delivery;
//   - the Codex inbox and reply_agent_link_message with resolution, and
//     no_current_session without an identity;
//   - a Codex message wait that ends on an explicit reply, not on the turn
//     completing;
//   - message_agent / wait_for_agent across claude:, codex: and role:;
//   - return_project_work_result with replyToMessageId (R7.7);
//   - role handover to a Codex holder that replies with
//     reply_agent_link_message (R7.20).
// Never launches Codex; HOME, CODEX_HOME, the state dir, receipts and the
// mailbox live in a temp directory.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";
import { pluginRoot } from "../helpers/codex-stub.js";
import { hermeticEnv } from "../helpers/env.js";
import { openMailbox } from "../../src/claude/mailbox.js";
import { deliveredClientId, makeThreadStatusTracker } from "../../src/delivery/codex-push.js";

// --- unit: the spike's notification shapes -------------------------------
{
  const tracker = makeThreadStatusTracker();
  assert.equal(tracker.isKnownIdle("t"), false, "unknown is not idle");
  tracker.observe({ method: "turn/started", params: { threadId: "t", turn: { id: "a1", status: "inProgress" } } });
  assert.equal(tracker.activeTurnId("t"), "a1");
  tracker.observe({ method: "thread/status/changed", params: { threadId: "t", status: { type: "idle" } } });
  assert.equal(tracker.isKnownIdle("t"), true);
  assert.equal(tracker.activeTurnId("t"), null);
  tracker.observe({ method: "turn/started", params: { threadId: "t", turn: { id: "a2" } } });
  tracker.observe({ method: "turn/completed", params: { threadId: "t", turn: { id: "a2", status: "interrupted", items: [] } } });
  assert.equal(tracker.isKnownIdle("t"), true, "an interrupted turn also ends the turn");
  const ulid = "01M4BJKBS1W176SJQ8AQHXYE4Q";
  assert.deepEqual(deliveredClientId({ method: "item/started", params: { threadId: "t", turnId: "a3", item: { type: "userMessage", id: "u", clientId: ulid, content: [] } } }), { threadId: "t", turnId: "a3", messageId: ulid });
  assert.equal(deliveredClientId({ method: "item/completed", params: { threadId: "t", item: { type: "agentMessage", clientId: ulid } } }), null);
  assert.equal(deliveredClientId({ method: "item/started", params: { threadId: "t", item: { type: "userMessage", clientId: "spike-msg-1" } } }), null, "only Agent Link message ids");
}

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-link-recv-")));
const codexHome = path.join(tmp, "codex");
mkdirSync(codexHome, { recursive: true });
const stateDir = path.join(tmp, "state");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const mailboxPath = path.join(stateDir, "mailbox.jsonl");

const id = (n) => `019d9200-0000-7000-8000-${String(n).padStart(12, "0")}`;
const IDLE = id(1);
const COLD = id(2);
const FLAKY = id(3);
const RACY = id(4);
const ORCH = id(5);
const WORKER = id(6);
const CALLER = id(10);
const OTHER = id(11);
const CLAUDE_ID = "0b5e7c1a-3f2d-4a6e-9c8b-0000000000c9";

const projects = path.join(tmp, ".claude", "projects", "-work-recv");
mkdirSync(projects, { recursive: true });
writeFileSync(path.join(projects, `${CLAUDE_ID}.jsonl`), `${JSON.stringify({ type: "summary", title: "Receive planner", cwd: "/work/recv", timestamp: new Date().toISOString() })}\n`);

const thread = (threadId, status = "idle") => ({ id: threadId, name: `T ${threadId.slice(-2)}`, preview: "", status: { type: status }, cwd: tmp, model: "gpt-known", reasoningEffort: "medium", createdAt: 1779086300, updatedAt: 1779086400 });
const threads = {
  [IDLE]: thread(IDLE),
  [COLD]: thread(COLD, "notLoaded"),
  [FLAKY]: thread(FLAKY),
  [RACY]: thread(RACY),
  [ORCH]: thread(ORCH),
  [WORKER]: thread(WORKER)
};

const received = [];
let turnCounter = 0;
const server = http.createServer();
const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
  const notify = (method, params) => socket.send(JSON.stringify({ method, params }));
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id === undefined) return;
    received.push(msg);
    const reply = (payload) => socket.send(JSON.stringify({ id: msg.id, ...payload }));
    switch (msg.method) {
      case "initialize":
        reply({ result: { userAgent: "fake", codexHome, platformOs: "macos" } });
        // RACY has a turn running that thread/read does not show yet.
        return notify("turn/started", { threadId: RACY, turn: { id: "racy-active", items: [], status: "inProgress" } });
      case "thread/read":
        if (!threads[msg.params.threadId]) return reply({ error: { code: -32600, message: `thread not found: ${msg.params.threadId}` } });
        return reply({ result: { thread: threads[msg.params.threadId] } });
      case "thread/loaded/list":
        return reply({ result: { data: Object.keys(threads).filter((t) => threads[t].status.type !== "notLoaded"), nextCursor: null } });
      case "turn/start": {
        const { threadId, clientUserMessageId } = msg.params;
        if (threadId === FLAKY) {
          // The message reached the thread, but the response was lost: the
          // userMessage item's clientId still confirms the delivery.
          notify("item/started", { threadId, turnId: "flaky-1", item: { type: "userMessage", id: "u-flaky", clientId: clientUserMessageId, content: [] } });
          return setTimeout(() => reply({ error: { code: -32603, message: "fake: lost response" } }), 20);
        }
        if (threadId === RACY) {
          // B7 spike: turn/start on an active thread steers it.
          return reply({ result: { turn: { id: "racy-active", status: "inProgress", items: [] } } });
        }
        turnCounter += 1;
        const turnId = `turn-${turnCounter}`;
        reply({ result: { turn: { id: turnId, status: "inProgress", items: [] } } });
        // The turn completes with a final answer, which is never a reply.
        notify("turn/started", { threadId, turn: { id: turnId, items: [], status: "inProgress" } });
        notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", id: "m", text: "FINAL ANSWER TEXT", phase: "final_answer" }] } });
        return undefined;
      }
      case "turn/steer":
        return reply({ result: { turnId: "steered" } });
      default:
        return reply({ error: { code: -32601, message: `fake: ${msg.method}` } });
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `ws://127.0.0.1:${server.address().port}`;

const client = new Client({ name: "codex-receive", version: "0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(pluginRoot, "src", "server.js")],
  cwd: pluginRoot,
  env: hermeticEnv({
    home: tmp,
    codexHome,
    overrides: {
      AGENT_LINK_HOST: "codex",
      AGENT_LINK_CODEX_URL: url,
      AGENT_LINK_STATE_DIR: stateDir,
      AGENT_LINK_MAILBOX_PATH: mailboxPath,
      AGENT_LINK_RECEIPT_LOG: path.join(stateDir, "receipts.jsonl"),
      AGENT_LINK_MANAGED_DIR: path.join(tmp, "managed"),
      AGENT_LINK_DISABLE_CHANNEL: "1",
      CLAUDE_CONFIG_DIR: path.join(tmp, ".claude")
    }
  }),
  stderr: "ignore"
}));

async function call(name, args, caller = CALLER) {
  const result = await client.callTool({ name, arguments: args, ...(caller ? { _meta: { threadId: caller } } : {}) });
  return { isError: result.isError, payload: JSON.parse(result.content[0].text) };
}
const sent = (method, mark, threadId) => received.slice(mark).filter((m) => m.method === method && (!threadId || m.params.threadId === threadId));
const row = (messageId) => openMailbox({ mailboxPath }).getMessage({ messageId });
const until = async (predicate, label, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${label}`);
};

try {
  // 1. Mailbox first, then push (R1.10, R1.11, T-1.4).
  let mark = received.length;
  let r = await call("message_codex_thread", { threadId: IDLE, message: "please confirm", anticipation: "action" });
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  assert.equal(r.payload.delivery, "delivered");
  assert.equal(r.payload.deliveredVia, "codex-turn");
  assert.equal(r.payload.anticipation, "action");
  assert.equal(r.payload.messageStatus, "pending");
  const [start] = sent("turn/start", mark, IDLE);
  assert.equal(start.params.turnTrigger, "agent-link");
  assert.equal(start.params.clientUserMessageId, r.payload.messageId);
  assert.match(start.params.input[0].text, new RegExp(`call reply_agent_link_message with messageId="${r.payload.messageId}" and resolution "done"`));
  let stored = row(r.payload.messageId);
  assert.equal(stored.to_session_id, IDLE);
  assert.equal(stored.to_session_kind, "codex");
  assert.equal(stored.delivered_via, "codex-turn");
  assert.equal(stored.deliveries.at(-1).to, `codex:${IDLE}`);
  assert.equal(stored.anticipation, "action");

  // Labels are validated before anything is written or sent (R7.1).
  mark = received.length;
  r = await call("message_codex_thread", { threadId: IDLE, message: "x", anticipation: "fyi", waitForReply: true });
  assert.equal(r.payload.error.code, "invalid_arguments");
  assert.equal(sent("turn/start", mark).length, 0);

  // 2. Held by the desktop app (mailbox-only, R1.12a, T-1.7): no turn at all.
  mark = received.length;
  r = await call("message_codex_thread", { threadId: COLD, message: "held mail", anticipation: "reply" });
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  assert.equal(r.payload.delivery, "queued");
  assert.equal(r.payload.deliveredVia, null);
  assert.equal(r.payload.action, "queued_held_thread");
  assert.ok(r.payload.warnings.some((w) => w.code === "codex_desktop_push_disabled"));
  assert.deepEqual(received.slice(mark).map((m) => m.method).filter((m) => m.startsWith("turn/") || m === "thread/resume"), []);
  const heldId = r.payload.messageId;
  assert.equal(row(heldId).delivered_at, null);

  // 3. A failed push leaves the message queued with the error as a warning;
  // the userMessage clientId the thread reports still confirms delivery.
  r = await call("message_codex_thread", { threadId: FLAKY, message: "flaky" });
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  assert.equal(r.payload.delivery, "queued");
  assert.ok(r.payload.warnings.some((w) => w.code === "codex_push_failed"));
  const flakyId = r.payload.messageId;
  await until(() => row(flakyId).delivered_via === "codex-turn", "clientId confirmation");
  const claims = existsSync(`${mailboxPath}.claims`) ? readdirSync(`${mailboxPath}.claims`) : [];
  assert.ok(!claims.includes(`push-${flakyId}`), "a failed push releases its claim");

  // 4. turn/start that returns the active turn id steered it (B7 spike).
  await until(() => true, "notification");
  r = await call("message_codex_thread", { threadId: RACY, message: "racy" });
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  assert.equal(r.payload.delivery, "delivered");
  assert.equal(r.payload.action, "steered_active_turn");
  assert.deepEqual(r.payload.turn, { id: "racy-active" });

  // 5. The Codex inbox and reply (R1.13, T-1.5).
  r = await call("read_agent_link_inbox", {}, COLD);
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  assert.equal(r.payload.threadId, COLD);
  assert.equal(r.payload.address, `codex:${COLD}`);
  assert.equal(r.payload.sessionId, null);
  assert.deepEqual(r.payload.messages.map((m) => m.id), [heldId]);
  assert.match(r.payload.renderedBlock, /held mail/);
  assert.ok(row(heldId).delivered_at, "an inbox read delivers");
  r = await call("reply_agent_link_message", { messageId: heldId, message: "here is the answer" }, COLD);
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  assert.equal(r.payload.status, "replied");
  assert.equal(r.payload.resolution, "reply");
  stored = row(r.payload.messageId);
  assert.equal(stored.from_session_id, COLD);
  assert.equal(stored.from_session_kind, "codex");
  assert.equal(stored.to_session_id, CALLER);
  // Only the recipient resolves (R7.7), once (R7.10).
  r = await call("reply_agent_link_message", { messageId: heldId, message: "again" }, COLD);
  assert.equal(r.payload.error.code, "already_resolved");
  r = await call("reply_agent_link_message", { messageId: heldId, message: "me too" }, OTHER);
  assert.equal(r.payload.error.code, "wrong_recipient");
  // The caller reads the reply in its own inbox.
  r = await call("read_agent_link_inbox", {}, CALLER);
  assert.ok(r.payload.messages.some((m) => m.inReplyTo === heldId));
  // No identity: no_current_session with the Codex hint.
  r = await call("read_agent_link_inbox", {}, null);
  assert.equal(r.payload.error.code, "no_current_session");
  assert.match(r.payload.error.hint, /_meta/);
  r = await call("reply_agent_link_message", { messageId: heldId, message: "x" }, null);
  assert.equal(r.payload.error.code, "no_current_session");

  // 6. A Codex message wait ends on an explicit reply, never on the turn
  // completing (R7.19, T-1.6, T-7.3).
  mark = received.length;
  const waiting = call("message_codex_thread", { threadId: IDLE, message: "what is the schema version?", waitForReply: true, timeoutMs: 15000, pollIntervalMs: 250 });
  await until(() => sent("turn/start", mark, IDLE).length === 1, "the wait's turn");
  const waitedId = sent("turn/start", mark, IDLE)[0].params.clientUserMessageId;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(row(waitedId).resolution, null, "the completed turn wrote no reply");
  r = await call("reply_agent_link_message", { messageId: waitedId, message: "schema v2" }, IDLE);
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  const waited = await waiting;
  assert.equal(waited.isError, false, JSON.stringify(waited.payload));
  assert.equal(waited.payload.wait.outcome, "reply");
  assert.equal(waited.payload.wait.messageStatus, "replied");
  assert.match(waited.payload.wait.reply.envelope, /schema v2/);
  assert.ok(!JSON.stringify(waited.payload).includes("FINAL ANSWER TEXT"), "the turn's final response is never returned");

  // 7. message_agent / wait_for_agent across claude:, codex: and role:.
  r = await call("message_agent", { to: `codex:${IDLE}`, message: "via agent", anticipation: "reply" });
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  assert.equal(r.payload.harness, "codex");
  assert.equal(r.payload.to, `codex:${IDLE}`);
  assert.equal(r.payload.delivery, "delivered");
  const codexMsg = r.payload.messageId;
  r = await call("wait_for_agent", { agent: `codex:${IDLE}`, replyToMessageId: codexMsg, timeoutMs: 0 });
  assert.equal(r.payload.outcome, "timeout");
  assert.equal(r.payload.harness, "codex");
  await call("reply_agent_link_message", { messageId: codexMsg, resolution: "decline", message: "busy" }, IDLE);
  r = await call("wait_for_agent", { agent: `codex:${IDLE}`, replyToMessageId: codexMsg, timeoutMs: 2000 });
  assert.equal(r.payload.outcome, "declined");
  assert.match(r.payload.reply.envelope, /busy/);

  r = await call("message_agent", { to: `claude:${CLAUDE_ID}`, message: "for claude", anticipation: "reply" });
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  assert.equal(r.payload.harness, "claude");
  assert.equal(r.payload.to, `claude:${CLAUDE_ID}`);
  assert.match(r.payload.delivery, /^queued-/);
  const claudeMsg = r.payload.messageId;
  r = await call("message_agent", { to: `claude:${CLAUDE_ID}`, message: "x", mode: "steer_active" });
  assert.equal(r.payload.error.code, "invalid_arguments");
  r = await call("message_agent", { to: `claude:${CLAUDE_ID}`, message: "x", model: "other" });
  assert.equal(r.payload.error.code, "unsupported");
  r = await call("wait_for_agent", { agent: `claude:${CLAUDE_ID}`, replyToMessageId: claudeMsg, timeoutMs: 0 });
  assert.equal(r.payload.harness, "claude");
  assert.equal(r.payload.outcome, "timeout");
  // The Claude session answers through the mailbox (as its own server would).
  const mb = openMailbox({ mailboxPath });
  mb.insertMessage({ fromSessionId: CLAUDE_ID, fromSessionKind: "claude", toSessionId: CALLER, toSessionKind: "codex", body: "claude says hi", metadata: { sender: { source: "current_session" } }, replyToMessageId: claudeMsg });
  r = await call("wait_for_agent", { agent: `claude:${CLAUDE_ID}`, replyToMessageId: claudeMsg, timeoutMs: 2000 });
  assert.equal(r.payload.outcome, "reply");
  assert.match(r.payload.reply.envelope, /claude says hi/);

  writeFileSync(path.join(stateDir, "roles.json"), JSON.stringify({ version: 1, roles: { router: { address: `codex:${IDLE}`, assignedAt: new Date().toISOString() } } }), { mode: 0o600 });
  r = await call("message_agent", { to: "role:router", message: "route this", anticipation: "reply" });
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  assert.equal(r.payload.harness, "codex");
  assert.equal(r.payload.via, "role:router");
  assert.equal(r.payload.to, `codex:${IDLE}`);
  const roleMsg = r.payload.messageId;
  await call("reply_agent_link_message", { messageId: roleMsg, message: "routed" }, IDLE);
  r = await call("wait_for_agent", { agent: "role:router", replyToMessageId: roleMsg, timeoutMs: 2000 });
  assert.equal(r.payload.outcome, "reply");
  r = await call("wait_for_agent", { agent: `codex:${IDLE}`, timeoutMs: 0 });
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  assert.equal(r.payload.turn?.finalResponse, undefined, "a session wait returns no turn text");
  r = await call("message_agent", { to: "nothing-matches-this-query-xyz", message: "x" });
  assert.equal(r.payload.error.code, "not_found");

  // 8. return_project_work_result with replyToMessageId resolves as done (R7.7).
  r = await call("message_codex_thread", { threadId: WORKER, message: "build it", anticipation: "action" }, ORCH);
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  const task = r.payload.messageId;
  r = await call("return_project_work_result", { orchestratorThreadId: ORCH, resultStatus: "done", summary: "built", replyToMessageId: task }, OTHER);
  assert.equal(r.payload.error.code, "wrong_recipient");
  r = await call("return_project_work_result", { orchestratorThreadId: ORCH, resultStatus: "done", summary: "built", replyToMessageId: task }, WORKER);
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  assert.deepEqual(r.payload.messageResult.resolved, { messageId: task, kind: "done", late: false });
  assert.equal(row(r.payload.messageResult.messageId).reply_to_message_id, task);
  r = await call("get_agent_link_message_status", { messageId: task }, ORCH);
  assert.equal(r.payload.status, "done");
  r = await call("return_project_work_result", { orchestratorThreadId: ORCH, resultStatus: "done", summary: "again", replyToMessageId: task }, WORKER);
  assert.equal(r.payload.error.code, "already_resolved");

  // 9. Role handover to a Codex holder, which replies with
  // reply_agent_link_message (R7.20).
  writeFileSync(path.join(stateDir, "roles.json"), JSON.stringify({ version: 1, roles: { builder: { address: `claude:${CLAUDE_ID}`, assignedAt: new Date().toISOString() } } }), { mode: 0o600 });
  r = await call("message_claude_session", { sessionId: "role:builder", message: "handover task", anticipation: "reply" });
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  const handed = r.payload.messageId;
  writeFileSync(path.join(stateDir, "roles.json"), JSON.stringify({ version: 1, roles: { builder: { address: `codex:${WORKER}`, assignedAt: new Date().toISOString() } } }), { mode: 0o600 });
  r = await call("read_agent_link_inbox", {}, WORKER);
  assert.ok(r.payload.messages.some((m) => m.id === handed), "the new holder reads it");
  r = await call("reply_agent_link_message", { messageId: handed, message: "taken over" }, WORKER);
  assert.equal(r.isError, false, JSON.stringify(r.payload));
  assert.equal(r.payload.status, "replied");
  r = await call("get_agent_link_message_status", { messageId: handed });
  assert.equal(r.payload.status, "replied");
  assert.equal(r.payload.resolution.by, `codex:${WORKER}`);

  // health reports the spike's desktop push mode.
  r = await call("agent_link_health", { startAppServer: false });
  assert.equal(r.payload.codex.desktopPush.mode, "mailbox-only");
  assert.equal(r.payload.codex.desktopPush.verifiedCodexVersion, "0.159.2");
} finally {
  await client.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log("codex-receive tests passed");
