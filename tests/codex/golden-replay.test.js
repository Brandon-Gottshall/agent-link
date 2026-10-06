// Golden replay for the Codex tools (design doc R5.2, PR B5).
//
// Runs one fixed script of tool calls over MCP stdio against a stateful fake
// Codex app-server and compares every normalized result, plus the app-server
// requests each call made, with tests/fixtures/golden/codex-tools.golden.json.
// The fixture was recorded from the pre-split server (origin/main 3306086), so
// a refactor that changes any output, error, receipt or app-server request
// fails here. Random and clock-derived values (peer message ids, receipt ids,
// timestamps near now, waited times, temp paths, the fake's port) are
// normalized; ids keep their identity (the same id maps to the same token).
//
//   node tests/codex/golden-replay.test.js            compare
//   node tests/codex/golden-replay.test.js --update   re-record (intended changes only)
//   node tests/codex/golden-replay.test.js --server <path/to/server.js>
//                                                     replay against another tree
//
// Never launches Codex; HOME, CODEX_HOME, receipts and the mailbox are temp.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";
import { pluginRoot } from "../helpers/codex-stub.js";
import { hermeticEnv } from "../helpers/env.js";

const update = process.argv.includes("--update");
const serverFlag = process.argv.indexOf("--server");
const serverEntry = serverFlag >= 0 ? path.resolve(process.argv[serverFlag + 1]) : path.join(pluginRoot, "src", "server.js");
const fixturePath = path.join(pluginRoot, "tests", "fixtures", "golden", "codex-tools.golden.json");

const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-link-golden-"));
const tmpReal = realpathSync(tmp);
const codexHome = path.join(tmp, "codex");
const projectDir = path.join(tmp, "project");
mkdirSync(projectDir, { recursive: true });

