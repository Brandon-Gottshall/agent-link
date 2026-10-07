// Session registry (design doc section 1.4) and the host-neutral tools
// list_agents / resolve_agent (section 1.6), in process: the Claude provider
// reads fixture sidecars and a temp transcript dir, the Codex provider runs
// the real thread queries against a fake app-server. Covers listing from
// both providers, provider failure as warnings (R1.8), exact lookup and
// bare-id ambiguity (R1.3), resolve ranking, and the B4 envelope contract.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findClaudeSessionById, isClaudeSessionLoaded, listClaudeSessions } from "../../src/claude/session-index.js";
import { AppServerError } from "../../src/codex/app-server-client.js";
import { makeThreadQueries } from "../../src/codex/thread-queries.js";
import { makeClaudeProvider } from "../../src/registry/claude.js";
import { codexSurfaces, makeCodexProvider } from "../../src/registry/codex.js";
import { createSessionRegistry, scoreAgent } from "../../src/registry/index.js";
import { createRegistry, normalizeThreadIdArguments } from "../../src/server/registry.js";
import { agentEntries } from "../../src/tools/agents.js";
import { makeReadInboxHandler } from "../../src/tools/read-inbox.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sidecarRoot = path.join(root, "tests", "fixtures", "claude-sidecars");
const ARCHIVED_SIDECAR_CLI = "36a85a98-8e81-409b-8c1c-07cdaf004d57";

const SECONDS = 1779086400;
const T1 = "019d3000-0000-7000-8000-000000000001";
const T2 = "019d3000-0000-7000-8000-000000000002";
const T_OLD = "019d3000-0000-7000-8000-000000000006";
const CLAUDE_LIVE = "5a7e4c21-9b3d-4f60-8e12-3c4d5e6f7a8b";
const TWIN = T1; // a Claude transcript that reuses a Codex thread id

const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-link-registry-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const projectsRoot = path.join(tmp, "projects");
mkdirSync(path.join(projectsRoot, "-work-planner"), { recursive: true });
for (const [id, title, at] of [[CLAUDE_LIVE, "Release planner", SECONDS + 500], [TWIN, "Twin session", SECONDS - 500]]) {
  const file = path.join(projectsRoot, "-work-planner", `${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "summary", title, cwd: "/work/planner" })}\n`);
  utimesSync(file, at, at);
}
const psOutput = `/usr/local/bin/claude --resume ${CLAUDE_LIVE}\n`;

const listCalls = { count: 0 };
function claudeProvider({ fail = false, roots: searched = () => [projectsRoot] } = {}) {
  const roots = { desktopRoot: sidecarRoot, codeRoot: path.join(tmp, "no-code-root"), projectsRoot };
  return makeClaudeProvider({
    list: (options) => {
      listCalls.count += 1;
      if (fail) throw new Error("index unreadable");
      return listClaudeSessions({ ...options, ...roots, psOutput });
    },
    find: (id) => findClaudeSessionById(id, roots),
    isLoaded: (cli) => isClaudeSessionLoaded(cli, { psOutput }),
    roots: searched
  });
}

const thread = (id, name, extra = {}) => ({
  id,
  name,
  preview: `${name} preview`,
  status: { type: "idle" },
  cwd: "/work/codex",
  path: `/codex-home/sessions/2026/05/18/rollout-${id}.jsonl`,
  createdAt: SECONDS,
  updatedAt: SECONDS,
  source: "vscode",
  ...extra
});
const THREADS = [
  thread(T1, "Release worker", { updatedAt: SECONDS + 100 }),
  thread(T2, "Docs writer", { status: { type: "notLoaded" }, source: "cli", updatedAt: SECONDS + 1000 }),
  thread(T_OLD, "Old release notes", { path: `/codex-home/archived_sessions/rollout-${T_OLD}.jsonl`, updatedAt: SECONDS + 2000 })
];

