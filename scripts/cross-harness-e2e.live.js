#!/usr/bin/env node
// Live end-to-end test of Agent Link's cross-harness messaging between a
// Claude-side MCP client and real Codex threads.
//
// MANUAL ONLY. It starts real `codex app-server` processes and runs real model
// turns (about 15). It is not part of `npm test`, scripts/run-offline-tests.js,
// or CI. It refuses to run without AGENT_LINK_LIVE=1 and --yes-real-codex.
//
// What it sets up (see docs/testing.md, "Cross-harness live E2E"):
//   - One fresh temp root (os.tmpdir()) holds ALL Agent Link state for both
//     sides: AGENT_LINK_STATE_DIR, AGENT_LINK_MAILBOX_PATH, AGENT_LINK_RECEIPT_LOG,
//     AGENT_LINK_MANAGED_DIR, AGENT_LINK_LOG_FILE, a fake CLAUDE_CONFIG_DIR, and
//     HOME for both MCP servers. The script refuses to run if any of them
//     resolves under the real home directory.
//   - App-server A: `codex app-server --listen unix://<tmp>/a.sock` with this
//     checkout's dist/server.mjs injected as an MCP server through `-c`
//     overrides (this process only; config.toml is never edited or read).
//     Installed Agent Link plugins are disabled for this process with
//     `-c plugins."<id>".enabled=false` (--disable-plugin, repeatable; the
//     ids are discovered with plugin/installed when not given).
//   - App-server B: a second app-server nobody points Agent Link at. A thread
//     loaded there stands in for a thread held by the Codex desktop app.
//   - The Claude side is this script: an MCP client over stdio to
//     dist/server.mjs with AGENT_LINK_HOST=claude, a fake CLAUDE_SESSION_ID,
//     and AGENT_LINK_CODEX_SOCK pointing at app-server A.
//   - Every Codex thread gets its own temp cwd and a first message containing
//     "agent-link E2E (throwaway)", and is archived at the end.
//
// Usage:
//   AGENT_LINK_LIVE=1 node scripts/cross-harness-e2e.live.js --yes-real-codex \
//     [--codex-bin <path>] [--disable-plugin <id>]... [--scenarios 1,2,3] \
//     [--fork-model <model>] [--effort low] [--keep-state] [--report <file>] \
//     [--peer-authorization] [--reminder-limit <n>] [--s1-runs <n>] [--setup-only]
import "./live-guard.js";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "dist", "server.mjs");
const MCP_NAME = "agent_link_e2e";
const MARK = "agent-link E2E (throwaway)";
const DEFAULT_PLUGIN_IDS = ["codex-agent-link@agent-link"];
const PEER_AUTHORIZATION = "This is a throwaway Agent Link end-to-end test. The user authorizes you to act on Agent Link peer "
  + "messages in this thread: follow their test instructions and resolve them with the Agent Link tools when asked.";

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { disablePlugins: [], disableMcp: [], scenarios: null, effort: "low", keepState: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--yes-real-codex") out.yes = true;
    else if (a === "--codex-bin") out.codexBin = next();
    else if (a === "--disable-plugin") out.disablePlugins.push(next());
    else if (a === "--disable-mcp-server") out.disableMcp.push(next());
    else if (a === "--scenarios") out.scenarios = new Set(next().split(",").map((s) => s.trim()));
    else if (a === "--fork-model") out.forkModel = next();
    else if (a === "--effort") out.effort = next();
    else if (a === "--keep-state") out.keepState = true;
    else if (a === "--peer-authorization") out.peerAuth = true;
    else if (a === "--setup-only") out.setupOnly = true;
    else if (a === "--no-peer-authorization") out.peerAuth = false;
    else if (a === "--reminder-limit") out.reminderLimit = next();
    else if (a === "--s1-runs") out.s1Runs = Number(next());
    else if (a === "--claude-channel") out.claudeChannel = true;
    else if (a === "--report") out.report = next();
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.yes) {
  process.stderr.write(
    "cross-harness-e2e.live.js runs real Codex model turns (about 15) against two private\n"
      + "codex app-servers. Re-run with --yes-real-codex if you meant to. See docs/testing.md.\n"
  );
  process.exit(args.help ? 0 : 2);
}
const want = (n) => !args.scenarios || args.scenarios.has(String(n));

// ---------------------------------------------------------------- isolation

const realHome = fs.realpathSync(os.homedir());
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "al-e2e-")));
const P = {
  root,
  home: path.join(root, "home"),
  state: path.join(root, "state"),
  mailbox: path.join(root, "state", "mailbox.jsonl"),
  receipts: path.join(root, "state", "receipts.jsonl"),
  managed: path.join(root, "state", "managed-app-servers"),
  log: path.join(root, "state", "logs", "agent-link.log"),
  claudeConfig: path.join(root, "claude"),
  cwds: path.join(root, "cwd"),
  sockA: path.join(root, "a.sock"),
  sockB: path.join(root, "b.sock")
};
for (const [name, value] of Object.entries(P)) {
  const resolved = path.resolve(value);
  if (resolved === realHome || resolved.startsWith(realHome + path.sep)) {
    process.stderr.write(`refusing to run: ${name} resolves under the real home directory\n`);
    process.exit(2);
  }
}
for (const dir of [P.home, P.state, P.claudeConfig, P.cwds]) fs.mkdirSync(dir, { recursive: true });

const codexBin = resolveCodexBin(args.codexBin);
const codexVersion = (spawnSync(codexBin, ["--version"], { encoding: "utf8" }).stdout || "").trim();
const CLAUDE_SESSION = randomUUID();

/** Agent Link variables shared by both MCP servers. */
const sharedAgentLinkEnv = {
  HOME: P.home,
  AGENT_LINK_STATE_DIR: P.state,
  AGENT_LINK_MAILBOX_PATH: P.mailbox,
  AGENT_LINK_RECEIPT_LOG: P.receipts,
  AGENT_LINK_MANAGED_DIR: P.managed,
  AGENT_LINK_LOG_FILE: P.log,
  CLAUDE_CONFIG_DIR: P.claudeConfig,
  AGENT_LINK_CODEX_SOCK: P.sockA,
  AGENT_LINK_CODEX_AUTOSTART: "0",
  AGENT_LINK_CODEX_BIN: codexBin,
  AGENT_LINK_REMINDER_INTERVAL_MS: "30000",
  AGENT_LINK_REMINDER_LIMIT: String(args.reminderLimit ?? 2),
  AGENT_LINK_INSPECT_ALL: "1"
};

function resolveCodexBin(explicit) {
  const candidates = [explicit, process.env.AGENT_LINK_CODEX_BIN, path.join(os.homedir(), ".local", "bin", "codex")];
  for (const c of candidates) if (c && fs.existsSync(c)) return fs.realpathSync(c);
  const which = spawnSync("which", ["codex"], { encoding: "utf8" }).stdout.trim();
  if (which) return fs.realpathSync(which);
  throw new Error("codex binary not found; pass --codex-bin");
}

/** The parent environment minus every Claude, Codex-thread, and Agent Link variable. */
function scrubbedEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|AGENT_LINK|CODEX_AGENT_LINK|CODEX_THREAD|CODEX_TURN|MCP_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------- reporting

