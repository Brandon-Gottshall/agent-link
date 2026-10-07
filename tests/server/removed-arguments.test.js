// 0.6.0 removal of the argument aliases and duplicated output keys that 0.5.0
// deprecated (design doc sections 3.3 and 6.1-6.3, R6.1-R6.4). Every removed
// alias is now an unknown property: the registry rejects it with
// invalid_arguments, the handler never runs, and the hint names the
// replacement. The real tool definitions are used with stub handlers.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { createRegistry } from "../../src/server/registry.js";
import { claudeSendTool } from "../../src/tools/claude-send.js";
import { replyAgentLinkMessageTool } from "../../src/tools/claude-reply.js";
import { claudeWaitTool } from "../../src/tools/claude-wait.js";
import { mailboxInspectTool } from "../../src/tools/mailbox-inspect.js";
import { listReceiptsTool } from "../../src/tools/receipts.js";
import { codexThreadTools } from "../../src/tools/codex-threads.js";
import { codexActionTools } from "../../src/tools/codex-actions.js";
import { orchestrationTools } from "../../src/tools/orchestration.js";

const byName = (tools, name) => {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `${name} is defined`);
  return found;
};

const definitions = [
  claudeSendTool,
  replyAgentLinkMessageTool,
  claudeWaitTool,
  mailboxInspectTool,
  listReceiptsTool,
  byName(codexThreadTools, "list_codex_threads"),
  byName(orchestrationTools, "return_project_work_result")
];

let handlerCalls = 0;
const registry = createRegistry(definitions.map((definition) => ({
  definition,
  handler: async () => {
    handlerCalls += 1;
    return {};
  }
})));

// [tool, arguments with the removed alias, removed name, rule, hint]
const cases = [
  ["list_codex_threads", { searchTerm: "x" }, "searchTerm", "additionalProperties", "searchTerm was removed in 0.6.0; use query."],
  ["list_agent_link_receipts", { searchTerm: "x" }, "searchTerm", "additionalProperties", "searchTerm was removed in 0.6.0; use query."],
  ["message_claude_session", { sessionId: "local_a", body: "hi" }, "body", "additionalProperties", "body was removed in 0.6.0; use message."],
  ["message_claude_session", { to: "local_a", message: "hi" }, "to", "additionalProperties", "to was removed in 0.6.0; use sessionId (exact id; archived sessions included) or query (fuzzy; archived sessions skipped)."],
  ["reply_agent_link_message", { messageId: "m1", body: "hi" }, "body", "additionalProperties", "body was removed in 0.6.0; use message."],
  ["wait_for_claude_session", { sessionId: "local_a", latestMessageId: "m1" }, "latestMessageId", "additionalProperties", "latestMessageId was removed in 0.6.0; use replyToMessageId."],
  ["return_project_work_result", { orchestratorThreadId: "t1", status: "done", summary: "s" }, "status", "additionalProperties", "status was removed in 0.6.0; use resultStatus."],
  ["agent_link_mailbox_inspect", { since: 0 }, "since", "type", "since as epoch milliseconds was removed in 0.6.0; pass an ISO 8601 timestamp, for example new Date(ms).toISOString()."]
];

for (const [tool, args, removed, rule, hint] of cases) {
  const label = `${tool} ${removed}`;
  const result = await registry.callTool(tool, args);
  assert.equal(result.isError, true, label);
  const { error } = result.structuredContent;
  assert.equal(error.code, "invalid_arguments", label);
  assert.ok(error.details.errors.some((problem) => problem.path === removed && problem.rule === rule), `${label}: ${JSON.stringify(error.details.errors)}`);
  assert.equal(error.hint, hint, label);
  assert.equal(error.details.removed.length, 1, label);
  assert.equal(error.details.removed[0].argument, removed, label);
}
assert.equal(handlerCalls, 0, "a removed alias never reaches the handler");

// Passing the replacement beside the removed alias is still rejected.
{
  const result = await registry.callTool("message_claude_session", { sessionId: "local_a", message: "hi", body: "hi" });
  assert.equal(result.structuredContent.error.code, "invalid_arguments");
  assert.equal(result.structuredContent.error.hint, "body was removed in 0.6.0; use message.");
}

// The canonical names still work, without warnings.
{
  const ok = [
    ["list_codex_threads", { query: "x" }],
    ["list_agent_link_receipts", { query: "x" }],
    ["message_claude_session", { sessionId: "local_a", message: "hi" }],
    ["message_claude_session", { query: "payments", message: "hi" }],
    ["reply_agent_link_message", { messageId: "m1", message: "hi" }],
    ["wait_for_claude_session", { sessionId: "local_a", replyToMessageId: "m1" }],
    ["return_project_work_result", { orchestratorThreadId: "t1", resultStatus: "done", summary: "s" }],
    ["agent_link_mailbox_inspect", { since: "2026-10-01T00:00:00Z" }]
  ];
  for (const [tool, args] of ok) {
    const result = await registry.callTool(tool, args);
    assert.equal(result.isError, false, `${tool}: ${result.content[0].text}`);
    assert.equal(result.structuredContent.warnings, undefined, tool);
  }
  assert.equal(handlerCalls, ok.length);
}

// message_claude_session still requires message, and return_project_work_result
// still requires resultStatus, now through the schema.
{
  let result = await registry.callTool("message_claude_session", { sessionId: "local_a" });
  assert.deepEqual(result.structuredContent.error.details.errors.map((e) => [e.path, e.rule]), [["message", "required"]]);
  result = await registry.callTool("return_project_work_result", { orchestratorThreadId: "t1", summary: "s" });
  assert.deepEqual(result.structuredContent.error.details.errors.map((e) => [e.path, e.rule]), [["resultStatus", "required"]]);
}

// tools/list carries no alias properties and no deprecated input properties
// for the removed names; the duplicated output keys are gone.
{
  const tools = registry.listTools();
  for (const tool of tools) {
    for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      assert.ok(!/removed in 0\.6\.0/.test(schema.description ?? ""), `${tool.name}.${name} still mentions removal in 0.6.0`);
    }
  }
  const input = (name) => tools.find((tool) => tool.name === name).inputSchema.properties;
  assert.equal(input("list_codex_threads").searchTerm, undefined);
  assert.equal(input("list_agent_link_receipts").searchTerm, undefined);
  assert.equal(input("message_claude_session").to, undefined);
  assert.equal(input("message_claude_session").body, undefined);
  assert.equal(input("reply_agent_link_message").body, undefined);
  assert.equal(input("wait_for_claude_session").latestMessageId, undefined);
  assert.equal(input("return_project_work_result").status, undefined);
  assert.equal(input("agent_link_mailbox_inspect").since.type, "string");

  const output = (definition) => Object.keys(definition.output);
  for (const key of ["result", "message", "sessionId"]) assert.ok(!output(claudeWaitTool).includes(key), `wait_for_claude_session output ${key}`);
  assert.ok(!output(claudeSendTool).includes("replyConfirmation"));
  assert.ok(!output(byName(codexActionTools, "message_codex_thread")).includes("replyConfirmation"));
}

console.log("removed-arguments tests passed");