function fakeAppServer({ down = false } = {}) {
  const calls = [];
  return {
    calls,
    getConnectionSummary: () => ({ fake: true }),
    async request(method, params) {
      calls.push(method);
      if (down) throw new AppServerError("no app-server", { code: "autostart-disabled" });
      if (method === "thread/list") {
        const archived = params.archived === true;
        return { data: THREADS.filter((t) => t.path.includes("archived_sessions") === archived).slice(0, params.limit), nextCursor: null };
      }
      if (method === "thread/read") {
        const found = THREADS.find((t) => t.id === params.threadId);
        if (!found) throw new AppServerError(`thread not found: ${params.threadId}`, { code: -32600 });
        return { thread: found };
      }
      throw new Error(`unexpected ${method}`);
    }
  };
}

function codexProvider(appServer, { failList = false, installed = true } = {}) {
  const queries = makeThreadQueries({ appServer });
  return makeCodexProvider({
    appServer,
    listThreads: failList ? async () => { throw new Error("transcripts unreadable"); } : queries.listThreads,
    installState: () => (installed ? { installed: true, reason: null } : { installed: false, reason: "Codex is not installed (test)." })
  });
}

function registry({ down = false, claudeFails = false, codexFails = false, codexInstalled = true, claudeRoots } = {}) {
  const appServer = fakeAppServer({ down });
  return createSessionRegistry({
    claude: claudeProvider({ fail: claudeFails, ...(claudeRoots ? { roots: claudeRoots } : {}) }),
    codex: codexProvider(appServer, { failList: codexFails, installed: codexInstalled })
  });
}