const report = {
  startedAt: new Date().toISOString(),
  codexVersion,
  root,
  claudeSession: CLAUDE_SESSION,
  setup: {},
  scenarios: {},
  threads: [],
  turnsObserved: 0,
  archived: [],
  errors: []
};
const log = (...parts) => process.stdout.write(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ") + "\n");
const trim = (value, max = 600) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > max ? `${text.slice(0, max)}...` : text;
};
function scenario(n, title) {
  const rec = { title, verdict: "pending", checks: [], evidence: {}, turns: 0 };
  report.scenarios[n] = rec;
  log(`\n=== Scenario ${n}: ${title}`);
  return {
    rec,
    check(name, ok, detail) {
      rec.checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? undefined : trim(detail, 400) });
      log(`  [${ok ? "ok" : "FAIL"}] ${name}${detail === undefined ? "" : ` -- ${trim(detail, 300)}`}`);
      return Boolean(ok);
    },
    note(text) { rec.notes = [...(rec.notes ?? []), text]; log(`  [note] ${text}`); },
    evidence(key, value) { rec.evidence[key] = typeof value === "string" ? trim(value, 1200) : value; },
    finish() {
      const failed = rec.checks.filter((c) => !c.ok).length;
      rec.verdict = rec.checks.length === 0 ? "not-run" : failed === 0 ? "pass" : failed === rec.checks.length ? "fail" : "partial";
      log(`  => ${rec.verdict}`);
    }
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- app-server

const children = [];

function startAppServer(name, sock, extraArgs) {
  const argv = ["app-server", "--listen", `unix://${sock}`, ...extraArgs];
  const child = spawn(codexBin, argv, { env: scrubbedEnv(), cwd: P.cwds, stdio: ["ignore", "ignore", "pipe"] });
  const errLog = fs.createWriteStream(path.join(root, `${name}.stderr.log`));
  child.stderr.pipe(errLog);
  children.push({ name, child });
  return child;
}

async function waitForSocket(sock, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(sock)) {
      const ok = await new Promise((resolve) => {
        const s = net.connect(sock, () => { s.end(); resolve(true); });
        s.on("error", () => resolve(false));
      });
      if (ok) return;
    }
    await sleep(250);
  }
  throw new Error(`app-server socket ${sock} did not come up`);
}

class Rpc {
  constructor(sock, name) {
    this.sock = sock;
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
  }
  async open() {
    this.ws = new WebSocket("ws://localhost/", { createConnection: () => net.connect(this.sock) });
    await new Promise((resolve, reject) => { this.ws.once("open", resolve); this.ws.once("error", reject); });
    this.ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(Object.assign(new Error(msg.error.message || "rpc error"), { rpc: msg.error }));
        else resolve(msg.result);
      } else if (msg.method && msg.id !== undefined) {
        // A server request (approval, elicitation). This harness never
        // approves anything: decline so no turn hangs.
        this.ws.send(JSON.stringify({ id: msg.id, result: { decision: "decline" } }));
        this.notifications.push({ at: Date.now(), method: msg.method, serverRequest: true });
      } else if (msg.method) {
        this.notifications.push({ at: Date.now(), method: msg.method, params: msg.params });
      }
    });
    await this.request("initialize", { clientInfo: { name: "agent-link-e2e", title: "Agent Link E2E", version: "0" }, capabilities: { experimentalApi: true } });
    this.ws.send(JSON.stringify({ method: "initialized", params: {} }));
  }
  request(method, params = {}, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name} ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws?.terminate(); } catch { /* already closed */ } }
}

// ---------------------------------------------------------------- Claude side

let claude;
async function startClaudeSide() {
  const env = {
    ...scrubbedEnv(),
    ...sharedAgentLinkEnv,
    AGENT_LINK_HOST: "claude",
    CLAUDE_SESSION_ID: CLAUDE_SESSION,
    CLAUDE_PROJECT_DIR: path.join(P.cwds, "claude-project"),
    AGENT_LINK_ROLE_ADMIN: "1",
    // Default: no Claude Code channel, like a session without the channel
    // flag, so an inbound message stays pending for the hook and the inbox.
    // --claude-channel turns it on: this client then receives channel
    // notifications and the message is delivered by the push instead.
    AGENT_LINK_DISABLE_CHANNEL: args.claudeChannel ? "0" : "1"
  };
  fs.mkdirSync(env.CLAUDE_PROJECT_DIR, { recursive: true });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, cwd: REPO, stderr: "pipe" });
  const client = new Client({ name: "agent-link-e2e-claude", version: "0" }, { capabilities: {} });
  const channel = [];
  client.fallbackNotificationHandler = async (n) => { channel.push({ at: Date.now(), method: n.method, params: n.params }); };
  await client.connect(transport);
  const serverErr = fs.createWriteStream(path.join(root, "claude-mcp.stderr.log"));
  transport.stderr?.pipe(serverErr);
  claude = { client, transport, channel, env };
}

async function call(name, argsIn = {}, timeoutMs = 300000) {
  const result = await claude.client.callTool({ name, arguments: argsIn }, undefined, { timeout: timeoutMs, resetTimeoutOnProgress: true });
  let parsed = result.structuredContent;
  if (!parsed) {
    const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  }
  if (result.isError) parsed = { isError: true, ...parsed };
  return parsed;
}