const id = (n) => `019d3000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const ALPHA = id(1);
const BETA = id(2);
const GAMMA = id(3);
const SCOUT = id(4);
const ORCH = id(5);
const OLD = id(6);
const LOCAL_ONLY = id(7);
const MISSING = id(0xfff);
const FIXED_SECONDS = 1779086400; // a fixed date in 2026, far from "now"

// One local transcript with a fixed mtime, for the fallback and suggestion paths.
const day = path.join(codexHome, "sessions", "2026", "05", "18");
mkdirSync(day, { recursive: true });
const localFile = path.join(day, `rollout-2026-05-18T10-00-00-${LOCAL_ONLY}.jsonl`);
writeFileSync(localFile, [
  { timestamp: "2026-05-18T10:00:00.000Z", type: "session_meta", payload: { id: LOCAL_ONLY, timestamp: "2026-05-18T10:00:00.000Z", cwd: "/work/local" } },
  { timestamp: "2026-05-18T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Local Only Search Target" } },
  { timestamp: "2026-05-18T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "local answer" } },
  { timestamp: "2026-05-18T10:00:03.000Z", type: "event_msg", payload: { type: "task_complete" } }
].map((record) => JSON.stringify(record)).join("\n") + "\n");
utimesSync(localFile, FIXED_SECONDS, FIXED_SECONDS);

// Claude transcripts for the session registry steps (PR B6). Written by the
// "__claude_fixture" step, after the steps recorded before B6, so their
// Claude session counts are unchanged. CLAUDE_TWIN reuses ALPHA's id, so a
// bare-id lookup of ALPHA names a Claude session and a Codex thread.
const CLAUDE_SESSION = "0b5e7c1a-3f2d-4a6e-9c8b-000000000b6b";
const CLAUDE_TWIN = ALPHA;
function writeClaudeFixture() {
  const projects = path.join(tmp, ".claude", "projects", "-work-claude-project");
  mkdirSync(projects, { recursive: true });
  for (const [sessionId, title] of [[CLAUDE_SESSION, "Golden Claude planner"], [CLAUDE_TWIN, "Golden Claude twin"]]) {
    const file = path.join(projects, `${sessionId}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: "summary", title, cwd: "/work/claude-project", timestamp: "2026-05-18T09:00:00.000Z" })}\n`);
    utimesSync(file, FIXED_SECONDS + 30, FIXED_SECONDS + 30);
  }
}
const SETUP_STEPS = { __claude_fixture: writeClaudeFixture };

// ---------------------------------------------------------------- fake app-server
const item = (type, itemId, extra = {}) => ({ type, id: itemId, ...extra });
function makeThreads() {
  const base = (threadId, name, extra = {}) => ({
    id: threadId,
    name,
    preview: `${name} preview`,
    status: { type: "idle" },
    cwd: "/work/project",
    model: "gpt-known",
    reasoningEffort: null,
    path: `/codex-home/sessions/2026/05/18/rollout-${threadId}.jsonl`,
    createdAt: FIXED_SECONDS,
    updatedAt: FIXED_SECONDS + 60,
    source: "vscode",
    modelProvider: "openai",
    cliVersion: "0.0.0-fake",
    turns: [
      {
        id: `${name.toLowerCase().split(" ")[0]}-t1`,
        status: "completed",
        startedAt: FIXED_SECONDS,
        completedAt: FIXED_SECONDS + 5,
        durationMs: 5000,
        items: [
          item("userMessage", "u1", { content: [{ type: "text", text: `hello ${name}` }, { type: "mention", name: "repo" }] }),
          item("reasoning", "r1", { summary: ["thinking", 42] }),
          item("commandExecution", "c1", { command: "ls -la", status: "completed", exitCode: 0, durationMs: 12 }),
          item("mcpToolCall", "m1", { server: "agent-link", tool: "list_codex_threads", status: "completed", durationMs: 3 }),
          item("collabAgentToolCall", "k1", { tool: "spawn", status: "completed", receiverThreadIds: [SCOUT, "bad id with spaces"], agentsStates: { [SCOUT]: "running" } }),
          item("weirdThing", "w1"),
          item("agentMessage", "a1", { text: `answer from ${name}`, phase: "final_answer" })
        ]
      }
    ],
    ...extra
  });
  return new Map([
    [ALPHA, base(ALPHA, "Alpha worker", { cwd: realpathSync(projectDir) })],
    [BETA, base(BETA, "Beta active", {
      status: { type: "active", activeFlags: [] },
      turns: [{ id: "beta-live", status: "inProgress", startedAt: FIXED_SECONDS, items: [item("userMessage", "bu", { content: [{ type: "text", text: "go" }] })] }]
    })],
    [GAMMA, base(GAMMA, "Gamma sleeping", { status: { type: "notLoaded" } })],
    [SCOUT, base(SCOUT, "Scout subagent", {
      source: { subAgent: { threadSpawn: { parentThreadId: ALPHA, depth: 1, agentPath: "workers/scout", agentNickname: "Scout", agentRole: "explorer" } } },
      agentNickname: "Scout",
      agentRole: "explorer"
    })],
    [ORCH, base(ORCH, "Demo Project Orchestrator", { cwd: "/work/demo" })],
    [OLD, base(OLD, "Old archived", { path: `/codex-home/archived_sessions/rollout-${OLD}.jsonl` })]
  ]);
}

let threads = makeThreads();
let started = 0;
let calls = [];
const isArchived = (thread) => String(thread.path).includes("archived_sessions");
const isSubagent = (thread) => Boolean(thread.source?.subAgent);
const strip = (thread, includeTurns) => {
  const { turns, ...rest } = thread;
  return includeTurns ? { ...rest, turns } : rest;
};

const httpServer = http.createServer();
const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id === undefined) return;
    if (msg.method !== "initialize") calls.push({ method: msg.method, params: msg.params ?? null });
    const reply = (payload) => socket.send(JSON.stringify({ id: msg.id, ...payload }));
    const notFound = (threadId) => reply({ error: { code: -32600, message: `thread not found: ${threadId}` } });
    const p = msg.params ?? {};
    switch (msg.method) {
      case "initialize":
        return reply({ result: { userAgent: "fake-golden", codexHome: "/codex-home", platformOs: "macos" } });
      case "thread/list": {
        const wantSub = Array.isArray(p.sourceKinds) && p.sourceKinds.includes("subAgentThreadSpawn");
        const data = [...threads.values()]
          .filter((thread) => isArchived(thread) === (p.archived === true))
          .filter((thread) => isSubagent(thread) === wantSub)
          .slice(0, p.limit ?? 50)
          .map((thread) => strip(thread, false));
        return reply({ result: { data, nextCursor: data.length >= 3 ? "list-next" : null, backwardsCursor: null } });
      }
      case "thread/read": {
        const thread = threads.get(p.threadId);
        if (!thread) return notFound(p.threadId);
        return reply({ result: { thread: strip(thread, p.includeTurns === true) } });
      }
      case "thread/resume": {
        const thread = threads.get(p.threadId);
        if (!thread) return notFound(p.threadId);
        thread.status = { type: "idle" };
        return reply({ result: { thread: strip(thread, false) } });
      }
      case "thread/start": {
        started += 1;
        const threadId = id(0x100 + started);
        const thread = {
          id: threadId,
          name: null,
          preview: "",
          status: { type: "idle" },
          cwd: p.cwd ?? "/work/default",
          model: p.model ?? "gpt-default",
          reasoningEffort: null,
          path: `/codex-home/sessions/2026/05/18/rollout-${threadId}.jsonl`,
          createdAt: FIXED_SECONDS + started,
          updatedAt: FIXED_SECONDS + started,
          source: "appServer",
          turns: []
        };
        threads.set(threadId, thread);
        return reply({ result: { thread: strip(thread, false) } });
      }
      case "thread/name/set": {
        const thread = threads.get(p.threadId);
        if (!thread) return notFound(p.threadId);
        thread.name = p.name;
        return reply({ result: {} });
      }
      case "turn/start": {
        const thread = threads.get(p.threadId);
        if (!thread) return notFound(p.threadId);
        const turnId = `turn-${thread.turns.length + 1}-${p.threadId.slice(-3)}`;
        // The turn completes at once, so waitForReply sees a final answer.
        thread.turns.push({
          id: turnId,
          status: "completed",
          startedAt: FIXED_SECONDS + 100,
          completedAt: FIXED_SECONDS + 101,
          durationMs: 1000,
          items: [
            item("userMessage", `${turnId}-u`, { content: p.input }),
            item("agentMessage", `${turnId}-a`, { text: `ack ${turnId}`, phase: "final_answer" })
          ]
        });
        thread.status = { type: "idle" };
        return reply({ result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      }
      case "turn/steer": {
        const thread = threads.get(p.threadId);
        if (!thread) return notFound(p.threadId);
        const turn = thread.turns.find((candidate) => candidate.id === p.expectedTurnId);
        if (!turn) return reply({ error: { code: -32602, message: "expectedTurnId mismatch" } });
        turn.status = "completed";
        turn.completedAt = FIXED_SECONDS + 200;
        turn.items.push(item("agentMessage", "steer-a", { text: "steered answer", phase: "final_answer" }));
        thread.status = { type: "idle" };
        return reply({ result: { turnId: turn.id } });
      }
      case "thread/loaded/list": {
        if (p.cursor === "loaded-2") return reply({ result: { data: [ORCH], nextCursor: null } });
        return reply({ result: { data: [ALPHA, BETA, SCOUT], nextCursor: "loaded-2" } });
      }
      case "desktop/sidebar/state/read":
        return reply({
          result: {
            authority: "rendererSidebarModel",
            modelVersion: 3,
            generatedAt: "2026-05-18T10:00:00.000Z",
            selectedThreadKey: `local:${ALPHA}`,
            settings: { grouping: "project" },
            sections: [{ key: "recent", title: "Recent" }],
            items: [{ key: `local:${ALPHA}`, localThreadId: ALPHA, sectionKey: "recent" }],
            indexes: { localThreadIds: [ALPHA, ORCH], navigationThreadKeys: [`local:${ALPHA}`], visibleSidebarSectionKeys: ["recent"] }
          }
        });
      case "thread/archive": {
        const thread = threads.get(p.threadId);
        if (!thread) return notFound(p.threadId);
        thread.path = `/codex-home/archived_sessions/rollout-${p.threadId}.jsonl`;
        return reply({ result: {} });
      }
      default:
        return reply({ error: { code: -32601, message: `fake: method not found: ${msg.method}` } });
    }
  });
});
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const port = httpServer.address().port;
const url = `ws://127.0.0.1:${port}`;