test("list: both providers, merged newest first, one session shape", async () => {
  const { sessions, providers, warnings } = await registry().list({});
  assert.deepEqual(sessions.map((s) => s.address), [
    `codex:${T2}`,
    `claude:${CLAUDE_LIVE}`,
    `codex:${T1}`,
    `claude:${TWIN}`
  ], "archived sessions are left out by default");
  assert.deepEqual(warnings, []);
  assert.equal(providers.claude.available, true);
  assert.equal(providers.codex.source, "app-server");
  for (const session of sessions) {
    assert.deepEqual(Object.keys(session).slice(0, 10), ["address", "harness", "id", "title", "cwd", "surface", "loaded", "archived", "lastActivityAt", "receive"]);
    assert.equal(session.address, `${session.harness}:${session.id}`);
    assert.ok(Array.isArray(session.surface));
    assert.match(session.lastActivityAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  const claude = sessions.find((s) => s.id === CLAUDE_LIVE);
  assert.deepEqual(
    { title: claude.title, cwd: claude.cwd, surface: claude.surface, loaded: claude.loaded, receive: claude.receive, cliSessionId: claude.cliSessionId, sessionId: claude.sessionId },
    { title: "Release planner", cwd: "/work/planner", surface: ["code"], loaded: true, receive: { push: "channel", nudge: "claude-hook", pull: true }, cliSessionId: CLAUDE_LIVE, sessionId: `local_${CLAUDE_LIVE}` }
  );
  const codex = sessions.find((s) => s.id === T2);
  assert.deepEqual(
    { title: codex.title, surface: codex.surface, loaded: codex.loaded, archived: codex.archived, threadId: codex.threadId, status: codex.status, receive: codex.receive },
    { title: "Docs writer", surface: ["cli"], loaded: false, archived: false, threadId: T2, status: "notLoaded", receive: { push: "codex-turn", nudge: "codex-hook", pull: true } }
  );
});

test("list: filters and limits", async () => {
  const reg = registry();
  const all = await reg.list({ includeArchived: true, limit: 200 });
  assert.ok(all.sessions.some((s) => s.address === `claude:${ARCHIVED_SIDECAR_CLI}` && s.archived && s.surface[0] === "desktop"), "archived sidecar, addressed by its cliSessionId");
  assert.ok(all.sessions.some((s) => s.address === `codex:${T_OLD}` && s.archived));
  assert.deepEqual((await reg.list({ harness: "claude" })).sessions.map((s) => s.harness), ["claude", "claude"]);
  assert.deepEqual(Object.keys((await reg.list({ harness: "codex" })).providers), ["codex"]);
  assert.deepEqual((await reg.list({ surface: "app" })).sessions.map((s) => s.address), [`codex:${T1}`]);
  assert.deepEqual((await reg.list({ loaded: true })).sessions.map((s) => s.address), [`claude:${CLAUDE_LIVE}`, `codex:${T1}`]);
  assert.equal((await reg.list({ limit: 1 })).sessions.length, 1);
});

test("list: an unavailable provider adds a warning and never fails the call (R1.8)", async () => {
  const fallback = await registry({ down: true }).list({});
  assert.equal(fallback.providers.codex.source, "local-jsonl-fallback");
  assert.ok(fallback.warnings.some((w) => w.code === "codex_unavailable"));
  assert.ok(fallback.sessions.every((s) => s.harness === "claude"), "the empty temp CODEX_HOME has no transcripts");

  // M5: no app-server, no transcripts, and no Codex install.
  const noCodex = await registry({ down: true, codexInstalled: false }).list({});
  assert.equal(noCodex.providers.codex.available, false);
  assert.equal(noCodex.providers.codex.reason, "Codex is not installed (test).");
  assert.ok(noCodex.warnings.some((w) => w.code === "codex_unavailable" && /not installed/.test(w.message)));

  // I2: no Claude config dir or session store.
  const noClaude = await registry({ claudeRoots: () => [path.join(tmp, "no-such-claude-dir")] }).list({});
  assert.equal(noClaude.providers.claude.available, false);
  assert.match(noClaude.providers.claude.reason, /No Claude config directory/);
  assert.deepEqual(noClaude.warnings.map((w) => w.code), ["claude_unavailable"]);
  assert.ok(noClaude.sessions.every((s) => s.harness === "codex"));

  const broken = await registry({ claudeFails: true, codexFails: true }).list({});
  assert.deepEqual(broken.sessions, []);
  assert.equal(broken.providers.claude.available, false);
  assert.equal(broken.providers.codex.available, false);
  assert.deepEqual(broken.warnings.map((w) => w.code).sort(), ["claude_unavailable", "codex_unavailable"]);
});

test("get: addresses, bare ids, ambiguity, not_found, invalid", async () => {
  const reg = registry();
  assert.equal((await reg.get(`codex:${T1}`)).title, "Release worker");
  assert.equal((await reg.get(`claude:${TWIN}`)).title, "Twin session");
  assert.equal((await reg.get(CLAUDE_LIVE)).address, `claude:${CLAUDE_LIVE}`);
  assert.equal((await reg.get("local_4acb50b2-5a15-49d1-a68e-afa1c409030d")).address, `claude:${ARCHIVED_SIDECAR_CLI}`, "sidecar id resolves to the CLI address");
  assert.equal((await reg.get(T2)).address, `codex:${T2}`);
  await assert.rejects(reg.get(T1), (error) => error.errorCode === "ambiguous" && error.details.candidates.length === 2);
  await assert.rejects(reg.get("codex:019d3000-0000-7000-8000-00000000ffff"), (error) => error.errorCode === "not_found");
  await assert.rejects(reg.get("no such thing"), (error) => error.errorCode === "invalid_arguments");
  // Codex unreachable: get falls back to local transcripts, which do not know T1.
  assert.equal((await registry({ down: true }).get(`claude:${TWIN}`)).harness, "claude");

  // I3: the fixture sidecar rotated its CLI id; the prior id's address
  // resolves to the session's current address.
  const rotated = await reg.get("claude:11111111-2222-4333-8444-555555555555");
  assert.equal(rotated.address, "claude:7f3c2b1a-0e9d-4c8b-a7f6-5e4d3c2b1a09");
  assert.equal((await reg.resolve({ query: "claude:11111111-2222-4333-8444-555555555555" })).best.address, rotated.address);

  // M2: exact lookups use the session index, never a full listing, and a
  // transcript-only hit still carries its title and cwd.
  listCalls.count = 0;
  const twin = await reg.get(`claude:${TWIN}`);
  assert.deepEqual([twin.title, twin.cwd], ["Twin session", "/work/planner"]);
  await reg.get(`claude:${ARCHIVED_SIDECAR_CLI}`);
  await reg.get(T2);
  assert.equal(listCalls.count, 0);
});

test("resolve: exact ids first, then one host-neutral ranking", async () => {
  const reg = registry();
  const exact = await reg.resolve({ query: `codex:${T2}` });
  assert.equal(exact.status, "resolved");
  assert.deepEqual(exact.best.matchReasons, ["id-exact"]);

  const twin = await reg.resolve({ query: T1 });
  assert.equal(twin.status, "ambiguous", "a bare id in both registries (R1.3)");
  assert.deepEqual(twin.candidates.map((c) => c.harness).sort(), ["claude", "codex"]);
  assert.equal((await reg.resolve({ query: T1, harness: "codex" })).status, "resolved");

  const missing = await reg.resolve({ query: "claude:00000000-0000-4000-8000-000000000000" });
  assert.equal(missing.status, "not_found");

  // One scale across hosts: "Release planner" (Claude) and "Release worker"
  // (Codex) tie on title prefix (300), the newer first; "Old release notes"
  // (Codex, archived) has title contains (200).
  const release = await reg.resolve({ query: "release" });
  assert.equal(release.status, "ambiguous");
  assert.deepEqual(release.candidates.map((c) => [c.address, c.score]), [[`claude:${CLAUDE_LIVE}`, 300], [`codex:${T1}`, 300], [`codex:${T_OLD}`, 200]]);
  assert.equal(release.candidates[2].archived, true, "archived candidates are included and marked");
  assert.ok(release.candidates.every((c) => !("preview" in c)), "S2: no raw preview text in registry results");

  // Equal scores break by most recent activity.
  const planner = await reg.resolve({ query: "/work/planner" });
  assert.deepEqual(planner.candidates.map((c) => c.address).slice(0, 2), [`claude:${CLAUDE_LIVE}`, `claude:${TWIN}`]);
  assert.equal(planner.status, "ambiguous", "both Claude sessions share the cwd");

  const exactTitle = await reg.resolve({ query: "Release worker" });
  assert.equal(exactTitle.best.address, `codex:${T1}`);
  assert.deepEqual(exactTitle.best.matchReasons.slice(0, 1), ["title-exact"]);

  assert.equal((await reg.resolve({ query: "zzz nothing" })).status, "not_found");
  assert.equal((await reg.resolve({ query: "release", harness: "codex", limit: 1 })).candidates.length, 1);

  const tie = await registry().resolve({ query: "/work/planner" });
  assert.equal(tie.status, "ambiguous", "two Claude sessions share the cwd");
  assert.equal(tie.selection.tiedCount, 2);
});

test("scoreAgent scale", () => {
  const session = { address: "codex:abc-123", id: "abc-123", title: "Release worker", cwd: "/work/release", preview: "about a release" };
  assert.equal(scoreAgent(session, "codex:abc-123").score, 1000);
  assert.deepEqual(scoreAgent(session, "abc-").reasons, ["id-prefix"]);
  assert.ok(scoreAgent(session, "release worker").score > scoreAgent(session, "worker").score);
  assert.deepEqual(scoreAgent(session, "release").reasons, ["title-prefix", "cwd-basename"]);
  assert.equal(scoreAgent(session, "").score, 0);
});

test("codexSurfaces maps app-server sources", () => {
  assert.deepEqual(codexSurfaces("vscode"), ["app"]);
  assert.deepEqual(codexSurfaces("cli"), ["cli"]);
  assert.deepEqual(codexSurfaces("exec"), ["cli"]);
  assert.deepEqual(codexSurfaces("appServer"), []);
  assert.deepEqual(codexSurfaces({ subAgent: {} }), []);
});

test("list_agents and resolve_agent follow the B4 contract on both hosts", async () => {
  for (const host of ["claude", "codex"]) {
    const tools = createRegistry(agentEntries({
      registry: registry({ down: true }),
      host,
      resolveCurrentSession: () => (host === "claude" ? { sessionId: `local_${CLAUDE_LIVE}`, cliSessionId: CLAUDE_LIVE } : null)
    }), { strictOutput: true });
    const listed = await tools.callTool("list_agents", {}, { callerContext: { threadId: T1 } });
    assert.equal(listed.isError, false);
    const payload = listed.structuredContent;
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.caller, host === "claude"
      ? { host, address: `claude:${CLAUDE_LIVE}`, source: "current_session" }
      : { host, address: `codex:${T1}`, source: "runtime_context" });
    assert.ok(payload.warnings.some((w) => w.code === "codex_unavailable"), "provider warnings reach the envelope");
    assert.deepEqual(JSON.parse(listed.content[0].text), payload);

    const resolved = await tools.callTool("resolve_agent", { query: "planner" });
    assert.equal(resolved.structuredContent.status, "resolved");
    assert.equal(resolved.structuredContent.best.address, `claude:${CLAUDE_LIVE}`);

    for (const [name, args] of [["list_agents", { limit: 0 }], ["list_agents", { harness: "gemini" }], ["list_agents", { surface: "web" }], ["resolve_agent", {}], ["resolve_agent", { query: "x", bogus: 1 }], ["resolve_agent", { query: "x", limit: 51 }]]) {
      const bad = await tools.callTool(name, args);
      assert.equal(bad.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.equal(bad.structuredContent.error.code, "invalid_arguments");
    }
    const blank = await tools.callTool("resolve_agent", { query: "   " });
    assert.equal(blank.structuredContent.error.code, "invalid_arguments");
  }
});

test("I1: Codex thread id arguments accept codex:<id> and reject claude: addresses", () => {
  const definition = { name: "message_codex_thread" };
  assert.deepEqual(
    normalizeThreadIdArguments(definition, { threadId: `codex:${T1}`, orchestratorThreadId: `codex:${T2}`, receipt: { originThreadId: `codex:${T2}`, note: "codex:x" }, message: "claude:not-an-id-arg" }),
    { threadId: T1, orchestratorThreadId: T2, receipt: { originThreadId: T2, note: "codex:x" }, message: "claude:not-an-id-arg" }
  );
  assert.deepEqual(normalizeThreadIdArguments(definition, { threadId: T1 }), { threadId: T1 }, "bare ids pass through");
  assert.throws(() => normalizeThreadIdArguments(definition, { threadId: `claude:${CLAUDE_LIVE}`, callbackThreadId: `claude:${TWIN}` }), (error) => {
    assert.equal(error.errorCode, "invalid_arguments");
    assert.deepEqual(error.details.errors.map((e) => [e.path, e.rule]), [["threadId", "harness"], ["callbackThreadId", "harness"]]);
    assert.match(error.hint, /message_claude_session/);
    return true;
  });
});

test("M4: read_agent_link_inbox on the Codex host names the Codex host and a Codex hint", async () => {
  const handler = makeReadInboxHandler({ resolveCurrentSession: () => null, host: "codex" });
  await assert.rejects(handler.read_agent_link_inbox({}), (error) => {
    assert.equal(error.errorCode, "no_current_session");
    assert.equal(error.details.host, "codex");
    // B7b (R1.13): Codex threads have an inbox; the hint says how a thread is identified.
    assert.deepEqual(error.details.sources, ["caller _meta threadId", "CODEX_THREAD_ID"]);
    assert.match(error.hint, /_meta/);
    assert.match(error.hint, /CODEX_THREAD_ID/);
    return true;
  });
  const claude = makeReadInboxHandler({ resolveCurrentSession: () => null });
  await assert.rejects(claude.read_agent_link_inbox({}), (error) => error.details.host === "claude");
});