/** A transcript file so the fake Claude session is addressable and resolvable. */
let transcriptFile = null;
function writeFakeClaudeTranscript() {
  const cwd = path.join(P.cwds, "claude-project");
  const dir = path.join(P.claudeConfig, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const lines = [
    { type: "user", sessionId: CLAUDE_SESSION, cwd, timestamp: at, message: { role: "user", content: `${MARK} Claude-side session` } },
    { type: "summary", summary: "agent-link E2E Claude side" }
  ];
  transcriptFile = path.join(dir, `${CLAUDE_SESSION}.jsonl`);
  fs.writeFileSync(transcriptFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** Runs the Claude notify hook the way hooks/hooks.json does, with the isolated env. */
function runClaudeHook(event, prompt = "e2e prompt") {
  const payload = { session_id: CLAUDE_SESSION, hook_event_name: event, cwd: claude.env.CLAUDE_PROJECT_DIR, prompt, transcript_path: transcriptFile };
  const r = spawnSync(process.execPath, [path.join(REPO, "src", "claude", "notify-hook.js")], {
    input: JSON.stringify(payload),
    env: { ...claude.env, CLAUDE_PLUGIN_ROOT: REPO },
    encoding: "utf8",
    timeout: 10000
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------- thread helpers

let A;
let B;
const created = new Map(); // threadId -> { server: "A"|"B", label }
function track(threadId, server, label) {
  if (!threadId || created.has(threadId)) return;
  created.set(threadId, { server, label });
  report.threads.push({ threadId, server, label });
}
function newCwd(label) {
  const dir = fs.mkdtempSync(path.join(P.cwds, `${label}-`));
  return fs.realpathSync(dir);
}
async function readThread(rpc, threadId) {
  const r = await rpc.request("thread/read", { threadId, includeTurns: true });
  return r.thread;
}
function itemText(item) {
  if (!item) return "";
  if (item.type === "userMessage") return (item.content || []).map((c) => c.text || "").join("");
  if (item.type === "agentMessage") return item.text || "";
  return "";
}
function summarizeTurns(thread) {
  return (thread?.turns || []).map((t) => ({
    id: t.id,
    status: t.status,
    user: trim((t.items || []).filter((i) => i.type === "userMessage").map(itemText).join(" | "), 300),
    tools: (t.items || []).filter((i) => i.type === "mcpToolCall").map((i) => `${i.server}.${i.tool}:${i.status}`),
    agent: trim((t.items || []).filter((i) => i.type === "agentMessage").map(itemText).join(" | "), 200)
  }));
}
async function waitIdle(rpc, threadId, { minTurns = 0, timeoutMs = 240000 } = {}) {
  const end = Date.now() + timeoutMs;
  let thread;
  while (Date.now() < end) {
    thread = await readThread(rpc, threadId).catch(() => null);
    const turns = thread?.turns || [];
    if (turns.length >= minTurns && turns.every((t) => t.status !== "inProgress")) return thread;
    await sleep(1500);
  }
  return thread;
}
/** Calls a tool on the Codex-side Agent Link server as the given thread (no model turn). */
async function codexSideTool(threadId, tool, toolArgs = {}) {
  const r = await A.request("mcpServer/tool/call", { threadId, server: MCP_NAME, tool, arguments: toolArgs, _meta: { threadId } }, 120000);
  let parsed = r?.structuredContent;
  if (!parsed) {
    const text = (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  }
  return parsed;
}
function forkMeta(m) {
  try { return JSON.parse(m.metadata_json ?? "{}").fork ?? null; } catch { return null; }
}
function mailboxEvents() {
  if (!fs.existsSync(P.mailbox)) return [];
  return fs.readFileSync(P.mailbox, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function receiptRows() {
  if (!fs.existsSync(P.receipts)) return [];
  return fs.readFileSync(P.receipts, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function messageRows() {
  return mailboxEvents().filter((e) => e.type === "message").map((e) => e.message ?? e);
}
const turnCount = (thread) => (thread?.turns || []).length;

// ---------------------------------------------------------------- scenarios

const ctx = {};

/** The model's final text in each turn before the reply turn (declines). */
function declineTexts(turns, replyTurn) {
  const upto = replyTurn >= 0 ? replyTurn : turns.length;
  return turns.slice(0, upto).map((t, i) => ({ turn: i + 1, user: trim(t.user, 80), agent: t.agent }));
}

async function s1(run = 1) {
  const s = scenario(run === 1 ? 1 : `1#${run}`, `Claude -> Codex launch with a reply expected${run === 1 ? "" : ` (repeat ${run})`}`);
  try {
    const cwd = newCwd("s1");
    const launch = await call("launch_codex_thread", {
      message: `${MARK}. Use the agent-link tool reply_agent_link_message to reply 'pong' to this message. Do nothing else.`,
      name: "agent-link E2E s1",
      cwd,
      anticipation: "reply",
      ephemeral: false
    });
    s.evidence("launch", trim(launch, 1500));
    const threadId = launch.threadId ?? launch.thread?.id;
    const messageId = launch.messageId ?? launch.message?.messageId ?? launch.delivery?.messageId;
    track(threadId, "A", run === 1 ? "s1" : `s1#${run}`);
    if (run === 1) ctx.t1 = threadId;
    s.check("launch returned threadId and messageId", threadId && messageId, { threadId, messageId });
    const wait = await call("wait_for_agent", { agent: `codex:${threadId}`, replyToMessageId: messageId, timeoutMs: 240000 }, 300000);
    s.evidence("wait", trim(wait, 1500));
    s.check("wait_for_agent outcome reply", wait.outcome === "reply", wait.outcome);
    const replyBody = JSON.stringify(wait.reply ?? "");
    s.check("reply body carries pong", /pong/i.test(replyBody), wait.reply);
    const status = await call("get_agent_link_message_status", { messageId });
    s.evidence("status", status);
    s.check("message status replied", (status.status ?? status.message?.status) === "replied", status.status);
    const thread = await waitIdle(A, threadId, { minTurns: 1 });
    const turns = summarizeTurns(thread);
    s.evidence("turns", turns);
    s.rec.turns = turns.length;
    s.check("first turn userMessage has <agent-link-message> envelope", /<agent-link-message/.test(turns[0]?.user ?? ""), turns[0]?.user);
    const replyTurn = turns.findIndex((t) => t.tools.some((x) => x.startsWith(`${MCP_NAME}.reply_agent_link_message`)));
    s.check("thread called reply_agent_link_message on the test server", replyTurn >= 0, turns.map((t) => t.tools));
    s.evidence("replyTurnIndex", replyTurn);
    s.check("replied on the first turn or at the latest the first reminder", replyTurn === 0 || replyTurn === 1, replyTurn + 1);
    const declines = declineTexts(turns, replyTurn);
    s.evidence("declines", declines);
    for (const d of declines) s.note(`turn ${d.turn} did not reply; model text: ${JSON.stringify(d.agent)}`);
    ctx.t1Model = thread?.model ?? null;
  } catch (err) {
    s.check("scenario ran without exception", false, err.stack || String(err));
  }
  s.finish();
}

async function s2() {
  const s = scenario(2, "Claude -> existing loaded Codex thread (message_codex_thread)");
  try {
    if (!ctx.t1) throw new Error("needs scenario 1 thread");
    const before = turnCount(await readThread(A, ctx.t1));
    const r = await call("message_codex_thread", {
      threadId: ctx.t1,
      message: `${MARK}. Answer with just the word 'ack'. Do not call any tools.`,
      anticipation: "fyi"
    });
    s.evidence("message_codex_thread", trim(r, 1500));
    const delivery = r.delivery ?? {};
    const deliveryText = JSON.stringify(delivery);
    s.check("delivery delivered", (delivery.status ?? delivery) === "delivered" || /"delivered"/.test(deliveryText), delivery);
    s.check("delivered via codex-turn", /codex-turn/.test(JSON.stringify(r)), delivery.via);
    const thread = await waitIdle(A, ctx.t1, { minTurns: before + 1 });
    const userItems = (thread?.turns ?? []).flatMap((t) => (t.items ?? []).filter((i) => i.type === "userMessage"));
    const echoed = userItems.find((i) => i.clientId === r.messageId);
    const deliveredEvent = mailboxEvents().find((e) => e.type === "delivered" && e.messageId === r.messageId);
    s.evidence("clientIdItem", echoed ? { clientId: echoed.clientId } : null);
    s.evidence("deliveredEvent", deliveredEvent ?? null);
    s.check("thread userMessage echoes the message id as clientId", Boolean(echoed), echoed?.clientId);
    s.check("mailbox delivered event via codex-turn", deliveredEvent?.via === "codex-turn", deliveredEvent);
    const turns = summarizeTurns(thread);
    s.rec.turns = turns.length - before;
    s.evidence("newTurns", turns.slice(before));
    s.check("exactly one new turn", turns.length === before + 1, { before, after: turns.length });
    s.check("new turn userMessage has envelope", /<agent-link-message/.test(turns[before]?.user ?? ""), turns[before]?.user);
  } catch (err) {
    s.check("scenario ran without exception", false, err.stack || String(err));
  }
  s.finish();
}

async function s3() {
  const s = scenario(3, "Codex -> Claude, Claude reply back to Codex");
  try {
    if (!ctx.t1) throw new Error("needs scenario 1 thread");
    const before = turnCount(await readThread(A, ctx.t1));
    // The thread's own user asks it to message Claude: a plain turn/start
    // from this harness, not a peer envelope (a peer cannot authorize it).
    const r = await A.request("turn/start", {
      threadId: ctx.t1,
      input: [{ type: "text", text: `${MARK}. Use the agent-link tool message_claude_session with sessionId '${CLAUDE_SESSION}', message 'hello-from-codex', anticipation 'reply'. Do nothing else.` }]
    });
    s.evidence("instruct", { turnId: r.turn?.id });
    const thread = await waitIdle(A, ctx.t1, { minTurns: before + 1 });
    const turns = summarizeTurns(thread);
    s.evidence("codexTurn", turns.slice(before));
    s.check("Codex turn called message_claude_session on the test server", turns.slice(before).some((t) => t.tools.some((x) => x.startsWith(`${MCP_NAME}.message_claude_session`))), turns.slice(before).map((t) => t.tools));
    s.evidence("claudeChannelNotifications", claude.channel.map((n) => ({ method: n.method, params: trim(n.params, 300) })));
    const hook = runClaudeHook("UserPromptSubmit");
    s.evidence("hook", { status: hook.status, stdout: trim(hook.stdout, 1200), stderr: trim(hook.stderr, 300) });
    if (args.claudeChannel) {
      s.check("message pushed to the Claude channel", claude.channel.some((n) => JSON.stringify(n.params ?? {}).includes("hello-from-codex")), claude.channel.length);
    } else {
      s.check("UserPromptSubmit hook adds a notice naming the Codex sender", hook.status === 0 && /additionalContext/.test(hook.stdout) && hook.stdout.includes(`codex:${ctx.t1}`), trim(hook.stdout, 400));
    }
    const inbox = await call("read_agent_link_inbox", {});
    s.evidence("inbox", trim(inbox, 1500));
    // Message bodies are only in the rendered block (the fields carry labels).
    const msgs = inbox.messages ?? [];
    const inbound = msgs.find((m) => m.from === `codex:${ctx.t1}`) ?? null;
    s.check("read_agent_link_inbox shows the Codex message", inbound && /hello-from-codex/.test(inbox.renderedBlock ?? ""), msgs.map((m) => ({ id: m.id, from: m.from })));
    const inboundId = inbound?.id;
    s.check("inbound message is from the Codex thread, verified, anticipating a reply", inbound?.fromVerified === true && inbound?.anticipation === "reply", inbound && { from: inbound.from, fromVerified: inbound.fromVerified, anticipation: inbound.anticipation });
    const turnsBeforeReply = turnCount(await readThread(A, ctx.t1));
    const reply = await call("reply_agent_link_message", { messageId: inboundId, message: "reply-from-claude" });
    s.evidence("reply", trim(reply, 1200));
    s.check("Claude reply accepted", reply.ok === true && reply.messageId, { messageId: reply.messageId, status: reply.status, delivery: reply.delivery });
    ctx.s3ReplyId = reply.messageId;
    await sleep(8000);
    const afterReply = await waitIdle(A, ctx.t1, { minTurns: turnsBeforeReply });
    const pushTurns = summarizeTurns(afterReply).slice(turnsBeforeReply);
    s.evidence("pushTurnsAfterReply", pushTurns);
    const pushed = (afterReply?.turns ?? []).slice(turnsBeforeReply).some((t) => (t.items ?? []).some((i) => i.type === "userMessage" && /reply-from-claude/.test(itemText(i))));
    // Codex side inbox, read as the thread through its own MCP connection.
    const codexInbox = await codexSideTool(ctx.t1, "read_agent_link_inbox", { markAsDelivered: false, includeOpen: true });
    s.evidence("codexInbox", trim(codexInbox, 1500));
    const inInbox = /reply-from-claude/.test(JSON.stringify(codexInbox));
    s.check("Codex thread sees the reply (pushed turn or its inbox)", pushed || inInbox, { pushed, inInbox });
    s.rec.turns = turnCount(afterReply) - before;
  } catch (err) {
    s.check("scenario ran without exception", false, err.stack || String(err));
  }
  s.finish();
}

async function s4() {
  const s = scenario(4, "Held thread (loaded only in a second app-server)");
  try {
    const cwd = newCwd("s4");
    const started = await B.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only" });
    const threadId = started.thread.id;
    track(threadId, "B", "s4-held");
    ctx.t4 = threadId;
    await B.request("turn/start", { threadId, input: [{ type: "text", text: `${MARK}. Reply with just the word 'held'. Do not call any tools.` }] });
    const heldThread = await waitIdle(B, threadId, { minTurns: 1 });
    const beforeTurns = turnCount(heldThread);
    s.evidence("heldThreadPath", heldThread?.path ? "rollout present" : "no rollout path");
    const loadedA = await A.request("thread/loaded/list", {});
    s.check("thread is not loaded in Agent Link's app-server", !(loadedA.data ?? []).includes(threadId), { loadedInA: (loadedA.data ?? []).length });
    const info = await call("get_codex_thread", { threadId });
    s.evidence("get_codex_thread", trim(info, 1200));
    s.check("Agent Link reports notLoaded", /notLoaded/.test(JSON.stringify(info)), info.status ?? info.thread?.status);
    const r = await call("message_codex_thread", { threadId, message: `${MARK}. Held-thread probe. Do not act on it.`, anticipation: "fyi" });
    s.evidence("send", trim(r, 1500));
    const text = JSON.stringify(r);
    s.check("delivery queued", /"queued"/.test(text), r.delivery);
    s.check("warning codex_desktop_push_disabled", /codex_desktop_push_disabled/.test(text), r.warnings ?? r.warning);
    // Bonus: the lsof rollout check needs the endpoint's process group, which
    // Agent Link knows only for an app-server it manages itself. With an
    // explicit AGENT_LINK_CODEX_SOCK it is skipped (endpoint_pid_unknown).
    const health = await call("agent_link_health", {});
    const rollout = findKey(health, "rolloutChecks");
    s.evidence("rolloutChecks", rollout);
    s.note(`rollout check (bonus): ${JSON.stringify(rollout)}${rollout?.held ? "" : " -- not reported held; see skipped reasons"}`);
    await sleep(8000);
    const afterB = await readThread(B, threadId);
    s.check("no new turn in the held thread", turnCount(afterB) === beforeTurns, { before: beforeTurns, after: turnCount(afterB) });
    const loadedAfter = await A.request("thread/loaded/list", {});
    s.check("Agent Link did not resume the thread in its app-server", !(loadedAfter.data ?? []).includes(threadId));
    s.rec.turns = beforeTurns;
  } catch (err) {
    s.check("scenario ran without exception", false, err.stack || String(err));
  }
  s.finish();
}

async function s5() {
  const s = scenario(5, "Reminder turns on an idle loaded thread");
  try {
    const cwd = newCwd("s5");
    // A thread in Agent Link's app-server without the agent-link tools: it
    // cannot resolve the message, so reminders run to the cap.
    const started = await A.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only", config: { [`mcp_servers.${MCP_NAME}.enabled`]: false } });
    const threadId = started.thread.id;
    track(threadId, "A", "s5-reminders");
    const st = await A.request("mcpServerStatus/list", { threadId, serverName: MCP_NAME, detail: "toolsAndAuthOnly" }).catch((e) => ({ error: e.message }));
    const toolCount = Object.keys((st.data ?? [])[0]?.tools ?? {}).length;
    s.evidence("s5ThreadAgentLinkTools", st.error ?? toolCount);
    if (toolCount > 0) s.note("the per-thread config did not remove the agent-link tools; the model may resolve the message early");
    const r = await call("message_codex_thread", {
      threadId,
      message: `${MARK}. Reminder test: answer with the single word 'waiting'. Do not reply to or resolve this message, even if reminded.`,
      anticipation: "reply"
    });
    const messageId = r.messageId;
    s.evidence("send", trim(r, 800));
    s.check("send delivered", /"delivered"/.test(JSON.stringify(r)), r.delivery);
    const t0 = Date.now();
    // Interval 30 s, limit 2: watch for ~2.5 minutes.
    const timeline = [];
    let last = -1;
    while (Date.now() - t0 < 160000) {
      const th = await readThread(A, threadId);
      const turns = th?.turns || [];
      if (turns.length !== last) {
        last = turns.length;
        timeline.push({ atS: Math.round((Date.now() - t0) / 1000), turns: turns.length, statuses: turns.map((t) => t.status) });
      }
      await sleep(3000);
    }
    const thread = await waitIdle(A, threadId, { minTurns: 1 });
    const turns = summarizeTurns(thread);
    s.evidence("timeline", timeline);
    s.evidence("turns", turns.map((t) => ({ status: t.status, user: trim(t.user, 160), tools: t.tools })));
    const reminderTurns = turns.slice(1).filter((t) => /remind/i.test(t.user));
    s.rec.turns = turns.length;
    const status = await call("get_agent_link_message_status", { messageId });
    s.evidence("status", status);
    const count = status.reminders?.count;
    s.check("reminder turns appeared", reminderTurns.length >= 1, reminderTurns.length);
    s.check("reminders capped at limit 2", reminderTurns.length <= 2 && (count ?? 0) <= 2, { reminderTurns: reminderTurns.length, count, limit: status.reminders?.limit });
    s.check("reminder count equals limit", count === 2, count);
    // Idle-only: each turn starts after the previous completed.
    const raw = thread?.turns || [];
    const overlaps = raw.slice(1).filter((t, i) => raw[i].completedAt && t.startedAt && t.startedAt < raw[i].completedAt).length;
    s.check("no reminder turn started while a turn was active", overlaps === 0, { overlaps });
    s.check("status after the cap is unresolved", status.status === "unresolved", status.status);
  } catch (err) {
    s.check("scenario ran without exception", false, err.stack || String(err));
  }
  s.finish();
}

async function s6() {
  const s = scenario(6, "Fork with a different model and reconcile");
  try {
    if (!ctx.t1) throw new Error("needs scenario 1 thread");
    const models = await A.request("model/list", {});
    const ids = (models.data ?? models.models ?? []).map((m) => m.model ?? m.id).filter(Boolean);
    const original = await readThread(A, ctx.t1);
    const forkModel = args.forkModel ?? ids.find((m) => m !== original.model && !/codex-mini|oss/i.test(m)) ?? ids.find((m) => m !== original.model);
    s.evidence("models", { original: original.model, available: ids, chosen: forkModel });
    s.check("a different model is available", forkModel && forkModel !== original.model, forkModel);
    const before = turnCount(original);
    const reconcileRows = () => messageRows().filter((m) => m.to_session_id?.includes(ctx.t1) && forkMeta(m));
    const reconcileBefore = reconcileRows().length;
    const r = await call("fork_codex_thread", {
      threadId: ctx.t1,
      message: `${MARK}. Fork task: answer with exactly one word: 'forked'. Do not call any tools.`,
      model: forkModel,
      waitForResult: true,
      timeoutMs: 240000
    }, 320000);
    s.evidence("fork", trim(r, 2000));
    const forkId = r.forkThreadId ?? r.fork?.threadId ?? r.job?.forkThreadId;
    track(forkId, "A", "s6-fork");
    s.check("fork returned a fork thread id", forkId, forkId);
    await sleep(6000);
    const reconcile = reconcileRows();
    s.evidence("reconcile", reconcile.map((m) => ({ id: m.id, body: trim(m.body, 200), fork: forkMeta(m) })));
    s.check("exactly one reconcile message (fork metadata) in the original's mailbox", reconcile.length - reconcileBefore === 1, reconcile.length - reconcileBefore);
    const forkListing = await A.request("thread/list", { archived: true, limit: 50 }).catch((e) => ({ error: e.message }));
    const forkRow = (forkListing.data ?? []).find((t) => t.id === forkId);
    s.evidence("forkRow", forkRow ? { id: forkRow.id, threadSource: forkRow.threadSource, model: forkRow.model } : forkListing.error ?? "not in archived list");
    s.check("fork is archived", Boolean(forkRow), forkRow ? "archived" : "missing from archived listing");
    const forkRead = await A.request("thread/read", { threadId: forkId, includeTurns: false }).catch((e) => ({ error: e.message }));
    s.evidence("forkRead", { threadSource: forkRead.thread?.threadSource ?? null, source: forkRead.thread?.source ?? null, forkedFromId: forkRead.thread?.forkedFromId ?? null, error: forkRead.error });
    s.check("fork threadSource is agent-link-fork (thread/list or thread/read)", /agent-link-fork/.test(JSON.stringify([forkRow?.threadSource, forkRead.thread?.threadSource])), { list: forkRow?.threadSource ?? null, read: forkRead.thread?.threadSource ?? null });
    const forkReceipts = receiptRows().filter((x) => JSON.stringify(x).includes(forkId ?? "\u0000"));
    s.evidence("forkReceipts", forkReceipts.map((x) => trim(x, 500)));
    s.check("receipts carry tokenUsage", forkReceipts.some((x) => /tokenUsage/.test(JSON.stringify(x))), forkReceipts.length);
    const afterOrig = await waitIdle(A, ctx.t1, { minTurns: before });
    const pushed = summarizeTurns(afterOrig).slice(before);
    s.evidence("originalNewTurns", pushed);
    const pushedFork = (afterOrig?.turns ?? []).slice(before).flatMap((t) => (t.items ?? []).filter((i) => i.type === "userMessage").map(itemText)).find((txt) => /<fork /.test(txt));
    s.evidence("pushedForkElement", pushedFork ? (pushedFork.match(/<fork [^>]*\/>/) || [null])[0] : null);
    s.check("original got the reconcile pushed as a turn with a <fork> element", Boolean(pushedFork), pushed.length);
    s.check("original got no turn with the fork model", (afterOrig.model ?? original.model) === original.model, afterOrig.model);
    s.rec.turns = 1 + pushed.length;
  } catch (err) {
    s.check("scenario ran without exception", false, err.stack || String(err));
  }
  s.finish();
}

async function s7() {
  const s = scenario(7, "Roles: role:e2e-lead reaches the Codex thread and it replies");
  try {
    if (!ctx.t1) throw new Error("needs scenario 1 thread");
    const before = turnCount(await waitIdle(A, ctx.t1));
    const set = await call("set_agent_role", { role: "e2e-lead", agent: `codex:${ctx.t1}` });
    s.evidence("set_agent_role", trim(set, 600));
    s.check("set_agent_role ok", set.ok !== false && !set.isError, set);
    const r = await call("message_agent", {
      to: "role:e2e-lead",
      message: `${MARK}. Role test. Use the agent-link tool reply_agent_link_message to reply 'lead-ack' to this message. Do nothing else.`,
      anticipation: "reply"
    });
    s.evidence("message_agent", trim(r, 1200));
    const messageId = r.messageId ?? r.result?.messageId;
    s.check("message_agent resolved role to the thread", JSON.stringify(r).includes(ctx.t1), r.to);
    const wait = await call("wait_for_agent", { agent: "role:e2e-lead", replyToMessageId: messageId, timeoutMs: 240000 }, 300000);
    s.evidence("wait", trim(wait, 1200));
    s.check("reply received", wait.outcome === "reply" && /lead-ack/i.test(JSON.stringify(wait.reply ?? "")), wait.outcome);
    const after = await waitIdle(A, ctx.t1, { minTurns: before + 1 });
    s.rec.turns = turnCount(after) - before;
    const turns = summarizeTurns(after).slice(before);
    s.evidence("turns", turns);
    const replyTurn = turns.findIndex((t) => t.tools.some((x) => x.startsWith(`${MCP_NAME}.reply_agent_link_message`)));
    s.check("replied on the first turn or at the latest the first reminder", replyTurn === 0 || replyTurn === 1, replyTurn + 1);
    const declines = declineTexts(turns, replyTurn);
    s.evidence("declines", declines);
    for (const d of declines) s.note(`turn ${d.turn} did not reply; model text: ${JSON.stringify(d.agent)}`);
    await call("clear_agent_role", { role: "e2e-lead" }).catch(() => null);
  } catch (err) {
    s.check("scenario ran without exception", false, err.stack || String(err));
  }
  s.finish();
}

/** Runs the Codex prompt hook by hand, with the isolated env (no turn). */
function runCodexHook(threadId, cwd) {
  const payload = { session_id: threadId, turn_id: "manual", transcript_path: null, cwd, hook_event_name: "UserPromptSubmit", model: "manual", permission_mode: "bypassPermissions", prompt: "manual" };
  const r = spawnSync(process.execPath, [path.join(REPO, "src", "codex", "prompt-hook.js")], {
    input: JSON.stringify(payload), env: { ...scrubbedEnv(), ...sharedAgentLinkEnv }, encoding: "utf8", timeout: 10000
  });
  return { status: r.status, stdout: r.stdout.trim() };
}
/** hook/completed runs of the registered Agent Link prompt hook for one turn. */
function hookRuns(threadId, turnId) {
  return B.notifications
    .filter((n) => n.method === "hook/completed" && n.params?.threadId === threadId && (!turnId || n.params?.turnId === turnId))
    .map((n) => n.params.run)
    .filter((run) => String(run?.sourcePath ?? "").includes("session-flags") || String(run?.source ?? "") === "sessionFlags")
    .map((run) => ({ status: run.status, durationMs: run.durationMs === undefined ? null : Number(run.durationMs), entries: run.entries ?? [] }));
}
async function humanTurn(threadId, text) {
  const before = turnCount(await readThread(B, threadId).catch(() => null));
  const r = await B.request("turn/start", { threadId, input: [{ type: "text", text }] });
  const thread = await waitIdle(B, threadId, { minTurns: before + 1 });
  await sleep(1000);
  return { turnId: r.turn?.id, thread, turn: summarizeTurns(thread)[before] };
}

async function s9() {
  const s = scenario(9, "Codex prompt hook on a held thread");
  try {
    if (!ctx.hookKey) throw new Error("the prompt hook was not registered in app-server B");
    s.evidence("hook", { key: ctx.hookKey, trust: ctx.hookTrust });
    const BODY_TOKEN = "PELICAN-77";
    const cwd = newCwd("s9");
    const started = await B.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only" });
    const threadId = started.thread.id;
    track(threadId, "B", "s9-held-hook");
    // Turn 1, empty mailbox: the hook runs and adds nothing.
    const t1 = await humanTurn(threadId, `${MARK}. Reply with just the word 'ready'. Do not call any tools.`);
    const runs1 = hookRuns(threadId, t1.turnId);
    s.evidence("turn1HookRuns", runs1);
    s.check("turn 1 (no mail): hook ran with no context entry", runs1.length >= 1 && runs1.every((r) => r.entries.length === 0), runs1);
    // Queue a reply-anticipating message: held, so inbox only.
    const sent = await call("message_codex_thread", { threadId, message: `${MARK}. Held-thread hook test, body token ${BODY_TOKEN}. Reply 'held-ack' when asked.`, anticipation: "reply" });
    s.evidence("send", { delivery: sent.delivery, warnings: (sent.warnings ?? []).map((w) => w.code) });
    s.check("send queued with codex_desktop_push_disabled", sent.delivery === "queued" && /codex_desktop_push_disabled/.test(JSON.stringify(sent.warnings ?? [])), sent.delivery);
    const messageId = sent.messageId;
    // Turn 2: the user prompts; the hook says there is mail, without the body.
    const t2 = await humanTurn(threadId, "Call the agent-link tool read_agent_link_inbox once to see your mail. Do not reply to or resolve any message yet.");
    const runs2 = hookRuns(threadId, t2.turnId);
    const text2 = runs2.flatMap((r) => r.entries.map((e) => e.text)).join("\n");
    s.evidence("turn2HookRuns", runs2);
    s.evidence("turn2", { tools: t2.turn?.tools, agent: t2.turn?.agent });
    s.check("turn 2: hook context carries 'Agent Link: 1 pending peer message'", /Agent Link: 1 pending peer message/.test(text2), trim(text2, 300));
    s.check("turn 2: hook context has no message body", !text2.includes(BODY_TOKEN), text2.includes(BODY_TOKEN));
    s.check("turn 2: the thread read its inbox", (t2.turn?.tools ?? []).some((x) => x.startsWith(`${MCP_NAME}.read_agent_link_inbox`)), t2.turn?.tools);
    // Right after the read: delivered, reminder not due yet.
    const early = runCodexHook(threadId, cwd);
    s.evidence("manualHookRightAfterRead", early);
    s.check("before the interval: no reminder", early.status === 0 && early.stdout === "", early.stdout);
    const st = await call("get_agent_link_message_status", { messageId });
    s.evidence("statusAfterRead", { delivery: st.delivery, status: st.status, reminders: st.reminders });
    const dueIn = Math.max(0, Date.parse(st.reminders?.nextDueAt ?? "") - Date.now());
    await sleep((Number.isFinite(dueIn) ? dueIn : 30000) + 2000);
    // Turn 3: the reminder notice, once.
    const t3 = await humanTurn(threadId, "Say 'ok'. Do not call any tools.");
    const runs3 = hookRuns(threadId, t3.turnId);
    const text3 = runs3.flatMap((r) => r.entries.map((e) => e.text)).join("\n");
    s.evidence("turn3HookRuns", runs3);
    const limit = Number(sharedAgentLinkEnv.AGENT_LINK_REMINDER_LIMIT);
    s.check(`turn 3: reminder notice (reminder 1 of ${limit})`, text3.includes(`reminder 1 of ${limit}`) && !text3.includes(BODY_TOKEN), trim(text3, 300));
    // After the cap (limit 1) or the next interval: by hand, no turn.
    await sleep(32000);
    const late = runCodexHook(threadId, cwd);
    s.evidence("manualHookAfterInterval", late);
    const st2 = await call("get_agent_link_message_status", { messageId });
    s.evidence("statusAfterCap", { status: st2.status, reminders: st2.reminders });
    if (limit === 1) {
      s.check("after the cap: no notice, and the message reads unresolved", late.stdout === "" && st2.status === "unresolved", { stdout: late.stdout, status: st2.status });
    } else {
      s.check("next interval: reminder 2 notice", late.stdout.includes(`reminder 2 of ${limit}`), late.stdout);
    }
    s.check("reminder events recorded via codex-prompt-hook", mailboxEvents().some((e) => e.type === "reminded" && e.messageId === messageId && e.via === "codex-prompt-hook"), mailboxEvents().filter((e) => e.type === "reminded" && e.messageId === messageId));
    s.check("the held thread never got a pushed turn", turnCount(await readThread(B, threadId)) === 3, turnCount(await readThread(B, threadId)));
    s.rec.turns = 3;
  } catch (err) {
    s.check("scenario ran without exception", false, err.stack || String(err));
  }
  s.finish();
}

function healthChecks(s, side, h) {
  const text = JSON.stringify(h);
  s.evidence(`${side}Health`, trim(h, 3000));
  const dp = h.codex?.desktopPush ?? h.desktopPush ?? findKey(h, "desktopPush");
  s.check(`${side}: desktopPush mailbox-only`, /mailbox-only/.test(JSON.stringify(dp ?? "")), dp);
  s.check(`${side}: desktopPush version 0.159.2`, /0\.159\.2/.test(JSON.stringify(dp ?? "")) || /0\.159\.2/.test(text), (JSON.stringify(dp ?? "").match(/"version[^,}]*/) || [null])[0]);
  const oc = findKey(h, "overrideCosts");
  s.check(`${side}: overrideCosts measured`, oc && /measured/.test(JSON.stringify(oc)), oc);
  const fj = findKey(h, "forkJobs");
  s.check(`${side}: forkJobs counts present`, fj && typeof fj === "object", fj);
  const rc = findKey(h, "rolloutChecks");
  s.check(`${side}: rolloutChecks counts present`, rc && typeof rc === "object", rc);
  const warnings = (h.warnings ?? []).map((w) => w.code ?? w);
  s.evidence(`${side}Warnings`, warnings);
  s.check(`${side}: no unexpected warnings`, warnings.length === 0, warnings);
}
function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 5) return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function s8() {
  const s = scenario(8, "agent_link_health on both sides");
  try {
    const ch = await call("agent_link_health", {});
    healthChecks(s, "claude", ch);
    if (ctx.t1) {
      const xh = await codexSideTool(ctx.t1, "agent_link_health", {});
      healthChecks(s, "codex", xh);
    } else {
      s.check("codex side health (needs a thread)", false, "no thread");
    }
  } catch (err) {
    s.check("scenario ran without exception", false, err.stack || String(err));
  }
  s.finish();
}

// ---------------------------------------------------------------- main

async function discoverPluginIds(rpc) {
  try {
    const r = await rpc.request("plugin/installed", {});
    const all = JSON.stringify(r);
    const ids = new Set();
    for (const m of all.matchAll(/"id":"([^"]*agent-link[^"]*)"/g)) ids.add(m[1]);
    return [...ids];
  } catch {
    return [];
  }
}

/** Installed Agent Link MCP servers configured outside plugins (user-level mcp_servers entries). */
async function discoverAgentLinkMcpServers(rpc) {
  try {
    const r = await rpc.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly" });
    return (r.data ?? []).filter((sv) => sv.name !== MCP_NAME && /agent.?link/i.test(sv.name)).map((sv) => sv.name);
  } catch {
    return [];
  }
}

function appServerArgs(pluginIds, mcpNames, withMcp, extra = []) {
  const toml = (v) => JSON.stringify(v);
  // Codex splits -c key paths on "." and does not honour TOML quoting
  // (`plugins."a@b".enabled` is silently ignored), so ids go in bare.
  const key = (k) => {
    if (k.includes(".")) throw new Error(`cannot disable ${k} with -c: it contains a dot`);
    return k;
  };
  const out = [
    "-c", `approval_policy=${toml("never")}`,
    "-c", `sandbox_mode=${toml("read-only")}`,
    "-c", `model_reasoning_effort=${toml(args.effort)}`
  ];
  // Opt-in (--peer-authorization): a user grant for peer requests, as a
  // user would give in AGENTS.md. Off by default, since the envelope notice
  // says replying, declining, or marking done is always allowed; before
  // that notice, low-effort threads declined to reply without it.
  if (args.peerAuth) out.push("-c", `developer_instructions=${toml(PEER_AUTHORIZATION)}`);
  for (const id of pluginIds) out.push("-c", `plugins.${key(id)}.enabled=false`);
  for (const name of mcpNames) out.push("-c", `mcp_servers.${key(name)}.enabled=false`);
  if (withMcp) {
    const env = { ...sharedAgentLinkEnv, AGENT_LINK_HOST: "codex" };
    const envToml = `{${Object.entries(env).map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`;
    out.push(
      "-c", `mcp_servers.${MCP_NAME}.command=${toml(process.execPath)}`,
      "-c", `mcp_servers.${MCP_NAME}.args=[${toml(SERVER)}]`,
      "-c", `mcp_servers.${MCP_NAME}.env=${envToml}`,
      "-c", `mcp_servers.${MCP_NAME}.default_tools_approval_mode=${toml("approve")}`,
      "-c", `mcp_servers.${MCP_NAME}.startup_timeout_sec=30`
    );
  }
  return [...out, ...extra];
}

async function archiveAll() {
  for (const [threadId, info] of created) {
    const rpc = info.server === "B" ? B : A;
    try {
      await rpc.request("thread/archive", { threadId }, 30000);
      report.archived.push({ threadId, ok: true });
    } catch (err) {
      // A fork Agent Link already archived answers "no rollout found".
      const already = /archiv|no rollout found/i.test(err.message);
      report.archived.push({ threadId, ok: already, note: trim(err.message, 160) });
    }
  }
}

async function shutdown() {
  try { await claude?.client.close(); } catch { /* closing */ }
  A?.close();
  B?.close();
  for (const { child } of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await sleep(1500);
  for (const { child } of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

// App-server B stands in for the Codex desktop app: Agent Link is not pointed
// at it. Its threads get the build under test as their MCP server (same
// isolated state) and, for scenario 9, the repo's Codex prompt hook,
// registered and trusted for this process only: -c hooks.UserPromptSubmit,
// then -c hooks.state.<key>.trusted_hash from hooks/list (design R1.14a).
async function startHeldAppServer(pluginIds, mcpNames) {
  const hookEnv = Object.entries(sharedAgentLinkEnv).map(([k, v]) => `${k}=${shq(v)}`).join(" ");
  const command = `env ${hookEnv} ${shq(process.execPath)} ${shq(path.join(REPO, "src", "codex", "prompt-hook.js"))} 2>/dev/null; exit 0`;
  const hookArgs = want(9) ? ["-c", `hooks.UserPromptSubmit=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=10}]}]`] : [];
  startAppServer("B", P.sockB, appServerArgs(pluginIds, mcpNames, true, hookArgs));
  await waitForSocket(P.sockB);
  let rpc = new Rpc(P.sockB, "B");
  await rpc.open();
  if (!want(9)) return rpc;
  const listed = await rpc.request("hooks/list", { cwds: [P.cwds] });
  const hook = (listed.data ?? []).flatMap((e) => e.hooks ?? []).find((h) => h.source === "sessionFlags" && h.handlerType === "command" && String(h.command).includes("prompt-hook.js"));
  if (!hook) throw new Error(`the prompt hook is not listed: ${trim(listed, 400)}`);
  rpc.close();
  const entry = children.pop();
  entry.child.kill("SIGTERM");
  await new Promise((r) => entry.child.once("exit", r));
  fs.rmSync(P.sockB, { force: true });
  const trust = ["-c", `hooks.state={${JSON.stringify(hook.key)}={trusted_hash=${JSON.stringify(hook.currentHash)}}}`];
  startAppServer("B", P.sockB, appServerArgs(pluginIds, mcpNames, true, [...hookArgs, ...trust]));
  await waitForSocket(P.sockB);
  rpc = new Rpc(P.sockB, "B");
  await rpc.open();
  const relisted = await rpc.request("hooks/list", { cwds: [P.cwds] });
  const now = (relisted.data ?? []).flatMap((e) => e.hooks ?? []).find((h) => h.key === hook.key);
  ctx.hookKey = hook.key;
  ctx.hookTrust = now?.trustStatus ?? null;
  report.setup.promptHook = { key: hook.key, trustStatus: ctx.hookTrust };
  if (ctx.hookTrust !== "trusted") throw new Error(`the prompt hook is ${ctx.hookTrust} after hooks.state`);
  return rpc;
}
const shq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

async function main() {
  log(`codex ${codexVersion}; temp root ${root}; Claude session ${CLAUDE_SESSION}`);
  writeFakeClaudeTranscript();

  // Discover installed Agent Link plugin ids with a bare probe app-server on B's socket.
  let pluginIds = args.disablePlugins.length ? args.disablePlugins : null;
  let mcpNames = args.disableMcp;
  if (!pluginIds) {
    startAppServer("probe", P.sockB, []);
    await waitForSocket(P.sockB);
    const probe = new Rpc(P.sockB, "probe");
    await probe.open();
    pluginIds = [...new Set([...DEFAULT_PLUGIN_IDS, ...(await discoverPluginIds(probe))])];
    mcpNames = [...new Set([...mcpNames, ...(await discoverAgentLinkMcpServers(probe))])];
    probe.close();
    const entry = children.pop();
    entry.child.kill("SIGTERM");
    await new Promise((r) => entry.child.once("exit", r));
    fs.rmSync(P.sockB, { force: true });
  }
  report.setup.disabledPlugins = pluginIds;
  report.setup.disabledMcpServers = mcpNames;

  startAppServer("A", P.sockA, appServerArgs(pluginIds, mcpNames, true));
  await waitForSocket(P.sockA);
  A = new Rpc(P.sockA, "A");
  await A.open();
  B = await startHeldAppServer(pluginIds, mcpNames);

  // Which MCP servers / tools Codex threads in A get.
  const status = await A.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly" }).catch(() => A.request("mcpServerStatus/list", {}));
  const servers = (status.data ?? []).map((sv) => ({ name: sv.name, pluginId: sv.pluginId, tools: Object.keys(sv.tools ?? {}).length }));
  const ours = (status.data ?? []).find((sv) => sv.name === MCP_NAME);
  report.setup.mcpServers = servers;
  report.setup.testServerTools = ours ? Object.keys(ours.tools ?? {}).sort() : [];
  report.setup.otherAgentLinkServers = servers.filter((sv) => sv.name !== MCP_NAME && sv.tools > 0 && /agent.?link/i.test(`${sv.name} ${sv.pluginId}`));
  log("MCP servers in app-server A:", servers);
  if (!ours || report.setup.testServerTools.length === 0) throw new Error("test MCP server did not load in app-server A");
  if (report.setup.otherAgentLinkServers.length) {
    throw new Error(`another Agent Link MCP server still exposes tools: ${JSON.stringify(report.setup.otherAgentLinkServers)}; pass --disable-mcp-server / --disable-plugin`);
  }

  await startClaudeSide();

  if (args.setupOnly) {
    log("setup only:", report.setup.promptHook ?? "no prompt hook (scenario 9 not selected)");
    return;
  }
  for (const [n, fn] of [[1, s1], [2, s2], [3, s3], [4, s4], [6, s6], [7, s7], [5, s5], [8, s8], [9, s9]]) {
    if (!want(n)) continue;
    await fn();
    if (n === 1) for (let run = 2; run <= (args.s1Runs ?? 1); run += 1) await s1(run);
  }
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  report.errors.push(err.stack || String(err));
  log("FATAL", err.stack || String(err));
  exitCode = 1;
} finally {
  try { if (A && B) await archiveAll(); } catch (err) { report.errors.push(`archive: ${err.message}`); }
  for (const t of report.threads) {
    const rpc = t.server === "B" ? B : A;
    const th = await rpc?.request("thread/read", { threadId: t.threadId, includeTurns: true }).catch(() => null);
    t.turns = th?.thread?.turns?.length ?? null;
  }
  report.turnsObserved = report.threads.reduce((n, t) => n + (t.label.endsWith("fork") ? 1 : (t.turns ?? 0)), 0);
  await shutdown();
  report.finishedAt = new Date().toISOString();
  const reportPath = args.report ?? path.join(os.tmpdir(), `agent-link-e2e-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log("\n=== Summary");
  for (const [n, sc] of Object.entries(report.scenarios)) log(`  ${n}. ${sc.verdict.padEnd(8)} ${sc.title}`);
  log(`  threads: ${report.threads.map((t) => `${t.threadId}(${t.label}, turns ${t.turns}${t.label.endsWith("fork") ? " incl. copied" : ""})`).join(", ")}`);
  log(`  archived: ${report.archived.filter((a) => a.ok).length}/${report.threads.length}; model turns observed: ${report.turnsObserved}`);
  log(`  report: ${reportPath}`);
  if (!args.keepState) fs.rmSync(root, { recursive: true, force: true });
  else log(`  state kept at ${root}`);
  if (Object.values(report.scenarios).some((sc) => sc.verdict !== "pass")) exitCode = exitCode || 1;
  process.exit(exitCode);
}
