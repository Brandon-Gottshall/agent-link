// The orchestrator role (design R1.21): the project-orchestrator binding as
// a role scoped by project root. resolve_project_orchestrator consults the
// role table; the binding file and search keep working. Temp state only.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRoleStore, validateRoleTable } from "../../src/registry/roles.js";
import { makeRoleHandlers } from "../../src/tools/roles.js";
import { messageProjectOrchestrator, resolveProjectOrchestrator } from "../../src/codex/project-orchestrator.js";
import { makeThreadMessaging } from "../../src/codex/thread-messaging.js";
import { openMailbox } from "../../src/claude/mailbox.js";
import { makeThreadQueries } from "../../src/codex/thread-queries.js";
import { AgentLinkError } from "../../src/shared/errors.js";

const ROLE_THREAD = "019d9000-0000-7000-8000-0000000000e1";
const OTHER_THREAD = "019d9000-0000-7000-8000-0000000000e2";
const BINDING_THREAD = "019d9000-0000-7000-8000-0000000000e3";
const SEARCH_THREAD = "019d9000-0000-7000-8000-0000000000e4";
const CLAUDE = "claude:0b5e7c1a-3f2d-4a6e-9c8b-0000000000e5";

function fixture({ binding = true, extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-orchestrator-role-"));
  const env = { HOME: dir, AGENT_LINK_STATE_DIR: path.join(dir, "state"), ...extraEnv };
  const roles = createRoleStore({ env, homedir: dir });
  const projectRoot = path.join(dir, "project");
  fs.mkdirSync(path.join(projectRoot, ".codex"), { recursive: true });
  if (binding) {
    fs.writeFileSync(path.join(projectRoot, ".codex", "project-orchestrator.json"), JSON.stringify({
      projectId: "demo",
      projectRoot,
      orchestratorThreadId: BINDING_THREAD,
      role: "project_orchestrator",
      policyVersion: "v1",
      createdAt: "2026-10-07T12:00:00.000Z",
      lastVerifiedAt: "2026-10-07T12:00:00.000Z"
    }));
  }
  const unreadable = new Set();
  const deps = {
    roles,
    readThread: async (threadId) => {
      if (unreadable.has(threadId)) throw new Error("thread not found");
      return { thread: { id: threadId, name: "Project Orchestrator demo" } };
    },
    listThreads: async () => ({ data: [{ id: SEARCH_THREAD, name: "Project Orchestrator demo", preview: "", cwd: projectRoot }], source: "stub" })
  };
  return { dir, roles, projectRoot, deps, unreadable, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("without an orchestrator role, the binding and search behave as before", async () => {
  const fx = fixture();
  try {
    const bound = await resolveProjectOrchestrator({ projectRoot: fx.projectRoot }, fx.deps);
    assert.equal(bound.source, "binding");
    assert.equal(bound.threadId, BINDING_THREAD);
    fx.unreadable.add(BINDING_THREAD);
    const searched = await resolveProjectOrchestrator({ projectRoot: fx.projectRoot }, fx.deps);
    assert.equal(searched.source, "binding-unreadable-search");
    assert.equal(searched.threadId, SEARCH_THREAD);
  } finally {
    fx.cleanup();
  }
});

test("the orchestrator role assigned for the project wins over the binding; other projects are unaffected", async () => {
  const fx = fixture();
  try {
    fx.roles.set({ role: "orchestrator", address: `codex:${ROLE_THREAD}`, projectRoot: fx.projectRoot });
    const resolved = await resolveProjectOrchestrator({ projectRoot: `${fx.projectRoot}/` }, fx.deps);
    assert.equal(resolved.source, "role");
    assert.equal(resolved.threadId, ROLE_THREAD);
    assert.deepEqual(resolved.role, { name: "orchestrator", via: "role:orchestrator", address: `codex:${ROLE_THREAD}`, scope: "project", projectRoot: fx.projectRoot });
    assert.deepEqual(fx.roles.rolesOf(`codex:${ROLE_THREAD}`), ["orchestrator"], "a per-project holder is a persistent agent");

    const elsewhere = path.join(fx.dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    await assert.rejects(resolveProjectOrchestrator({ projectRoot: elsewhere, query: "nothing matches this" }, { ...fx.deps, listThreads: async () => ({ data: [] }) }),
      (error) => error instanceof AgentLinkError && error.errorCode === "not_found");

    // An unreadable role holder falls back to the binding.
    fx.unreadable.add(ROLE_THREAD);
    assert.equal((await resolveProjectOrchestrator({ projectRoot: fx.projectRoot }, fx.deps)).source, "binding");
  } finally {
    fx.cleanup();
  }
});

test("the role's own holder comes after the binding and before search; Claude holders are skipped", async () => {
  const fx = fixture({ binding: false });
  try {
    fx.roles.set({ role: "orchestrator", address: CLAUDE });
    assert.equal((await resolveProjectOrchestrator({ projectRoot: fx.projectRoot }, fx.deps)).source, "search", "a Claude holder cannot take orchestrator turns");
    fx.roles.set({ role: "orchestrator", address: `codex:${OTHER_THREAD}` });
    const unscoped = await resolveProjectOrchestrator({ projectRoot: fx.projectRoot }, fx.deps);
    assert.equal(unscoped.source, "role");
    assert.equal(unscoped.threadId, OTHER_THREAD);
    assert.equal(unscoped.role.scope, "role");

    // Query-only calls never reach the unscoped holder (fix round a2).
    const queried = await resolveProjectOrchestrator({ query: "Project Orchestrator demo" }, fx.deps);
    assert.equal(queried.source, "search");
    assert.equal(queried.threadId, SEARCH_THREAD);

    const withBinding = fixture();
    try {
      withBinding.roles.set({ role: "orchestrator", address: `codex:${OTHER_THREAD}` });
      assert.equal((await resolveProjectOrchestrator({ projectRoot: withBinding.projectRoot }, withBinding.deps)).source, "binding");
      // A binding whose thread is unreadable keeps binding-unreadable-search;
      // it never falls to the unscoped role holder.
      withBinding.unreadable.add(BINDING_THREAD);
      const fallback = await resolveProjectOrchestrator({ projectRoot: withBinding.projectRoot }, withBinding.deps);
      assert.equal(fallback.source, "binding-unreadable-search");
      assert.equal(fallback.threadId, SEARCH_THREAD);
      // A per-project holder never carries the binding's projectId.
      withBinding.unreadable.clear();
      withBinding.roles.set({ role: "orchestrator", address: `codex:${ROLE_THREAD}`, projectRoot: withBinding.projectRoot });
      const scoped = await resolveProjectOrchestrator({ projectRoot: withBinding.projectRoot }, withBinding.deps);
      assert.deepEqual([scoped.source, scoped.threadId, scoped.projectId, scoped.binding], ["role", ROLE_THREAD, null, null]);
      // path.resolve matching only: a subdirectory is a different project
      // (no binding there), so it gets the unscoped holder, not the parent's.
      const sub = path.join(withBinding.projectRoot, "sub");
      fs.mkdirSync(sub);
      const child = await resolveProjectOrchestrator({ projectRoot: sub }, withBinding.deps);
      assert.deepEqual([child.source, child.threadId, child.role.scope], ["role", OTHER_THREAD, "role"]);
    } finally {
      withBinding.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test("orchestratorThreadId may be role:<name>", async () => {
  const fx = fixture();
  try {
    await assert.rejects(resolveProjectOrchestrator({ orchestratorThreadId: "role:orchestrator", projectRoot: fx.projectRoot }, fx.deps),
      (error) => error instanceof AgentLinkError && error.errorCode === "not_found" && error.details.role === "orchestrator");
    fx.roles.set({ role: "orchestrator", address: `codex:${OTHER_THREAD}` });
    fx.roles.set({ role: "orchestrator", address: `codex:${ROLE_THREAD}`, projectRoot: fx.projectRoot });
    assert.equal((await resolveProjectOrchestrator({ orchestratorThreadId: "role:orchestrator", projectRoot: fx.projectRoot }, fx.deps)).threadId, ROLE_THREAD);
    assert.equal((await resolveProjectOrchestrator({ orchestratorThreadId: "role:orchestrator" }, fx.deps)).threadId, OTHER_THREAD);
  } finally {
    fx.cleanup();
  }
});

test("set_agent_role / clear_agent_role with projectRoot; roles.json projects are validated", async () => {
  const fx = fixture();
  try {
    const registry = { get: async (agent) => ({ address: agent, harness: "codex", title: null }) };
    const handlers = makeRoleHandlers({ roles: fx.roles, registry, admin: true });
    const set = await handlers.set_agent_role({ role: "orchestrator", agent: `codex:${ROLE_THREAD}`, projectRoot: fx.projectRoot });
    assert.equal(set.projectRoot, fx.projectRoot);
    assert.equal(set.role.address, null, "the role's own holder is untouched");
    assert.deepEqual(set.role.projects, { [fx.projectRoot]: `codex:${ROLE_THREAD}` });
    await assert.rejects(handlers.set_agent_role({ role: "orchestrator", agent: `codex:${ROLE_THREAD}`, projectRoot: "relative/path" }),
      (error) => error instanceof AgentLinkError && error.errorCode === "invalid_arguments");
    await assert.rejects(handlers.set_agent_role({ role: "router", agent: `codex:${ROLE_THREAD}`, projectRoot: fx.projectRoot }),
      (error) => error instanceof AgentLinkError && error.errorCode === "invalid_arguments" && error.details.errors[0].rule === "scope");
    const cleared = await handlers.clear_agent_role({ role: "orchestrator", projectRoot: fx.projectRoot });
    assert.equal(cleared.cleared, true);
    assert.equal(cleared.previousAddress, `codex:${ROLE_THREAD}`);
    assert.equal(cleared.role.projects, undefined);

    const { table, problems } = validateRoleTable({ version: 1, roles: { orchestrator: { projects: { "relative": `codex:${ROLE_THREAD}`, "/abs/root/": "not-an-address", "/abs/ok": `codex:${ROLE_THREAD}` } } } });
    assert.deepEqual(table.roles.orchestrator.projects, { "/abs/ok": `codex:${ROLE_THREAD}` });
    assert.equal(problems.filter((p) => p.path === "roles.orchestrator.projects").length, 2);
    const other = validateRoleTable({ version: 1, roles: { router: { address: `codex:${ROLE_THREAD}`, projects: { "/abs/ok": `codex:${OTHER_THREAD}` } } } });
    assert.equal(other.table.roles.router.projects, undefined, "only the orchestrator role is scoped by project");
    assert.deepEqual(other.problems.map((p) => p.rule), ["scope"]);
  } finally {
    fx.cleanup();
  }
});

// Fix round a2, finding 3: under enforce, a send to the per-project
// orchestrator through the orchestrator tools is role-addressed; a direct
// send is refused with a hint that names the tool and the project.
test("enforce: message_project_orchestrator reaches a per-project role holder; a direct send gets a usable hint", async () => {
  const fx = fixture({ extraEnv: { AGENT_LINK_ROLE_ENFORCEMENT: "enforce" } });
  const saved = process.env.AGENT_LINK_RECEIPT_LOG;
  process.env.AGENT_LINK_RECEIPT_LOG = path.join(fx.dir, "receipts.jsonl");
  try {
    const ROUTER = "019d9000-0000-7000-8000-0000000000e9";
    fx.roles.set({ role: "router", address: `codex:${ROUTER}` });
    fx.roles.set({ role: "orchestrator", address: `codex:${ROLE_THREAD}`, projectRoot: fx.projectRoot });
    const requests = [];
    const appServer = {
      async request(method, params) {
        requests.push([method, params.threadId]);
        if (method === "thread/read") return { thread: { id: params.threadId, name: "T", status: { type: "idle" }, cwd: fx.projectRoot, model: "m" } };
        if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress", items: [] } };
        throw new Error(`unexpected ${method}`);
      },
      getConnectionSummary: () => ({ connected: true, managed: false })
    };
    // Mailbox first (B7b): the fixture's temp mailbox, never the default one.
    const messaging = makeThreadMessaging({ appServer, host: "codex", resolveCurrentSession: () => null, queries: makeThreadQueries({ appServer }), roles: fx.roles, mailboxOpener: () => openMailbox({ mailboxPath: path.join(fx.dir, "mailbox.jsonl") }) });
    const toolContext = { callerContext: { available: true, threadId: ROUTER, turnId: "t", source: "runtime_context" } };

    await assert.rejects(messaging.messageThread({ threadId: ROLE_THREAD, message: "direct", receipt: { record: false } }, toolContext), (error) => {
      assert.equal(error.errorCode, "permission_denied");
      assert.equal(error.details.reason, "role_address_required");
      assert.equal(error.details.replacement, "message_project_orchestrator");
      assert.deepEqual(error.details.projectRoots, [fx.projectRoot]);
      assert.match(error.hint, /message_project_orchestrator with projectRoot=/);
      return true;
    });
    assert.equal(requests.filter(([method]) => method === "turn/start").length, 0, "nothing sent under enforce");

    const sent = await messageProjectOrchestrator({ projectRoot: fx.projectRoot, message: "status?", receipt: { record: false } },
      { ...fx.deps, messageThread: messaging.messageThread }, toolContext);
    assert.equal(sent.resolution.source, "role");
    assert.deepEqual(requests.filter(([method]) => method === "turn/start"), [["turn/start", ROLE_THREAD]]);
  } finally {
    if (saved === undefined) delete process.env.AGENT_LINK_RECEIPT_LOG;
    else process.env.AGENT_LINK_RECEIPT_LOG = saved;
    fx.cleanup();
  }
});
