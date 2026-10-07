// Codex tools end to end over MCP stdio against an in-process fake
// app-server: existing-thread overrides are refused unless allowed,
// recentItems counts items (one result key on every path), the local
// fallback keeps its source label, and health on a machine without Codex.
// Never launches Codex; HOME, CODEX_HOME and the mailbox live in a temp dir.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";
import { pluginRoot } from "../helpers/codex-stub.js";
import { hermeticEnv } from "../helpers/env.js";
import { envelopeBody } from "../helpers/envelope-body.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-link-tools-"));
const codexHome = path.join(tmp, "codex");
const threadId = "019d2000-0000-7000-8000-000000000001";
const localOnlyId = "019d2000-0000-7000-8000-000000000002";
const secondLoadedId = "019d2000-0000-7000-8000-000000000003";

// One local transcript for the fallback paths.
const day = path.join(codexHome, "sessions", "2026", "09", "01");
mkdirSync(day, { recursive: true });
writeFileSync(path.join(day, `rollout-2026-09-01T10-00-00-${localOnlyId}.jsonl`), [
  { timestamp: "2026-09-01T10:00:00.000Z", type: "session_meta", payload: { id: localOnlyId, timestamp: "2026-09-01T10:00:00.000Z", cwd: "/tmp/project" } },
  { timestamp: "2026-09-01T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Fallback Search Target" } },
  { timestamp: "2026-09-01T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "one" } },
  { timestamp: "2026-09-01T10:00:03.000Z", type: "event_msg", payload: { type: "agent_message", message: "two" } },
  { timestamp: "2026-09-01T10:00:04.000Z", type: "event_msg", payload: { type: "task_complete" } }
].map((record) => JSON.stringify(record)).join("\n") + "\n");

const item = (type, id, extra = {}) => ({ type, id, ...extra });
const turns = [
  { id: "turn-1", status: "completed", items: [item("userMessage", "i1", { content: [{ type: "text", text: "first" }] }), item("reasoning", "i2", { summary: [] }), item("agentMessage", "i3", { text: "first answer" })] },
  { id: "turn-2", status: "completed", items: [item("userMessage", "i4", { content: [{ type: "text", text: "second" }] }), item("agentMessage", "i5", { text: "second answer", phase: "final_answer" })] }
];
// Shaped like a real app-server thread: model is reported, reasoningEffort is
// null when the thread never set one. cwd is the real path of a directory the
// test also reaches through a non-canonical path (macOS /var -> /private/var).
const projectDir = path.join(tmp, "project");
mkdirSync(projectDir, { recursive: true });
const baseThread = { id: threadId, name: "Fake", preview: "Fake", status: { type: "idle" }, cwd: realpathSync(projectDir), model: "gpt-known", reasoningEffort: null, path: path.join(day, "fake.jsonl"), createdAt: 1779086300, updatedAt: 1779086400 };

const received = [];
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
        if (msg.params.threadId !== threadId) {
          return reply({ error: { code: -32600, message: `thread not found: ${msg.params.threadId}` } });
        }
        return reply({ result: { thread: { ...baseThread, ...(msg.params.includeTurns ? { turns } : {}) } } });
      case "turn/start":
        return reply({ result: { turn: { id: "turn-2", status: "inProgress", items: [] } } });
      case "thread/loaded/list":
        // Two pages, so cursor paging and the threadId lookup are exercised.
        return msg.params.cursor === "page-2"
          ? reply({ result: { data: [secondLoadedId], nextCursor: null } })
          : reply({ result: { data: [threadId], nextCursor: "page-2" } });
      case "turn/steer":
        return reply({ result: { turnId: "turn-2" } });
      case "thread/list":
        return reply({ error: { code: -32603, message: "fake: thread/list unavailable" } });
      default:
        return reply({ error: { code: -32601, message: `fake: ${msg.method}` } });
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `ws://127.0.0.1:${server.address().port}`;

function serverEnv(extra) {
  return hermeticEnv({
    home: tmp,
    codexHome,
    overrides: {
      AGENT_LINK_MAILBOX_PATH: path.join(tmp, "mailbox.jsonl"),
      CODEX_AGENT_LINK_RECEIPT_LOG: path.join(tmp, "receipts.jsonl"),
      CODEX_AGENT_LINK_STATE_DIR: path.join(tmp, "st"),
      AGENT_LINK_DISABLE_CHANNEL: "1",
      ...extra
    }
  });
}

