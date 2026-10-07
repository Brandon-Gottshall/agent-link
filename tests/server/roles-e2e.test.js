// Roles end to end over MCP stdio (design doc T-1.8, T-1.9, T-1.10, T-1.11,
// T-9.3, T-9.5, T-9.6; PR B9) against an in-process fake Codex app-server
// and a fixture Claude transcript:
//   - the AGENT_LINK_ROLE_ADMIN gate on the write tools;
//   - role:<name> on message_codex_thread, message_claude_session and
//     resolve_agent, with via/procedure in the envelope and the procedure
//     text once per version;
//   - list_agents exposing roles;
//   - the target-side override policy (launcher effort, policy switches,
//     cwd workspace check, switch receipts, no revert);
//   - enforcement modes off / warn / enforce from AGENT_LINK_ROLE_ENFORCEMENT.
// Never launches Codex; HOME, CODEX_HOME, the state dir, receipts and the
// mailbox live in a temp directory.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";
import { pluginRoot } from "../helpers/codex-stub.js";
import { hermeticEnv } from "../helpers/env.js";
import { peerMessageFromMailbox, renderPeerEnvelope } from "../../src/shared/envelope.js";
import { openMailbox } from "../../src/claude/mailbox.js";

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-link-roles-e2e-")));
const codexHome = path.join(tmp, "codex");
mkdirSync(codexHome, { recursive: true });
const stateDir = path.join(tmp, "state");
const projectDir = path.join(tmp, "project");
mkdirSync(path.join(projectDir, ".git"), { recursive: true });
mkdirSync(path.join(projectDir, "sub"), { recursive: true });
const outsideDir = path.join(tmp, "outside");
mkdirSync(outsideDir, { recursive: true });

const id = (n) => `019d9100-0000-7000-8000-${String(n).padStart(12, "0")}`;
const ROUTER_T = id(1);
const WORKER_T = id(2);
const LAUNCHED = id(3);
const CALLER = id(10);
const OTHER = id(11);
const MISSING = id(0xfff);
const CLAUDE_ID = "0b5e7c1a-3f2d-4a6e-9c8b-0000000000b9";

// A Claude Code transcript, so the Claude provider and message_claude_session find the session.
const projects = path.join(tmp, ".claude", "projects", "-work-planner");
mkdirSync(projects, { recursive: true });
writeFileSync(path.join(projects, `${CLAUDE_ID}.jsonl`), `${JSON.stringify({ type: "summary", title: "Planner session", cwd: "/work/planner", timestamp: new Date().toISOString() })}\n`);

const thread = (threadId, extra = {}) => ({ id: threadId, name: `T ${threadId.slice(-2)}`, preview: "", status: { type: "idle" }, cwd: projectDir, model: "gpt-known", reasoningEffort: "medium", createdAt: 1779086300, updatedAt: 1779086400, ...extra });
const threads = { [ROUTER_T]: thread(ROUTER_T), [WORKER_T]: thread(WORKER_T), [LAUNCHED]: thread(LAUNCHED) };

const received = [];
let turnCounter = 0;
const server = http.createServer();
const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id === undefined) return;
    received.push(msg);
    const reply = (payload) => socket.send(JSON.stringify({ id: msg.id, ...payload }));
    switch (msg.method) {
      case "initialize":
        return reply({ result: { userAgent: "fake", codexHome, platformOs: "macos" } });
      case "thread/read":
        if (!threads[msg.params.threadId]) return reply({ error: { code: -32600, message: `thread not found: ${msg.params.threadId}` } });
        return reply({ result: { thread: threads[msg.params.threadId] } });
      case "thread/start":
        return reply({ result: { thread: threads[LAUNCHED] } });
      case "thread/name/set":
        return reply({ result: {} });
      case "turn/start":
        turnCounter += 1;
        return reply({ result: { turn: { id: `turn-${turnCounter}`, status: "inProgress", items: [] } } });
      case "thread/loaded/list":
        return reply({ result: { data: [], nextCursor: null } });
      default:
        return reply({ error: { code: -32601, message: `fake: ${msg.method}` } });
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `ws://127.0.0.1:${server.address().port}`;

/** @param {Record<string, string>} extra */
async function connect(extra = {}) {
  const client = new Client({ name: "roles-e2e", version: "0" });
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
        AGENT_LINK_MAILBOX_PATH: path.join(stateDir, "mailbox.jsonl"),
        AGENT_LINK_RECEIPT_LOG: path.join(stateDir, "receipts.jsonl"),
        AGENT_LINK_MANAGED_DIR: path.join(tmp, "managed"),
        AGENT_LINK_DISABLE_CHANNEL: "1",
        CLAUDE_CONFIG_DIR: path.join(tmp, ".claude"),
        ...extra
      }
    }),
    stderr: "ignore"
  }));
  /**
   * @param {string} name
   * @param {Record<string, any>} args
   * @param {string | null} [caller]  the calling Codex thread (runtime _meta)
   */
  const call = async (name, args, caller = CALLER) => {
    const result = await client.callTool({ name, arguments: args, ...(caller ? { _meta: { threadId: caller } } : {}) });
    const payload = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, payload, `${name}: structuredContent matches the text copy`);
    assert.equal(result.isError, payload.ok === false);
    return payload;
  };
  return { client, call };
}

