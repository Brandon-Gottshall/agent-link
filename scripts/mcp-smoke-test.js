#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BASE_CODEX_TOOLS = [
  "agent_link_health",
  "agent_link_mailbox_inspect",
  "archive_codex_thread",
  "check_coordination_obligations",
  "get_codex_sidebar_state",
  "get_codex_thread",
  "launch_codex_thread",
  "launch_project_worker",
  "list_agent_link_receipts",
  "list_codex_threads",
  "list_loaded_codex_threads",
  "message_claude_session",
  "message_codex_thread",
  "message_project_orchestrator",
  "read_agent_link_inbox",
  "register_dependency_handoff",
  "reply_agent_link_message",
  "resolve_codex_thread",
  "resolve_project_orchestrator",
  "return_project_work_result",
  "wait_for_claude_session",
  "wait_for_codex_thread"
].sort();

const HOST_NEUTRAL_MAILBOX_TOOL = "agent_link_mailbox_inspect";
const HOST_NEUTRAL_SEND_TOOL = "message_claude_session";
const HOST_NEUTRAL_WAIT_TOOL = "wait_for_claude_session";
const HOST_NEUTRAL_READ_INBOX_TOOL = "read_agent_link_inbox";
const HOST_NEUTRAL_REPLY_TOOL = "reply_agent_link_message";

const CLAUDE_LISTING_TOOLS = [
  "get_claude_session",
  "list_claude_sessions",
  "list_loaded_claude_sessions",
  "resolve_claude_session"
].sort();

async function listToolsWithEnv(envOverrides) {
  // Strip CLAUDE_* and CODEX_HOME from the inherited env so each scenario is hermetic.
  const cleanEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CODEX_HOME") continue;
    if (k.startsWith("CLAUDE_")) continue;
    cleanEnv[k] = v;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./scripts/start-server.js"],
    cwd: pluginRoot,
    env: {
      ...cleanEnv,
      CODEX_AGENT_LINK_AUTOSTART: "0",
      ...envOverrides
    }
  });

  const client = new Client({ name: "codex-agent-link-smoke", version: "0.1.0" });

  try {
    await client.connect(transport);
    const capabilities = client.getServerCapabilities();
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    const archiveTool = tools.tools.find((tool) => tool.name === "archive_codex_thread");
    assert.ok(archiveTool);
    assert.equal(Array.isArray(archiveTool.inputSchema.required), false);
    assert.match(archiveTool.inputSchema.properties.threadId.description, /Defaults to the current caller thread/);

    if (envOverrides.__callHealth) {
      const health = await client.callTool({
        name: "agent_link_health",
        arguments: { startAppServer: false }
      });
      assert.equal(health.isError, false);
    }

    return { names, capabilities };
  } finally {
    await client.close();
  }
}

// Scenario 1: default env (no host-specific env). Expect base codex tools only.
{
  const { names, capabilities } = await listToolsWithEnv({ __callHealth: true });
  assert.deepEqual(names, BASE_CODEX_TOOLS);
  assert.equal(capabilities.experimental?.["claude/channel"], undefined);
  assert.ok(names.includes(HOST_NEUTRAL_MAILBOX_TOOL),
    "agent_link_mailbox_inspect must be exposed in no-host scenario (host-neutral)");
  assert.ok(names.includes(HOST_NEUTRAL_SEND_TOOL),
    "message_claude_session must be exposed in no-host scenario (host-neutral)");
  assert.ok(names.includes(HOST_NEUTRAL_WAIT_TOOL),
    "wait_for_claude_session must be exposed in no-host scenario (host-neutral)");
  assert.ok(names.includes(HOST_NEUTRAL_READ_INBOX_TOOL),
    "read_agent_link_inbox must be exposed in no-host scenario (host-neutral)");
  assert.ok(names.includes(HOST_NEUTRAL_REPLY_TOOL),
    "reply_agent_link_message must be exposed in no-host scenario (host-neutral)");
}

// Scenario 2: claude-host env. Expect base codex tools + 4 claude listing tools.
{
  const { names, capabilities } = await listToolsWithEnv({ CLAUDE_PLUGIN_ROOT: "/tmp/fake-plugin" });
  const expected = [...BASE_CODEX_TOOLS, ...CLAUDE_LISTING_TOOLS].sort();
  assert.deepEqual(names, expected);
  assert.equal(names.length - BASE_CODEX_TOOLS.length, 4);
  assert.deepEqual(capabilities.experimental?.["claude/channel"], {});
  assert.ok(names.includes(HOST_NEUTRAL_MAILBOX_TOOL),
    "agent_link_mailbox_inspect must be exposed in claude-host scenario (host-neutral)");
  assert.ok(names.includes(HOST_NEUTRAL_SEND_TOOL),
    "message_claude_session must be exposed in claude-host scenario (host-neutral)");
  assert.ok(names.includes(HOST_NEUTRAL_WAIT_TOOL),
    "wait_for_claude_session must be exposed in claude-host scenario (host-neutral)");
  assert.ok(names.includes(HOST_NEUTRAL_READ_INBOX_TOOL),
    "read_agent_link_inbox must be exposed in claude-host scenario (host-neutral)");
  assert.ok(names.includes(HOST_NEUTRAL_REPLY_TOOL),
    "reply_agent_link_message must be exposed in claude-host scenario (host-neutral)");
}

// Scenario 3: codex-host env. Expect base codex tools only (no claude listing tools).
{
  const { names, capabilities } = await listToolsWithEnv({ CODEX_HOME: "/tmp/fake-codex-home" });
  assert.deepEqual(names, BASE_CODEX_TOOLS);
  assert.equal(capabilities.experimental?.["claude/channel"], undefined);
  assert.ok(names.includes(HOST_NEUTRAL_MAILBOX_TOOL),
    "agent_link_mailbox_inspect must be exposed in codex-host scenario (host-neutral)");
  assert.ok(names.includes(HOST_NEUTRAL_SEND_TOOL),
    "message_claude_session must be exposed in codex-host scenario (host-neutral)");
  assert.ok(names.includes(HOST_NEUTRAL_WAIT_TOOL),
    "wait_for_claude_session must be exposed in codex-host scenario (host-neutral)");
  assert.ok(names.includes(HOST_NEUTRAL_READ_INBOX_TOOL),
    "read_agent_link_inbox must be exposed in codex-host scenario (host-neutral)");
  assert.ok(names.includes(HOST_NEUTRAL_REPLY_TOOL),
    "reply_agent_link_message must be exposed in codex-host scenario (host-neutral)");
}

console.log("MCP smoke test passed");