async function connect(extraEnv) {
  const client = new Client({ name: "server-tools-test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "src", "server.js")],
    cwd: pluginRoot,
    env: serverEnv(extraEnv),
    stderr: "ignore"
  }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const payload = JSON.parse(result.content[0].text);
    // R3.2: the same envelope in text and structuredContent (no key dropped
    // by the closed outputSchema), and isError exactly when ok is false.
    assert.deepEqual(result.structuredContent, payload, `${name}: structuredContent matches the text copy`);
    assert.equal(result.isError, payload.ok === false, `${name}: isError iff !ok`);
    return { isError: result.isError, payload };
  };
  return { client, call };
}

try {
  const { client, call } = await connect({ CODEX_AGENT_LINK_URL: url });
  try {
    // W2A-03: a value that differs from one the thread reports is refused
    // before anything runs.
    const startParams = () => received.find((msg) => msg.method === "turn/start")?.params;
    received.length = 0;
    let result = await call("message_codex_thread", { threadId, message: "hi", cwd: "/tmp/elsewhere" });
    assert.equal(result.isError, true);
    assert.equal(result.payload.error.code, "permission_denied");
    // B9 (R9.5): a cwd outside the thread's workspace is refused whatever the policy says.
    assert.equal(result.payload.error.details.reason, "cwd_outside_workspace");
    assert.deepEqual(result.payload.error.details.conflicts, [{ field: "cwd", requested: "/tmp/elsewhere", threadValue: baseThread.cwd }]);
    assert.ok(!received.some((msg) => ["turn/start", "thread/resume", "turn/steer"].includes(msg.method)), "nothing was started");

    result = await call("message_codex_thread", { threadId, message: "hi", model: "other-model" });
    assert.equal(result.isError, true, "a model different from the reported one is refused");
    assert.equal(result.payload.error.details.reason, "model_switch_requires_fork_or_opt_in");
    assert.deepEqual(result.payload.error.details.conflicts, [{ field: "model", requested: "other-model", threadValue: "gpt-known" }]);

    // Same values pass, cwd compared by real path; an effort the thread does
    // not report (null) is not forwarded and is flagged, not refused.
    received.length = 0;
    result = await call("message_codex_thread", { threadId, message: "hi", cwd: projectDir, model: "gpt-known", effort: "high" });
    assert.equal(result.isError, false, JSON.stringify(result.payload));
    assert.equal(startParams().cwd, projectDir);
    assert.equal(startParams().model, "gpt-known");
    assert.equal(Object.hasOwn(startParams(), "effort"), false, "unverified effort is not forwarded");
    assert.deepEqual(
      result.payload.warnings.filter((warning) => warning.code === "target-override-unverified").map((warning) => [warning.field, warning.requested]),
      [["effort", "high"]]
    );

    // Steering ignores these fields, so a mismatch is a warning there.
    received.length = 0;
    result = await call("message_codex_thread", { threadId, message: "hi", mode: "steer_active", expectedTurnId: "turn-2", cwd: "/tmp/elsewhere" });
    assert.equal(result.isError, false, JSON.stringify(result.payload));
    assert.ok(received.some((msg) => msg.method === "turn/steer"));
    assert.equal(result.payload.warnings.find((warning) => warning.code === "target-override-ignored-steer").field, "cwd");

    // allowTargetOverride (deprecated, R9.13) still forwards everything in
    // 0.6.0, with a warning; the change persists and is receipted.
    received.length = 0;
    result = await call("message_codex_thread", { threadId, message: "hi", cwd: path.join(projectDir, "sub"), model: "other-model", effort: "high", allowTargetOverride: true });
    assert.equal(result.isError, false, JSON.stringify(result.payload));
    assert.equal(startParams().cwd, path.join(projectDir, "sub"));
    assert.equal(startParams().model, "other-model");
    assert.equal(startParams().effort, "high");
    assert.deepEqual(result.payload.switches.map((change) => [change.setting, change.grantedBy]), [["cwd", "allowTargetOverride"], ["model", "allowTargetOverride"], ["effort", "allowTargetOverride"]]);
    assert.equal(result.payload.switchReceipts.length, 3);
    assert.match(result.payload.warnings.find((warning) => warning.code === "deprecated_argument").message, /0\.7\.0/);
    // ...but never outside the thread's workspace, and never a relative cwd.
    received.length = 0;
    result = await call("message_codex_thread", { threadId, message: "hi", cwd: "/tmp/elsewhere", allowTargetOverride: true });
    assert.equal(result.payload.error.details.reason, "cwd_outside_workspace");
    result = await call("message_codex_thread", { threadId, message: "hi", cwd: "sub", allowTargetOverride: true });
    assert.equal(result.payload.error.code, "invalid_arguments");
    assert.ok(!received.some((msg) => msg.method === "turn/start"), "nothing was started");

    // P2-04: message + waitForReply returns up to N recent items.
    result = await call("message_codex_thread", { threadId, message: "hi", waitForReply: true, timeoutMs: 2000, pollIntervalMs: 250, recentItems: 2 });
    assert.equal(result.isError, false);
    assert.equal("replyConfirmation" in result.payload, false, "the 0.4 replyConfirmation key was removed in 0.6.0");
    assert.match(result.payload.wait.recentItemsEnvelope, /\[agentMessage i5\] second answer/);
    assert.deepEqual(result.payload.wait.recentItems.map((entry) => [entry.turnId, entry.id]), [["turn-2", "i4"], ["turn-2", "i5"]]);
    // Section 3.4: the wait, plus the top-level message fields.
    assert.equal(result.payload.wait.outcome, "turn_completed");
    assert.equal(result.payload.wait.turn.status, "completed");
    assert.equal(envelopeBody(result.payload.wait.turn.finalResponse), "second answer");
    assert.equal(result.payload.deliveredVia, "turn/start");
    assert.equal(result.payload.messageId, result.payload.peerMessage.messageId);
    assert.deepEqual(result.payload.target, { threadId, address: `codex:${threadId}` });

    // W2B-06: get/wait slice items, not turns, under one key.
    result = await call("get_codex_thread", { threadId, includeTurns: true, recentItems: 3 });
    assert.equal(result.payload.source, "app-server");
    assert.deepEqual(result.payload.thread.recentItems.map((entry) => entry.id), ["i3", "i4", "i5"]);
    assert.deepEqual(result.payload.thread.turns.map((turn) => [turn.id, turn.items.length, turn.itemsOmitted ?? 0]), [["turn-1", 1, 2], ["turn-2", 2, 0]]);

    result = await call("wait_for_codex_thread", { threadId, timeoutMs: 1000, pollIntervalMs: 250, recentItems: 1 });
    assert.deepEqual(result.payload.thread.recentItems.map((entry) => entry.id), ["i5"]);
    assert.equal(result.payload.outcome, "turn_completed");
    assert.deepEqual(result.payload.target, { threadId, address: `codex:${threadId}` });
    assert.equal(result.payload.turn.turnId, "turn-2");
    assert.equal(result.payload.turn.finalResponse, "second answer");
    assert.ok(Number.isInteger(result.payload.waitedMs));

    // I1: the address the session registry returns works wherever a Codex
    // thread id is taken; a claude: address there is invalid_arguments.
    result = await call("resolve_agent", { query: threadId, harness: "codex" });
    assert.equal(result.payload.status, "resolved");
    const address = result.payload.best.address;
    assert.equal(address, `codex:${threadId}`);
    result = await call("message_codex_thread", { threadId: address, message: "by address" });
    assert.equal(result.isError, false, JSON.stringify(result.payload));
    assert.deepEqual(result.payload.target, { threadId, address });
    result = await call("get_codex_thread", { threadId: address });
    assert.equal(result.payload.thread.id, threadId);
    result = await call("wait_for_codex_thread", { threadId: address, timeoutMs: 1000, pollIntervalMs: 250 });
    assert.deepEqual(result.payload.target, { threadId, address });
    result = await call("list_loaded_codex_threads", { threadId: address });
    assert.equal(result.payload.lookup.loaded, true);
    result = await call("message_codex_thread", { threadId: "claude:5a7e4c21-9b3d-4f60-8e12-3c4d5e6f7a8b", message: "wrong harness" });
    assert.equal(result.payload.error.code, "invalid_arguments");
    assert.equal(result.payload.error.details.errors[0].path, "threadId");

    // Out-of-range numbers are rejected, not clamped (R3.12).
    result = await call("wait_for_codex_thread", { threadId, pollIntervalMs: 10 });
    assert.equal(result.payload.error.code, "invalid_arguments");
    assert.deepEqual(result.payload.error.details.errors, [{ path: "pollIntervalMs", rule: "range", expected: "integer 250..10000" }]);

    // A missing app-server capability is `unsupported` (section 3.7).
    result = await call("get_codex_sidebar_state", {});
    assert.equal(result.payload.error.code, "unsupported");
    assert.equal(result.payload.error.details.capability, "desktop/sidebar/state/read");

    // Steering with no active turn to steer is active_turn_conflict.
    result = await call("message_codex_thread", { threadId, message: "hi", mode: "steer_active" });
    assert.equal(result.payload.error.code, "active_turn_conflict");

    // An unknown thread is not_found with candidates.
    result = await call("get_codex_thread", { threadId: "019d2000-0000-7000-8000-00000000ffff", useLocalFallback: true });
    assert.equal(result.payload.error.code, "not_found");
    assert.ok(Array.isArray(result.payload.error.details.candidates));

    // Local fallback path: same key, same item semantics.
    result = await call("get_codex_thread", { threadId: localOnlyId, includeTurns: true, recentItems: 2 });
    assert.equal(result.payload.source, "local-jsonl-fallback");
    assert.deepEqual(result.payload.thread.recentItems.map((entry) => entry.type), ["agentMessage", "task_complete"]);
    assert.equal(result.payload.thread.status.type, "idle");

    // W3-01: the local fallback keeps its label.
    result = await call("list_codex_threads", { query: "Fallback Search Target", archiveScope: "all" });
    assert.equal(result.isError, false);
    assert.equal(result.payload.source, "local-jsonl-fallback");
    assert.equal(result.payload.data[0].id, localOnlyId);
    assert.equal(result.payload.warnings, undefined);
    // searchTerm was removed in 0.6.0: an unknown property, with a hint naming query.
    result = await call("list_codex_threads", { searchTerm: "Fallback Search Target", archiveScope: "all" });
    assert.equal(result.payload.error.code, "invalid_arguments");
    assert.equal(result.payload.error.details.errors[0].rule, "additionalProperties");
    assert.equal(result.payload.error.hint, "searchTerm was removed in 0.6.0; use query.");

    // resolve: the verdict is a status, not an error (R3.4).
    result = await call("resolve_codex_thread", { query: "zzzz-no-such-thread-zzzz" });
    assert.equal(result.isError, false);
    assert.equal(result.payload.status, "not_found");
    result = await call("resolve_codex_thread", { query: "Fallback Search Target" });
    assert.equal(result.payload.status, "resolved");
  } finally {
    await client.close();
  }

  // Review I1, I3, M1, m3 over MCP.
  {
    const { client: c2, call: call2 } = await connect({ CODEX_AGENT_LINK_URL: url });
    try {
      // I1: null for an optional property is "not set", not invalid.
      let r = await call2("message_codex_thread", { threadId, message: "hi", model: null, effort: null, receipt: { record: false, note: null } });
      assert.equal(r.isError, false, JSON.stringify(r.payload));
      r = await call2("list_codex_threads", { cwd: null, limit: null });
      assert.equal(r.isError, false, JSON.stringify(r.payload));
      assert.equal(r.payload.warnings, undefined);
      // A required property is never dropped.
      r = await call2("get_codex_thread", { threadId: null });
      assert.equal(r.payload.error.code, "invalid_arguments");
      // Exact-format scalar strings are coerced with a warning; others are not.
      r = await call2("list_codex_threads", { limit: "5", useLocalFallback: "true" });
      assert.equal(r.isError, false, JSON.stringify(r.payload));
      assert.deepEqual(r.payload.warnings.map((w) => [w.code, w.path]), [["coerced_argument", "limit"], ["coerced_argument", "useLocalFallback"]]);
      for (const bad of [{ limit: "5x" }, { limit: "1e2" }, { limit: " 5" }, { useLocalFallback: "yes" }, { limit: "201" }]) {
        r = await call2("list_codex_threads", bad);
        assert.equal(r.payload.error?.code, "invalid_arguments", JSON.stringify(bad));
      }

      // I3: one page by default, cursor paging, and a threadId lookup across pages.
      r = await call2("list_loaded_codex_threads", { limit: 1 });
      assert.deepEqual(r.payload.threadIds, [threadId]);
      assert.equal(r.payload.hasMore, true);
      assert.equal(r.payload.nextCursor, "page-2");
      r = await call2("list_loaded_codex_threads", { cursor: "page-2" });
      assert.deepEqual(r.payload.threadIds, [secondLoadedId]);
      assert.equal(r.payload.hasMore, false);
      r = await call2("list_loaded_codex_threads", { threadId: secondLoadedId });
      assert.deepEqual(r.payload.lookup, { threadId: secondLoadedId, loaded: true, pagesScanned: 2, complete: true });
      assert.deepEqual(r.payload.threadIds, [secondLoadedId]);
      r = await call2("list_loaded_codex_threads", { threadId: "019d2000-0000-7000-8000-00000000dead" });
      assert.equal(r.payload.lookup.loaded, false);
      assert.deepEqual(r.payload.threadIds, []);

      // M1: an unknown thread is not_found with candidates on message and wait too.
      const unknown = "019d2000-0000-7000-8000-00000000beef";
      for (const [tool, args] of [["message_codex_thread", { threadId: unknown, message: "hi" }], ["wait_for_codex_thread", { threadId: unknown, timeoutMs: 1000 }]]) {
        r = await call2(tool, args);
        assert.equal(r.payload.error.code, "not_found", `${tool}: ${JSON.stringify(r.payload)}`);
        assert.equal(r.payload.error.details.id, unknown);
        assert.ok(Array.isArray(r.payload.error.details.candidates));
        assert.equal(r.payload.error.details.didYouMean, undefined);
      }
      // Other JSON-RPC errors are upstream_error with {method, rpcCode, rpcMessage}.
      r = await call2("launch_codex_thread", {});
      assert.equal(r.payload.error.code, "upstream_error");
      assert.deepEqual(r.payload.error.details, { method: "thread/start", rpcCode: -32601, rpcMessage: "fake: thread/start" });

      // m3: get_codex_thread not_found carries codes and booleans, no paths or raw error text.
      r = await call2("get_codex_thread", { threadId: unknown });
      assert.equal(r.payload.error.code, "not_found");
      assert.deepEqual(Object.keys(r.payload.error.details).sort(), ["appServerReachable", "candidates", "id", "localTranscriptFound"]);
      assert.equal(r.payload.error.details.appServerReachable, true);
      assert.ok(!JSON.stringify(r.payload.error).includes(codexHome), "no CODEX_HOME path");
      // Candidates are {id, name, score}: no preview text, no paths.
      r = await call2("get_codex_thread", { threadId: localOnlyId.replace(/2$/, "9") });
      for (const candidate of r.payload.error.details.candidates) {
        assert.deepEqual(Object.keys(candidate).sort(), ["id", "name", "score"]);
      }
      assert.equal(r.payload.error.details.candidates[0]?.id, localOnlyId);
    } finally {
      await c2.close();
    }
  }

  // W2C-05: no Codex binary is a normal health state, with the host and what was searched.
  {
    const { client: bare, call: bareCall } = await connect({ CODEX_AGENT_LINK_CODEX_BIN: path.join(tmp, "no-such", "codex") });
    try {
      const result = await bareCall("agent_link_health", {});
      assert.equal(result.isError, false);
      assert.equal(result.payload.ok, true);
      assert.equal(result.payload.codex.available, false);
      assert.match(result.payload.codex.reason, /CODEX_AGENT_LINK_CODEX_BIN/);
      assert.ok(result.payload.codex.searched.includes(path.join(tmp, "no-such", "codex")));
      assert.equal(typeof result.payload.host, "string");
      assert.match(result.payload.hint, /AGENT_LINK_CODEX_BIN/);
      assert.doesNotMatch(result.payload.hint, /leave CODEX_AGENT_LINK_AUTOSTART enabled/);

      // Other Codex tools fail with the specific hint, not the generic one.
      const list = await bareCall("list_loaded_codex_threads", {});
      assert.equal(list.isError, true);
      assert.equal(list.payload.error.code, "codex_unavailable");
      assert.match(list.payload.error.hint, /No Codex binary was found/);
    } finally {
      await bare.close();
    }
  }

  // W2C-06: with a binary present, health reports the chosen path, source and version.
  {
    const fakeBin = path.join(tmp, "bin", "codex");
    mkdirSync(path.dirname(fakeBin), { recursive: true });
    writeFileSync(fakeBin, "#!/bin/sh\necho 'codex-cli 9.9.9-test'\n", { mode: 0o755 });
    const { client: withBin, call: binCall } = await connect({ CODEX_AGENT_LINK_CODEX_BIN: fakeBin, CODEX_AGENT_LINK_URL: url });
    try {
      // startAppServer:false is the cheap check: no blocking --version probe.
      let result = await binCall("agent_link_health", { startAppServer: false });
      assert.equal(result.payload.codex.available, true);
      assert.equal(result.payload.codex.path, fakeBin);
      assert.equal(result.payload.codex.source, "env:CODEX_AGENT_LINK_CODEX_BIN");
      assert.equal(result.payload.codex.version, null);
      assert.equal(result.payload.codex.versionProbed, false);
      // A full health check probes it (the app-server itself is the fake URL).
      result = await binCall("agent_link_health", {});
      assert.equal(result.isError, false, JSON.stringify(result.payload));
      assert.equal(result.payload.codex.version, "codex-cli 9.9.9-test");
      assert.equal(result.payload.codex.versionProbed, true);
    } finally {
      await withBin.close();
    }
  }

  console.log("server codex tool tests passed");
} finally {
  for (const socket of wss.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
}
