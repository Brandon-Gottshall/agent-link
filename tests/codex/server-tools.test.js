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
        return reply({ result: { data: [], nextCursor: null } });
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
    return { isError: result.isError, payload: JSON.parse(result.content[0].text) };
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
    assert.equal(result.payload.details.code, "target-override-rejected");
    assert.deepEqual(result.payload.details.conflicts, [{ field: "cwd", requested: "/tmp/elsewhere", threadValue: baseThread.cwd }]);
    assert.ok(!received.some((msg) => ["turn/start", "thread/resume", "turn/steer"].includes(msg.method)), "nothing was started");

    result = await call("message_codex_thread", { threadId, message: "hi", model: "other-model" });
    assert.equal(result.isError, true, "a model different from the reported one is refused");
    assert.deepEqual(result.payload.details.conflicts, [{ field: "model", requested: "other-model", threadValue: "gpt-known" }]);

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

    // allowTargetOverride forwards everything.
    received.length = 0;
    result = await call("message_codex_thread", { threadId, message: "hi", cwd: "/tmp/elsewhere", model: "other-model", effort: "high", allowTargetOverride: true });
    assert.equal(result.isError, false);
    assert.equal(startParams().cwd, "/tmp/elsewhere");
    assert.equal(startParams().model, "other-model");
    assert.equal(startParams().effort, "high");

    // P2-04: message + waitForReply returns up to N recent items.
    result = await call("message_codex_thread", { threadId, message: "hi", waitForReply: true, timeoutMs: 2000, pollIntervalMs: 250, recentItems: 2 });
    assert.equal(result.isError, false);
    assert.equal(envelopeBody(result.payload.replyConfirmation.finalResponse), "second answer");
    assert.match(result.payload.replyConfirmation.recentItemsEnvelope, /\[agentMessage i5\] second answer/);
    assert.deepEqual(result.payload.replyConfirmation.recentItems.map((entry) => [entry.turnId, entry.id]), [["turn-2", "i4"], ["turn-2", "i5"]]);

    // W2B-06: get/wait slice items, not turns, under one key.
    result = await call("get_codex_thread", { threadId, includeTurns: true, recentItems: 3 });
    assert.equal(result.payload.source, "app-server");
    assert.deepEqual(result.payload.thread.recentItems.map((entry) => entry.id), ["i3", "i4", "i5"]);
    assert.deepEqual(result.payload.thread.turns.map((turn) => [turn.id, turn.items.length, turn.itemsOmitted ?? 0]), [["turn-1", 1, 2], ["turn-2", 2, 0]]);

    result = await call("wait_for_codex_thread", { threadId, timeoutMs: 1000, pollIntervalMs: 250, recentItems: 1 });
    assert.deepEqual(result.payload.thread.recentItems.map((entry) => entry.id), ["i5"]);

    // Local fallback path: same key, same item semantics.
    result = await call("get_codex_thread", { threadId: localOnlyId, includeTurns: true, recentItems: 2 });
    assert.equal(result.payload.source, "local-jsonl-fallback");
    assert.deepEqual(result.payload.thread.recentItems.map((entry) => entry.type), ["agentMessage", "task_complete"]);
    assert.equal(result.payload.thread.status.type, "idle");

    // W3-01: the local fallback keeps its label.
    result = await call("list_codex_threads", { searchTerm: "Fallback Search Target", archiveScope: "all" });
    assert.equal(result.isError, false);
    assert.equal(result.payload.source, "local-jsonl-fallback");
    assert.equal(result.payload.data[0].id, localOnlyId);
  } finally {
    await client.close();
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
      assert.match(result.payload.hint, /CODEX_AGENT_LINK_CODEX_BIN/);
      assert.doesNotMatch(result.payload.hint, /leave CODEX_AGENT_LINK_AUTOSTART enabled/);

      // Other Codex tools fail with the specific hint, not the generic one.
      const list = await bareCall("list_loaded_codex_threads", {});
      assert.equal(list.isError, true);
      assert.match(list.payload.hint, /No Codex binary was found/);
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