// ---------------------------------------------------------------- normalization
const NOW = Date.now();
const NEAR_NOW_MS = 3 * 24 * 60 * 60 * 1000;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z/g;
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const RECEIPT_ID = /agent-link-receipt-[0-9A-Za-z-]+?-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const VOLATILE_NUMBER_KEYS = new Set(["waitedMs", "retryAfterMs", "uptimeMs", "ageMs", "pid", "managedPid"]);

function makeNormalizer() {
  const ulids = new Map();
  const receipts = new Map();
  const token = (map, prefix, value) => {
    if (!map.has(value)) map.set(value, `<${prefix}#${map.size + 1}>`);
    return map.get(value);
  };
  const normalizeString = (value) => value
    .split(tmpReal).join("<TMP>")
    .split(tmp).join("<TMP>")
    .split(String(port)).join("<PORT>")
    .replace(RECEIPT_ID, (match) => token(receipts, "RECEIPT", match))
    .replace(ULID, (match) => token(ulids, "MSG", match))
    .replace(ISO, (match) => Math.abs(Date.parse(match) - NOW) < NEAR_NOW_MS ? "<NOW>" : match);
  const walk = (value, key = "") => {
    if (typeof value === "string") return normalizeString(value);
    if (typeof value === "number") {
      if (VOLATILE_NUMBER_KEYS.has(key)) return "<N>";
      if (Math.abs(value - NOW) < NEAR_NOW_MS) return "<NOW_MS>";
      return value;
    }
    if (Array.isArray(value)) {
      const out = value.map((entry) => walk(entry, key));
      // Receipts written in the same millisecond list in random order (the
      // tie-break is the random part of their id), so receipt lists are
      // compared in recording order.
      const receiptNumber = (entry) => Number(/^<RECEIPT#(\d+)>$/.exec(entry?.id ?? "")?.[1]);
      if (out.length > 1 && out.every((entry) => Number.isFinite(receiptNumber(entry)))) {
        out.sort((a, b) => receiptNumber(a) - receiptNumber(b));
      }
      return out;
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const [childKey, child] of Object.entries(value)) {
        // Process-specific runtime telemetry of the app-server client.
        if (childKey === "notifications" || childKey === "serverRequests") {
          out[childKey] = "<RUNTIME>";
          continue;
        }
        out[normalizeString(childKey)] = walk(child, childKey);
      }
      return out;
    }
    return value;
  };
  return walk;
}