const turnStarts = (mark) => received.slice(mark).filter((msg) => msg.method === "turn/start");
const lastTurnText = (mark) => turnStarts(mark).at(-1)?.params.input[0].text ?? "";

const opened = [];
try {
  // ------------------------------------------------------------ admin gate
  const plain = await connect();
  opened.push(plain.client);
  for (const [name, args] of [
    ["set_agent_role", { role: "router", agent: `codex:${ROUTER_T}` }],
    ["clear_agent_role", { role: "router" }],
    ["set_agent_override_policy", { target: `codex:${WORKER_T}`, model: ["*"] }]
  ]) {
    const denied = await plain.call(name, args);
    assert.equal(denied.error.code, "permission_denied", name);
    assert.equal(denied.error.details.reason, "role_admin_disabled", name);
    assert.match(denied.error.hint, /AGENT_LINK_ROLE_ADMIN=1/);
  }
  // A tool argument cannot grant admin: unknown properties are rejected.
  assert.equal((await plain.call("set_agent_role", { role: "router", agent: `codex:${ROUTER_T}`, admin: true })).error.code, "invalid_arguments");
  let listed = await plain.call("list_agent_roles", {});
  assert.deepEqual([listed.admin, listed.exists, listed.roles.length, listed.enforcement.mode, listed.enforcement.source], [false, false, 0, "off", "default"]);
  let health = await plain.call("agent_link_health", { startAppServer: false });
  assert.deepEqual([health.roles.admin, health.roles.enforcement.mode, health.roles.enforcement.source], [false, "off", "default"]);

  // ------------------------------------------------------------ role admin
  const admin = await connect({ AGENT_LINK_ROLE_ADMIN: "1" });
  opened.push(admin.client);
  const { call } = admin;
  let r = await call("set_agent_role", { role: "router", agent: `codex:${ROUTER_T}`, procedure: "Route all work.\nUse <labels>." });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.role.address, r.role.procedure.version, r.holder.harness, r.previousAddress], [`codex:${ROUTER_T}`, 1, "codex", null]);
  assert.equal(statSync(path.join(stateDir, "roles.json")).mode & 0o777, 0o600);
  r = await call("set_agent_role", { role: "planner", agent: CLAUDE_ID, procedure: "Plan, then hand off." });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.role.address, `claude:${CLAUDE_ID}`, "a bare id is stored as the canonical address");
  assert.equal((await call("set_agent_role", { role: "ghost", agent: `codex:${MISSING}` })).error.code, "not_found");
  assert.equal((await call("set_agent_role", { role: "Bad Name", agent: `codex:${ROUTER_T}` })).error.code, "invalid_arguments");
  assert.equal((await call("set_agent_role", { role: "x", agent: "role:router" })).error.code, "invalid_arguments");

  listed = await call("list_agent_roles", {});
  assert.deepEqual(listed.roles.map((role) => [role.role, role.address]), [["planner", `claude:${CLAUDE_ID}`], ["router", `codex:${ROUTER_T}`]]);
  const got = await call("get_agent_role", { role: "router", includeProcedure: true });
  assert.equal(got.role.procedure.text, "Route all work.\nUse <labels>.");
  assert.equal((await call("get_agent_role", { role: "nobody" })).error.code, "not_found");

  // resolve_agent and list_agents expose roles.
  r = await call("resolve_agent", { query: "role:router" });
  assert.deepEqual([r.status, r.via, r.role, r.best.address, r.best.roles], ["resolved", "role:router", "router", `codex:${ROUTER_T}`, ["router"]]);
  assert.equal((await call("resolve_agent", { query: "role:nobody" })).status, "not_found");
  r = await call("list_agents", { harness: "claude" });
  assert.deepEqual(r.sessions.find((session) => session.address === `claude:${CLAUDE_ID}`)?.roles, ["planner"]);

  // T-1.8 / T-1.9: message_codex_thread to role:router.
  let mark = received.length;
  r = await call("message_codex_thread", { threadId: "role:router", message: "first" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.threadId, r.via, r.roleProcedure], [ROUTER_T, "role:router", { name: "router", version: 1, textIncluded: true }]);
  let text = lastTurnText(mark);
  assert.match(text, /^<agent-link-message [^>]* via="role:router" procedure="router@1">/);
  assert.match(text, /\n<procedure name="router" version="1">Route all work\.\nUse &lt;labels&gt;\.<\/procedure>\n<body>\nfirst\n<\/body>/);
  mark = received.length;
  r = await call("message_codex_thread", { threadId: "role:router", message: "second" });
  assert.equal(r.roleProcedure.textIncluded, false);
  text = lastTurnText(mark);
  assert.match(text, /procedure="router@1"/);
  assert.ok(!text.includes("<procedure"), "the text goes only with the first delivery of a version");
  // A hand edit of the procedure file is version 2, delivered once.
  writeFileSync(path.join(stateDir, "roles", "router.md"), "Route all work, v2.");
  // I3: read-only tools see the change as pending and write nothing.
  const snapshot = () => ["roles.json", "role-state.json"].map((name) => readFileSync(path.join(stateDir, name), "utf8"));
  const beforeReads = snapshot();
  const pending = await call("get_agent_role", { role: "router" });
  assert.deepEqual([pending.role.procedure.version, pending.role.procedure.pending], [1, true]);
  await call("list_agent_roles", {});
  await call("resolve_agent", { query: "role:router" });
  await call("list_agents", { harness: "claude" });
  await call("get_agent_override_policy", {});
  await call("agent_link_health", { startAppServer: false });
  assert.deepEqual(snapshot(), beforeReads, "read-only tools wrote nothing");
  mark = received.length;
  r = await call("message_codex_thread", { threadId: "role:router", message: "third" });
  assert.deepEqual(r.roleProcedure, { name: "router", version: 2, textIncluded: true });
  assert.match(lastTurnText(mark), /<procedure name="router" version="2">Route all work, v2\.<\/procedure>/);
  const receipts = await call("list_agent_link_receipts", { target: `codex:${ROUTER_T}`, limit: 5 });
  assert.deepEqual(receipts.data.slice(0, 3).map((receipt) => [receipt.via, receipt.roleProcedure?.version]), [["role:router", 2], ["role:router", 1], ["role:router", 1]]);

  // A refused procedure file (here a symlink) is reported on the send and its receipt.
  const procedurePath = path.join(stateDir, "roles", "router.md");
  rmSync(procedurePath);
  writeFileSync(path.join(tmp, "elsewhere.md"), "not a procedure");
  symlinkSync(path.join(tmp, "elsewhere.md"), procedurePath);
  mark = received.length;
  r = await call("message_codex_thread", { threadId: "role:router", message: "with a bad procedure" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.roleProcedure, null);
  const refused = r.warnings.find((w) => w.code === "role_procedure_unavailable");
  assert.match(refused.message, /not a regular file/);
  assert.ok(!lastTurnText(mark).includes("<procedure"));
  assert.match((await call("list_agent_link_receipts", { target: `codex:${ROUTER_T}`, limit: 1 })).data[0].roleProcedureWarning.problem, /not a regular file/);
  rmSync(procedurePath);
  writeFileSync(procedurePath, "Route all work, v2.");

  // Role holder on the wrong harness.
  assert.equal((await call("message_codex_thread", { threadId: "role:planner", message: "x" })).error.code, "invalid_arguments");
  r = await call("message_codex_thread", { threadId: "role:planner", message: "x", model: "m" });
  assert.deepEqual([r.error.code, r.error.details.capability], ["unsupported", "turn_overrides"]);
  assert.equal((await call("message_claude_session", { sessionId: "role:router", message: "x" })).error.code, "invalid_arguments");

  // message_claude_session to role:planner: the mailbox row carries via and the procedure.
  r = await call("message_claude_session", { sessionId: "role:planner", message: "plan this" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.via, r.roleProcedure, r.target.address], ["role:planner", { name: "planner", version: 1, textIncluded: true }, `claude:${CLAUDE_ID}`]);
  const firstId = r.messageId;
  r = await call("message_claude_session", { sessionId: "role:planner", message: "and this" });
  assert.equal(r.roleProcedure.textIncluded, false);
  const mb = openMailbox({ mailboxPath: path.join(stateDir, "mailbox.jsonl") });
  const rendered = [firstId, r.messageId].map((messageId) => renderPeerEnvelope(peerMessageFromMailbox(mb.getMessage({ messageId }))));
  mb.close();
  assert.match(rendered[0], /via="role:planner" procedure="planner@1"/);
  assert.match(rendered[0], /<procedure name="planner" version="1">Plan, then hand off\.<\/procedure>/);
  assert.ok(!rendered[1].includes("<procedure"));

  // clear: role:router is not_found until reassigned; the procedure version is kept.
  r = await call("clear_agent_role", { role: "router" });
  assert.deepEqual([r.cleared, r.previousAddress, r.role.procedure.version], [true, `codex:${ROUTER_T}`, 2]);
  r = await call("message_codex_thread", { threadId: "role:router", message: "x" });
  assert.deepEqual([r.error.code, r.error.details.role], ["not_found", "router"]);

  // ------------------------------------------------------------ overrides (T-9.3, T-9.5, T-9.6)
  // Launcher effort: CALLER launches LAUNCHED and may change its effort; OTHER may not.
  r = await call("launch_codex_thread", { name: "Launched", message: "go", cwd: projectDir });
  assert.equal(r.ok, true, JSON.stringify(r));
  r = await call("message_codex_thread", { threadId: LAUNCHED, message: "harder", effort: "high" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.switches.map((s) => [s.setting, s.previous, s.current, s.grantedBy, s.persists]), [["effort", "medium", "high", "launcher", true]]);
  r = await call("message_codex_thread", { threadId: LAUNCHED, message: "harder", effort: "high" }, OTHER);
  assert.deepEqual([r.error.code, r.error.details.reason], ["permission_denied", "effort_not_permitted"]);
  // Nobody launched WORKER_T through Agent Link: effort needs policy for everyone.
  r = await call("message_codex_thread", { threadId: WORKER_T, message: "x", effort: "high" });
  assert.equal(r.error.details.reason, "effort_not_permitted");

  // Model switch without policy: refused, no turn sent.
  mark = received.length;
  r = await call("message_codex_thread", { threadId: WORKER_T, message: "x", model: "gpt-other" }, OTHER);
  assert.deepEqual([r.error.code, r.error.details.reason], ["permission_denied", "model_switch_requires_fork_or_opt_in"]);
  assert.equal(turnStarts(mark).length, 0, "nothing was sent");
  // The deprecated allowTargetOverride still grants (0.6.0), with a warning and a receipt.
  r = await call("message_codex_thread", { threadId: LAUNCHED, message: "x", model: "gpt-flag", allowTargetOverride: true }, OTHER);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.switches.map((s) => [s.setting, s.grantedBy]), [["model", "allowTargetOverride"]]);
  assert.ok(r.warnings.some((w) => w.code === "deprecated_argument"));
  const flagReceipts = await call("list_agent_link_receipts", { action: "model_switch", limit: 1 });
  assert.equal(flagReceipts.data[0].override.grantedBy, "allowTargetOverride");

  // With policy: the switch is applied, reported, receipted, and never reverted.
  r = await call("set_agent_override_policy", { target: `codex:${WORKER_T}`, model: [`codex:${OTHER}`], cwd: ["*"] });
  assert.deepEqual(r.policy, { model: [`codex:${OTHER}`], cwd: ["*"] });
  assert.deepEqual((await call("get_agent_override_policy", { target: `codex:${WORKER_T}` })).policy, r.policy);
  assert.equal((await call("set_agent_override_policy", { target: "nobody", model: ["*"] })).error.code, "invalid_arguments");
  assert.equal((await call("set_agent_override_policy", { target: `codex:${WORKER_T}`, model: ["bogus"] })).error.code, "invalid_arguments");
  mark = received.length;
  r = await call("message_codex_thread", { threadId: WORKER_T, message: "switch", model: "gpt-other" }, OTHER);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.switches[0], {
    setting: "model", previous: "gpt-known", current: "gpt-other", grantedBy: "policy",
    policy: { key: `codex:${WORKER_T}`, sender: `codex:${OTHER}` }, persists: true,
    expectedCost: { uncachedInputTokens: null, basis: "unknown" }
  });
  assert.equal(turnStarts(mark)[0].params.model, "gpt-other");
  assert.match(lastTurnText(mark), /<overrides model="gpt-other"\/>/);
  assert.equal(r.switchReceipts[0].recorded, true);
  const switchReceipts = await call("list_agent_link_receipts", { action: "model_switch", limit: 5 });
  assert.equal(switchReceipts.data[0].override.kind, "model-switch");
  assert.deepEqual([switchReceipts.data[0].override.by, switchReceipts.data[0].override.grantedBy], [`codex:${OTHER}`, "policy"]);
  mark = received.length;
  await call("message_codex_thread", { threadId: WORKER_T, message: "plain follow-up" }, OTHER);
  assert.equal(turnStarts(mark).length, 1);
  assert.equal(Object.hasOwn(turnStarts(mark)[0].params, "model"), false, "no revert turn, no model on later turns");

  // cwd: inside the workspace with policy switches; outside is refused even with policy.
  r = await call("message_codex_thread", { threadId: WORKER_T, message: "cd", cwd: path.join(projectDir, "sub") });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.switches.map((s) => [s.setting, s.grantedBy]), [["cwd", "policy"]]);
  r = await call("message_codex_thread", { threadId: WORKER_T, message: "cd", cwd: outsideDir });
  assert.deepEqual([r.error.code, r.error.details.reason], ["permission_denied", "cwd_outside_workspace"]);
  // `*` never matches a sender with no runtime identity.
  r = await call("message_codex_thread", { threadId: WORKER_T, message: "cd", cwd: path.join(projectDir, "sub") }, null);
  assert.equal(r.error.details.reason, "cwd_change_not_permitted");

  // ------------------------------------------------------------ enforcement (T-1.10, T-1.11)
  await call("set_agent_role", { role: "router", agent: `codex:${ROUTER_T}` });
  await call("set_agent_role", { role: "builder", agent: `codex:${WORKER_T}` });
  // off (the default): direct coordination is not even flagged.
  r = await call("message_codex_thread", { threadId: WORKER_T, message: "direct" }, ROUTER_T);
  assert.equal(r.ok, true);
  assert.ok(!(r.warnings ?? []).some((w) => w.code === "direct_coordination"));

  const warn = await connect({ AGENT_LINK_ROLE_ENFORCEMENT: "warn" });
  opened.push(warn.client);
  health = await warn.call("agent_link_health", { startAppServer: false });
  assert.deepEqual([health.roles.enforcement.mode, health.roles.enforcement.source], ["warn", "AGENT_LINK_ROLE_ENFORCEMENT"]);
  r = await warn.call("message_codex_thread", { threadId: WORKER_T, message: "direct" }, ROUTER_T);
  assert.equal(r.ok, true);
  const warning = r.warnings.find((w) => w.code === "direct_coordination");
  assert.deepEqual([warning.replacement, warning.details.recipientRoles], ["role:builder", ["builder"]]);
  const tagged = await warn.call("list_agent_link_receipts", { target: `codex:${WORKER_T}`, limit: 1 });
  assert.ok(tagged.data[0].tags.includes("direct-coordination"));
  r = await warn.call("message_codex_thread", { threadId: "role:builder", message: "via role" }, ROUTER_T);
  assert.ok(!(r.warnings ?? []).some((w) => w.code === "direct_coordination"));
  r = await warn.call("message_codex_thread", { threadId: WORKER_T, message: "from a worker" }, CALLER);
  assert.ok(!(r.warnings ?? []).some((w) => w.code === "direct_coordination"));

  const enforce = await connect({ AGENT_LINK_ROLE_ENFORCEMENT: "enforce" });
  opened.push(enforce.client);
  mark = received.length;
  r = await enforce.call("message_codex_thread", { threadId: WORKER_T, message: "direct" }, ROUTER_T);
  assert.deepEqual([r.error.code, r.error.details.reason, r.error.details.recipientRoles], ["permission_denied", "role_address_required", ["builder"]]);
  assert.equal(turnStarts(mark).length, 0, "nothing is sent under enforce");
  r = await enforce.call("message_codex_thread", { threadId: "role:builder", message: "via role" }, ROUTER_T);
  assert.equal(r.ok, true, JSON.stringify(r));
  // The Claude send path runs the same check before writing the mailbox.
  await call("set_agent_role", { role: "planner", agent: `claude:${CLAUDE_ID}` });
  const before = readFileSync(path.join(stateDir, "mailbox.jsonl"), "utf8");
  r = await enforce.call("message_claude_session", { sessionId: CLAUDE_ID, message: "direct" }, ROUTER_T);
  assert.equal(r.error?.details?.reason, "role_address_required", JSON.stringify(r));
  assert.equal(readFileSync(path.join(stateDir, "mailbox.jsonl"), "utf8"), before, "nothing is written to the mailbox under enforce");
  r = await enforce.call("message_claude_session", { sessionId: "role:planner", message: "via role" }, ROUTER_T);
  assert.equal(r.ok, true, JSON.stringify(r));

  console.log("roles e2e tests passed");
} finally {
  for (const client of opened) await client.close().catch(() => {});
  wss.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
