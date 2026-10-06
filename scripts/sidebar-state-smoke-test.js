#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket, { WebSocketServer } from "ws";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const server = http.createServer();
const wss = new WebSocketServer({ server });
const requests = [];

const visibleThread = {
  id: "thread-visible",
  preview: "Visible thread",
  status: { type: "idle" },
  createdAt: 1779086300,
  updatedAt: 1779086400,
  cwd: "/tmp/project",
  path: "/tmp/codex/sessions/thread-visible.jsonl",
  source: "cli",
  agentNickname: null,
  agentRole: null
};

const subagentThread = {
  id: "thread-subagent",
  preview: "Worker task",
  status: { type: "active" },
  createdAt: 1779086400,
  updatedAt: 1779086500,
  cwd: "/tmp/project",
  path: "/tmp/codex/sessions/thread-subagent.jsonl",
  source: {
    subAgent: {
      threadSpawn: {
        parentThreadId: "thread-visible",
        depth: 1,
        agentPath: null,
        agentNickname: "Kuhn",
        agentRole: "worker"
      }
    }
  },
  agentNickname: "Kuhn",
  agentRole: "worker"
};

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (!message.id) {
      return;
    }
    requests.push(message.method);

    if (message.method === "initialize") {
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          userAgent: "mock-codex-app-server",
          codexHome: "/tmp/codex-agent-link-sidebar-state",
          platformOs: "macos"
        }
      }));
      return;
    }

    if (message.method === "desktop/sidebar/state/read") {
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          authority: "rendererSidebarModel",
          modelVersion: 1,
          generatedAt: "2026-05-18T12:00:00.000Z",
          selectedThreadKey: "local:thread-visible",
          settings: { organizeMode: "project", sortKey: "updated_at" },
          sections: [
            { key: "threads", collapsed: false, itemKeys: ["local:thread-visible"] },
            { key: "background-threads", collapsed: false, itemKeys: ["local:thread-background", "local:thread-subagent"] }
          ],
          items: [
            { key: "local:thread-visible", kind: "local", threadId: "thread-visible", title: "Visible thread" },
            { key: "local:thread-background", kind: "local", threadId: "thread-background", title: null },
            { key: "local:thread-subagent", kind: "local", threadId: "thread-subagent", title: "Worker task" }
          ],
          indexes: {
            localThreadIds: ["thread-visible", "thread-background", "thread-subagent"],
            navigationThreadKeys: ["local:thread-visible", "local:thread-background", "local:thread-subagent"],
            visibleSidebarSectionKeys: ["threads", "background-threads"]
          },
          reason: null
        }
      }));
      return;
    }

    if (message.method === "thread/loaded/list") {
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          data: [
            { id: "thread-visible", status: { type: "idle" } },
            { id: "thread-background", status: { type: "idle" } },
            { id: "thread-subagent", status: { type: "active" } }
          ]
        }
      }));
      return;
    }

    if (message.method === "thread/list") {
      const isSubagentList = Array.isArray(message.params?.sourceKinds)
        && message.params.sourceKinds.includes("subAgentThreadSpawn");
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          data: isSubagentList ? [subagentThread] : [visibleThread],
          nextCursor: null
        }
      }));
      return;
    }

    socket.send(JSON.stringify({
      id: message.id,
      error: {
        code: -32601,
        message: `Unhandled mock method: ${message.method}`
      }
    }));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const url = `ws://127.0.0.1:${port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./src/server.js"],
  cwd: pluginRoot,
  env: {
    ...process.env,
    CODEX_AGENT_LINK_AUTOSTART: "0",
    CODEX_AGENT_LINK_URL: url
  }
});

const client = new Client({ name: "codex-agent-link-sidebar-state-smoke", version: "0.1.0" });

try {
  await client.connect(transport);

  const sidebarState = await client.callTool({
    name: "get_codex_sidebar_state",
    arguments: {}
  });
  assert.equal(sidebarState.isError, false);
  const sidebarPayload = JSON.parse(sidebarState.content[0].text);
  assert.equal(sidebarPayload.ok, true);
  assert.equal(sidebarPayload.sidebarState.authority, "rendererSidebarModel");
  assert.equal(sidebarPayload.sidebarState.localThreadIds[0], "thread-visible");

  const loaded = await client.callTool({
    name: "list_loaded_codex_threads",
    arguments: {}
  });
  assert.equal(loaded.isError, false);
  const loadedPayload = JSON.parse(loaded.content[0].text);
  assert.deepEqual(loadedPayload.data.map((thread) => thread.id), ["thread-visible", "thread-background", "thread-subagent"]);
  assert.equal(loadedPayload.loadedThreads.find((thread) => thread.id === "thread-visible").sidebarMembership, "in_sidebar_model");
  assert.equal(loadedPayload.loadedThreads.find((thread) => thread.id === "thread-background").sidebarMembership, "background_only");
  assert.equal(loadedPayload.loadedThreads.find((thread) => thread.id === "thread-subagent").sidebarMembership, "background_only");
  assert.equal(loadedPayload.sidebarMembershipByThreadId["thread-background"], "background_only");
  assert.match(loadedPayload.sidebarMembershipSemantics.warning, /rendererSidebarModel/);
  assert.equal(loadedPayload.subagentRegistry.loadedSubagentCount, 1);
  assert.equal(loadedPayload.subagentRegistry.loadedSubagents[0].id, "thread-subagent");
  assert.equal(loadedPayload.subagentRegistry.loadedSubagents[0].parentThreadId, "thread-visible");
  assert.equal(loadedPayload.subagentRegistry.loadedSubagents[0].agentNickname, "Kuhn");
  assert.equal(loadedPayload.subagentRegistry.loadedSubagents[0].sidebarMembership, "background_only");
  assert.deepEqual(
    loadedPayload.subagentRegistry.byParentThreadId["thread-visible"].map((thread) => thread.id),
    ["thread-subagent"]
  );

  const listed = await client.callTool({
    name: "list_codex_threads",
    arguments: {
      includeSubagents: true,
      limit: 10
    }
  });
  assert.equal(listed.isError, false);
  const listedPayload = JSON.parse(listed.content[0].text);
  assert.deepEqual(listedPayload.data.map((thread) => thread.id), ["thread-visible", "thread-subagent"]);

  assert.ok(requests.includes("desktop/sidebar/state/read"));
  assert.ok(requests.includes("thread/list"));

  console.log("Sidebar state smoke test passed");
} finally {
  await client.close();
  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