// ---------------------------------------------------------------- script
const callerMeta = {
  "openai/codex": {
    caller: { thread: { id: BETA }, turn: { id: "beta-live" } },
    toolCallId: "call_golden"
  }
};

/** @type {Array<[string, Record<string, unknown>, {meta?: boolean}?]>} */
const SCRIPT = [
  ["agent_link_health", { startAppServer: false }],
  ["agent_link_health", {}],
  ["agent_link_health", { includeCallerContext: true }, { meta: true }],
  ["list_codex_threads", {}],
  ["list_codex_threads", { query: "Alpha" }],
  ["list_codex_threads", { query: "Local Only" }],
  ["list_codex_threads", { archiveScope: "all", includeSubagents: true, limit: 10 }],
  ["list_codex_threads", { archiveScope: "archived" }],
  ["resolve_codex_thread", { query: "Beta" }],
  ["resolve_codex_thread", { query: "worker" }],
  ["resolve_codex_thread", { query: "zzz-nothing-matches" }],
  ["get_codex_thread", { threadId: ALPHA }],
  ["get_codex_thread", { threadId: ALPHA, includeTurns: true, recentItems: 4, includeReceipts: true }],
  ["get_codex_thread", { threadId: LOCAL_ONLY, includeTurns: true }],
  ["get_codex_thread", { threadId: MISSING }],
  ["get_codex_thread", { threadId: MISSING, useLocalFallback: false }],
  ["list_loaded_codex_threads", {}],
  ["list_loaded_codex_threads", { limit: 2 }],
  ["list_loaded_codex_threads", { threadId: ORCH }],
  ["list_loaded_codex_threads", { threadId: MISSING }],
  ["get_codex_sidebar_state", {}],
  ["message_codex_thread", { threadId: ALPHA, message: "hello alpha", waitForReply: true, timeoutMs: 3000, pollIntervalMs: 250, recentItems: 3 }, { meta: true }],
  ["message_codex_thread", { threadId: ALPHA, message: "bad poll", pollIntervalMs: 50 }],
  ["wait_for_codex_thread", { threadId: BETA, timeoutMs: 0 }],
  ["message_codex_thread", { threadId: BETA, message: "parallel", mode: "start_turn" }],
  ["message_codex_thread", { threadId: BETA, message: "steer beta", waitForReply: true, timeoutMs: 3000, pollIntervalMs: 250 }, { meta: true }],
  ["message_codex_thread", { threadId: GAMMA, message: "wake gamma" }],
  ["message_codex_thread", { threadId: ALPHA, message: "elsewhere", cwd: "/somewhere/else" }],
  ["message_codex_thread", { threadId: ALPHA, message: "same dir", cwd: projectDir, model: "gpt-known", effort: "high" }],
  ["message_codex_thread", { threadId: ALPHA, message: "override", cwd: "/somewhere/else", allowTargetOverride: true, receipt: { record: false } }],
  ["message_codex_thread", { threadId: MISSING, message: "nobody home" }],
  ["message_codex_thread", { threadId: ALPHA, message: "   " }],
  ["wait_for_codex_thread", { threadId: ALPHA, timeoutMs: 1000, pollIntervalMs: 250, recentItems: 2 }],
  ["wait_for_codex_thread", { threadId: MISSING, timeoutMs: 1000, pollIntervalMs: 250 }],
  ["launch_codex_thread", {}],
  ["launch_codex_thread", { name: "Launched worker", message: "start the work", cwd: projectDir, model: "gpt-x", effort: "low" }, { meta: true }],
  ["launch_codex_thread", { message: "ephemeral job", ephemeral: true }],
  ["launch_codex_thread", { name: "GUI launch", openInGui: true }],
  ["archive_codex_thread", { threadId: GAMMA, reason: "finished" }, { meta: true }],
  ["archive_codex_thread", { threadId: GAMMA }],
  ["archive_codex_thread", { threadId: LOCAL_ONLY, receipt: { record: false } }],
  ["archive_codex_thread", {}],
  ["list_agent_link_receipts", { limit: 50 }],
  ["list_agent_link_receipts", { action: "archive_thread" }],
  ["resolve_project_orchestrator", { orchestratorThreadId: ORCH }],
  ["resolve_project_orchestrator", { query: "Demo Project Orchestrator" }],
  ["resolve_project_orchestrator", { query: "no such project at all" }],
  ["message_project_orchestrator", { orchestratorThreadId: ORCH, message: "status please" }, { meta: true }],
  ["launch_project_worker", { orchestratorThreadId: ORCH, task: "write the tests", workerRole: "tester", projectId: "demo" }, { meta: true }],
  ["return_project_work_result", { orchestratorThreadId: ORCH, resultStatus: "done", summary: "tests written", changedPaths: ["a.js"], testsRun: ["npm test"] }, { meta: true }],
  ["return_project_work_result", { orchestratorThreadId: ORCH, status: "blocked", summary: "need creds", blockers: ["no access"] }],
  ["register_dependency_handoff", { targetThreadId: ALPHA, dependencyName: "schema v2", readinessContract: "schema merged on main", evidenceRequirements: ["PR link"] }, { meta: true }],
  ["register_dependency_handoff", { targetQuery: "Alpha", dependencyName: "api", readinessContract: "api ready", callbackThreadId: GAMMA }],
  ["check_coordination_obligations", { text: `I'll resume once ${ALPHA} reports the schema is ready.` }, { meta: true }],
  ["check_coordination_obligations", { text: "I'll continue after the dependency is ready.", dependencyName: "schema v2" }, { meta: true }],
  ["check_coordination_obligations", { text: "All done, nothing pending." }],
  ["agent_link_health", { startAppServer: false }],
  // PR B6: the session registry and addresses, on the Codex host.
  ["__claude_fixture", {}],
  ["list_agents", {}, { meta: true }],
  ["list_agents", { harness: "codex", includeArchived: true, limit: 10 }],
  ["list_agents", { harness: "claude" }],
  ["list_agents", { surface: "app", loaded: true }],
  ["resolve_agent", { query: "Alpha" }],
  ["resolve_agent", { query: `codex:${ALPHA}` }],
  ["resolve_agent", { query: ALPHA }],
  ["resolve_agent", { query: CLAUDE_SESSION }],
  ["resolve_agent", { query: `codex:${MISSING}` }],
  ["resolve_agent", { query: "Golden Claude", harness: "claude" }],
  ["list_claude_sessions", {}],
  ["get_claude_session", { sessionId: `claude:${CLAUDE_SESSION}` }],
  ["list_agent_link_receipts", { target: `codex:${GAMMA}` }]
];

