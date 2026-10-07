// tools/list contract over MCP stdio, for the Claude and the Codex host
// (design doc T-3.1, T-3.2, R5.2):
//   - tools/list matches the committed snapshot in tests/fixtures/;
//   - every tool has an outputSchema (the closed section 3.1 envelope) and
//     annotations, every input object declares additionalProperties, and
//     every property has a description;
//   - every tool rejects {bogus: 1} with invalid_arguments and isError:true;
//   - tools/list and tools/call agree (a listed tool is callable, an unlisted
//     name is unknown_tool).
// Regenerate the snapshots after an intended schema change with
//   node tests/server/tools-contract.test.js --update
// and list the diff in the PR description.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pluginRoot } from "../helpers/codex-stub.js";
import { hermeticEnv } from "../helpers/env.js";

const update = process.argv.includes("--update");

// Objects whose free-form shape is intended (documented in the schema).
const FREE_FORM_INPUTS = new Set(["return_project_work_result:details"]);

const READ_ONLY = new Set([
  "agent_link_health",
  "agent_link_mailbox_inspect",
  "check_coordination_obligations",
  "get_agent_link_message_status",
  "get_claude_session",
  "get_codex_sidebar_state",
  "get_codex_thread",
  "list_agent_link_receipts",
  "get_agent_override_policy",
  "get_agent_role",
  "list_agent_roles",
  "list_agents",
  "list_claude_sessions",
  "list_codex_threads",
  "list_loaded_claude_sessions",
  "list_loaded_codex_threads",
  "resolve_agent",
  "resolve_claude_session",
  "resolve_codex_thread",
  "resolve_project_orchestrator",
  "wait_for_agent",
  "wait_for_claude_session",
  "wait_for_codex_thread"
]);

async function connect(host) {
  const client = new Client({ name: "tools-contract-test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "src", "server.js")],
    cwd: pluginRoot,
    env: hermeticEnv({
      overrides: {
        AGENT_LINK_HOST: host,
        AGENT_LINK_CODEX_AUTOSTART: "0",
        AGENT_LINK_DISABLE_CHANNEL: "1"
      }
    }),
    stderr: "ignore"
  }));
  return client;
}

/**
 * Walks an input schema: every object declares additionalProperties (false
 * unless allowlisted), every property has a description.
 */
function checkInputSchema(tool, schema, where, problems) {
  if (!schema || typeof schema !== "object") return;
  const isObject = schema.type === "object" || schema.properties;
  if (isObject) {
    const key = `${tool}:${where}`;
    if (FREE_FORM_INPUTS.has(key)) {
      if (schema.additionalProperties !== true) problems.push(`${key}: free-form object must say additionalProperties:true`);
    } else if (schema.additionalProperties !== false) {
      problems.push(`${key}: additionalProperties must be false`);
    }
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const child = where ? `${where}.${name}` : name;
      if (typeof property.description !== "string" || !property.description.trim()) problems.push(`${tool}:${child}: missing description`);
      checkInputSchema(tool, property, child, problems);
    }
  }
  if (schema.items) checkInputSchema(tool, schema.items, `${where}[]`, problems);
  for (const option of schema.oneOf ?? []) checkInputSchema(tool, option, where, problems);
}