function serverEnv(host) {
  return hermeticEnv({
    home: tmp,
    codexHome,
    overrides: {
      AGENT_LINK_HOST: host,
      AGENT_LINK_CODEX_URL: url,
      AGENT_LINK_CODEX_APP_SERVER_BIN: "/nonexistent/golden/codex-app-server",
      AGENT_LINK_MAILBOX_PATH: path.join(tmp, "mailbox.jsonl"),
      AGENT_LINK_RECEIPT_LOG: path.join(tmp, "receipts.jsonl"),
      AGENT_LINK_STATE_DIR: path.join(tmp, "state"),
      AGENT_LINK_GUI_OPEN_DRY_RUN: "1",
      AGENT_LINK_DISABLE_CHANNEL: "1"
    }
  });
}

async function runScript(host, script) {
  const client = new Client({ name: "golden-replay", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: pluginRoot,
    env: serverEnv(host),
    stderr: "ignore"
  }));
  const normalize = makeNormalizer();
  const steps = [];
  try {
    for (const [name, args, options = {}] of script) {
      if (SETUP_STEPS[name]) {
        SETUP_STEPS[name]();
        continue;
      }
      calls = [];
      const result = await client.callTool({ name, arguments: args, ...(options.meta ? { _meta: callerMeta } : {}) });
      const payload = JSON.parse(result.content[0].text);
      assert.deepEqual(result.structuredContent, payload, `${name}: structuredContent matches the text copy`);
      steps.push(normalize({
        call: name,
        args,
        meta: options.meta === true,
        isError: result.isError === true,
        payload,
        appServerRequests: calls
      }));
    }
  } finally {
    await client.close();
  }
  return steps;
}

let recorded;
try {
  threads = makeThreads();
  const codex = await runScript("codex", SCRIPT);
  threads = makeThreads();
  // Each host starts without the Claude fixture, as the pre-B6 recording did.
  rmSync(path.join(tmp, ".claude"), { recursive: true, force: true });
  const claude = await runScript("claude", [
    ["agent_link_health", { startAppServer: false }],
    ["message_codex_thread", { threadId: ALPHA, message: "from claude" }],
    ["launch_codex_thread", { name: "From Claude" }],
    ["__claude_fixture", {}],
    ["list_agents", { limit: 5 }],
    ["resolve_agent", { query: "Golden Claude planner" }]
  ]);
  recorded = { codex, claude };
} finally {
  wss.close();
  httpServer.close();
}

try {
  if (update) {
    mkdirSync(path.dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, `${JSON.stringify(recorded, null, 2)}\n`);
    console.log(`golden replay: recorded ${recorded.codex.length + recorded.claude.length} calls to ${path.relative(pluginRoot, fixturePath)}`);
  } else {
    const golden = JSON.parse(readFileSync(fixturePath, "utf8"));
    for (const host of ["codex", "claude"]) {
      assert.equal(recorded[host].length, golden[host].length, `${host}: step count`);
      recorded[host].forEach((step, index) => {
        assert.deepEqual(step, golden[host][index], `${host} step ${index} (${step.call}) differs from the golden recording`);
      });
    }
    console.log(`golden replay: ${recorded.codex.length + recorded.claude.length} calls match ${path.relative(pluginRoot, fixturePath)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