const listsByHost = {};
for (const host of ["claude", "codex"]) {
  const client = await connect(host);
  try {
    const { tools } = await client.listTools();
    const snapshotPath = path.join(pluginRoot, "tests", "fixtures", `tools-list.${host}.json`);
    const actual = `${JSON.stringify(tools, null, 2)}\n`;
    if (update) {
      writeFileSync(snapshotPath, actual);
      console.log(`wrote ${path.relative(pluginRoot, snapshotPath)}`);
    } else {
      assert.ok(existsSync(snapshotPath), `missing ${path.relative(pluginRoot, snapshotPath)}; run with --update`);
      assert.equal(actual, readFileSync(snapshotPath, "utf8"),
        `tools/list for host ${host} differs from ${path.relative(pluginRoot, snapshotPath)}; if intended, rerun with --update and list the diff in the PR`);
    }

    // T-3.2 static checks.
    const problems = [];
    for (const tool of tools) {
      checkInputSchema(tool.name, tool.inputSchema, "", problems);
      const output = tool.outputSchema;
      if (!output) {
        problems.push(`${tool.name}: no outputSchema`);
      } else {
        if (output.additionalProperties !== false) problems.push(`${tool.name}: outputSchema must be closed`);
        if (!["ok", "error", "warnings"].every((key) => output.properties?.[key])) problems.push(`${tool.name}: outputSchema lacks the envelope keys`);
        for (const [name, property] of Object.entries(output.properties ?? {})) {
          if (typeof property.description !== "string" || !property.description.trim()) problems.push(`${tool.name}: output ${name} has no description`);
        }
      }
      const annotations = tool.annotations ?? {};
      if (annotations.openWorldHint !== false) problems.push(`${tool.name}: openWorldHint must be false`);
      if (annotations.readOnlyHint !== READ_ONLY.has(tool.name)) problems.push(`${tool.name}: readOnlyHint should be ${READ_ONLY.has(tool.name)}`);
      if (!READ_ONLY.has(tool.name) && typeof annotations.destructiveHint !== "boolean") problems.push(`${tool.name}: write tools state destructiveHint`);
    }
    const archive = tools.find((tool) => tool.name === "archive_codex_thread");
    assert.deepEqual(archive.annotations, { openWorldHint: false, readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    // B9 (R1.18, R9.4): the role and override-policy writes are destructive.
    for (const name of ["set_agent_role", "clear_agent_role", "set_agent_override_policy"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.deepEqual(tool?.annotations, { openWorldHint: false, readOnlyHint: false, destructiveHint: true }, name);
    }
    assert.deepEqual(problems, [], `host ${host}: schema contract problems`);

    // T-3.1: every tool rejects an unknown property.
    for (const tool of tools) {
      const result = await client.callTool({ name: tool.name, arguments: { bogus: 1 } });
      assert.equal(result.isError, true, `${tool.name} must reject {bogus:1}`);
      assert.equal(result.structuredContent.ok, false);
      assert.equal(result.structuredContent.error.code, "invalid_arguments", tool.name);
      assert.ok(result.structuredContent.error.details.errors.some((error) => error.path === "bogus" && error.rule === "additionalProperties"), tool.name);
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    }

    // Listed and callable agree; an unlisted name is unknown_tool.
    const unknown = await client.callTool({ name: "no_such_tool", arguments: {} });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent.error.code, "unknown_tool");
    // R1.16: every tool on every host. The Claude listing tools and the
    // host-neutral tools answer on the Codex host too.
    for (const name of ["list_claude_sessions", "list_loaded_claude_sessions", "list_agents"]) {
      const listed = await client.callTool({ name, arguments: {} });
      assert.equal(listed.isError, false, `${host}: ${name} ${JSON.stringify(listed.structuredContent)}`);
      assert.ok(Array.isArray(listed.structuredContent.sessions), `${host}: ${name}`);
    }
    const resolved = await client.callTool({ name: "resolve_agent", arguments: { query: "nothing-matches-this-query" } });
    assert.equal(resolved.isError, false, JSON.stringify(resolved.structuredContent));
    assert.equal(resolved.structuredContent.status, "not_found");
    listsByHost[host] = tools;

    // Review I1: nulls for optional properties are "not set" on the Claude tools too.
    const nulls = await client.callTool({ name: "message_claude_session", arguments: { sessionId: "local_no_such_session", message: "x", surface: null, replyToMessageId: null, timeoutMs: null } });
    assert.equal(nulls.structuredContent.error.code, "not_found", JSON.stringify(nulls.structuredContent));

    // Health: the B4 additions are present and never carry stacks or output tails.
    const health = await client.callTool({ name: "agent_link_health", arguments: { startAppServer: false } });
    assert.equal(health.isError, false);
    const report = health.structuredContent;
    assert.equal(report.host, host);
    assert.deepEqual(Object.keys(report.providers).sort(), ["claude", "codex"]);
    assert.equal(report.stateDir.source, "default");
    assert.deepEqual(report.env, { deprecated: [], conflicts: [] });
    assert.deepEqual(report.legacyState.files, []);
    assert.ok(Array.isArray(report.recentEvents));
    assert.deepEqual(JSON.parse(health.content[0].text), report);
  } finally {
    await client.close();
  }
}

// Legacy env names reach health.env (R4.2); values are never reported.
{
  const legacy = new Client({ name: "tools-contract-legacy-env", version: "0" });
  await legacy.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "src", "server.js")],
    cwd: pluginRoot,
    env: hermeticEnv({
      overrides: {
        AGENT_LINK_HOST: "codex",
        CODEX_AGENT_LINK_AUTOSTART: "0",
        AGENT_LINK_INFER_RECEIPT_ORIGIN: "1",
        CODEX_AGENT_LINK_INFER_RECEIPT_ORIGIN: "0"
      }
    }),
    stderr: "ignore"
  }));
  try {
    const health = await legacy.callTool({ name: "agent_link_health", arguments: { startAppServer: false } });
    const { env } = health.structuredContent;
    assert.deepEqual(env.deprecated, [{ name: "CODEX_AGENT_LINK_AUTOSTART", canonical: "AGENT_LINK_CODEX_AUTOSTART" }]);
    assert.deepEqual(env.conflicts, [{ canonical: "AGENT_LINK_INFER_RECEIPT_ORIGIN", winner: "AGENT_LINK_INFER_RECEIPT_ORIGIN", ignored: "CODEX_AGENT_LINK_INFER_RECEIPT_ORIGIN" }]);
  } finally {
    await legacy.close();
  }
}

console.log("tools contract tests passed");

// T-1.3: host gating is gone, so the Codex host lists exactly the Claude
// host's tools (R1.16).
assert.deepEqual(listsByHost.codex, listsByHost.claude, "tools/list is the same on both hosts");
assert.equal(readFileSync(path.join(pluginRoot, "tests", "fixtures", "tools-list.codex.json"), "utf8"),
  readFileSync(path.join(pluginRoot, "tests", "fixtures", "tools-list.claude.json"), "utf8"));
