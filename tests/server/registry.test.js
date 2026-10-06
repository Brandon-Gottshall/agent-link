// Registry unit tests (design doc section 3): one list drives tools/list and
// tools/call, schema validation rejects unknown and out-of-range arguments,
// deprecated aliases warn, and every result is the section 3.1 envelope.
import assert from "node:assert/strict";
import { AgentLinkError } from "../../src/shared/errors.js";
import { applyAliases, createRegistry, toMcpTool } from "../../src/server/registry.js";
import { validateSchema } from "../../src/server/validate.js";
import { intRange, limit, receiptInput, str } from "../../src/server/schemas.js";
import { createLogger, setLogger } from "../../src/shared/log.js";

// Keep the expected internal_error log line off stderr.
setLogger(createLogger({ env: {}, stderr: { write() {} } }));

const echo = {
  definition: {
    name: "echo",
    description: "Echo the arguments back.",
    inputSchema: {
      type: "object",
      properties: {
        message: str("Text."),
        limit: limit("list", "things"),
        count: intRange({ min: 0, max: 5, def: 1, description: "A count." }),
        receipt: receiptInput
      },
      additionalProperties: false
    },
    aliases: [{ canonical: "message", aliases: ["body"], required: true }],
    output: { echoed: { type: "object", description: "The arguments." } },
    annotations: { readOnlyHint: true }
  },
  handler: async (args, ctx) => {
    if (args.message === "warn") ctx.warn({ code: "custom", message: "a handler warning" });
    return { ok: "ignored", echoed: args };
  }
};

const failing = {
  definition: {
    name: "fail",
    description: "Fails.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["known", "bug", "undeclared"], description: "Failure kind." } }, additionalProperties: false },
    output: { fine: { type: "boolean", description: "Never returned." } },
    annotations: { readOnlyHint: true }
  },
  handler: async (args) => {
    if (args.kind === "known") {
      throw new AgentLinkError("not_found", "No such thing.", { details: { query: "x", candidates: [] }, hint: "Look elsewhere." });
    }
    if (args.kind === "undeclared") return { fine: true, surprise: 1 };
    const error = new TypeError("secret internal detail");
    throw error;
  }
};

const registry = createRegistry([echo, failing], { hintFor: () => "fallback hint" });

// tools/list: derived from the same entries, with alias properties, the
// envelope output schema, and openWorldHint:false by default.
{
  const tools = registry.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["echo", "fail"]);
  const tool = tools[0];
  assert.equal(tool.inputSchema.properties.body.deprecated, true);
  assert.match(tool.inputSchema.properties.body.description, /Deprecated alias of message; removed in 0\.6\.0/);
  assert.deepEqual(tool.annotations, { openWorldHint: false, readOnlyHint: true });
  assert.equal(tool.outputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.outputSchema.properties), ["ok", "error", "warnings", "echoed"]);
  assert.deepEqual(registry.names(), ["echo", "fail"]);
  assert.ok(registry.has("echo") && !registry.has("nope"));
  assert.throws(() => createRegistry([echo, echo]), /Duplicate tool definition: echo/);
  assert.throws(() => toMcpTool({ ...echo.definition, aliases: [{ canonical: "missing", aliases: ["x"] }] }), /alias target missing/);
}

// Success envelope: ok:true, payload keys, the handler's own `ok` ignored,
// warnings omitted when empty.
{
  const result = await registry.callTool("echo", { message: "hi" });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, { ok: true, echoed: { message: "hi" } });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
}

// Handler warnings and alias warnings both land in warnings[].
{
  const envelope = await registry.invoke("echo", { body: "warn" });
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.echoed, { message: "warn" }, "the alias is renamed to the canonical argument");
  assert.deepEqual(envelope.warnings.map((w) => w.code).sort(), ["custom", "deprecated_argument"]);
  const deprecation = envelope.warnings.find((w) => w.code === "deprecated_argument");
  assert.equal(deprecation.replacement, "message");
}

// T-3.4: an alias and its canonical name that differ are invalid_arguments;
// the same value twice is accepted with a warning.
{
  let envelope = await registry.invoke("echo", { body: "a", message: "b" });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "invalid_arguments");
  assert.equal(envelope.error.details.errors[0].rule, "alias_conflict");
  envelope = await registry.invoke("echo", { body: "same", message: "same" });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.warnings.length, 1);
  // A required canonical argument missing (and no alias) is invalid_arguments.
  envelope = await registry.invoke("echo", {});
  assert.equal(envelope.error.code, "invalid_arguments");
  assert.deepEqual(envelope.error.details.errors.map((e) => [e.path, e.rule]), [["message", "required"]]);
}

// T-3.1 / R3.12: unknown properties, wrong types, and out-of-range numbers
// are rejected with details.errors, never clamped.
{
  const cases = [
    [{ message: "x", bogus: 1 }, [["bogus", "additionalProperties"]]],
    [{ message: 5 }, [["message", "type"]]],
    [{ message: "x", limit: 0 }, [["limit", "range"]]],
    [{ message: "x", limit: 201 }, [["limit", "range"]]],
    [{ message: "x", limit: 2.5 }, [["limit", "type"]]],
    [{ message: "x", count: -1 }, [["count", "range"]]],
    [{ message: "x", receipt: { record: "yes" } }, [["receipt.record", "type"]]],
    [{ message: "x", receipt: { extra: true } }, [["receipt.extra", "additionalProperties"]]],
    [{ message: "x", receipt: { tags: ["ok", 3] } }, [["receipt.tags[1]", "type"]]]
  ];
  for (const [args, expected] of cases) {
    const result = await registry.callTool("echo", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(result.structuredContent.error.code, "invalid_arguments");
    assert.deepEqual(result.structuredContent.error.details.errors.map((e) => [e.path, e.rule]), expected, JSON.stringify(args));
  }
  const ok = await registry.callTool("echo", { message: "x", limit: 200, count: 0 });
  assert.equal(ok.isError, false);
  const nonObject = await registry.callTool("echo", "string");
  assert.equal(nonObject.structuredContent.error.code, "invalid_arguments");
}

// Failure envelopes: AgentLinkError keeps code, details and hint; unknown
// exceptions are internal_error with only the class name; unknown tools are
// unknown_tool.
{
  let result = await registry.callTool("fail", { kind: "known" });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    ok: false,
    error: { code: "not_found", message: "No such thing.", details: { query: "x", candidates: [] }, hint: "Look elsewhere." }
  });
  result = await registry.callTool("fail", { kind: "bug" });
  assert.deepEqual(result.structuredContent.error, {
    code: "internal_error",
    message: "Agent Link hit an internal error.",
    details: { cause: "TypeError" },
    hint: "fallback hint"
  });
  assert.ok(!result.content[0].text.includes("secret internal detail"), "no raw exception text");
  assert.ok(!result.content[0].text.includes("at "), "no stack");
  result = await registry.callTool("nope", {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "unknown_tool");
  assert.equal(result.structuredContent.error.details.name, "nope");
}

// A payload key the output schema does not declare is dropped from
// structuredContent (so validating clients accept it) and kept in the text;
// strictOutput turns it into a thrown error for tests.
{
  const result = await registry.callTool("fail", { kind: "undeclared" });
  assert.deepEqual(result.structuredContent, { ok: true, fine: true });
  assert.equal(JSON.parse(result.content[0].text).surprise, 1);
  const strict = createRegistry([failing], { strictOutput: true });
  await assert.rejects(strict.callTool("fail", { kind: "undeclared" }), /undeclared output keys: surprise/);
}

// applyAliases is usable by handlers called directly (tests, other modules).
{
  const warnings = [];
  assert.deepEqual(applyAliases(echo.definition, { body: "x" }, warnings), { message: "x" });
  assert.equal(warnings.length, 1);
  assert.deepEqual(applyAliases(echo.definition, { message: "y" }, []), { message: "y" });
}

// The validator handles oneOf and type lists.
{
  const schema = { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };
  assert.deepEqual(validateSchema(schema, "a"), []);
  assert.deepEqual(validateSchema(schema, ["a"]), []);
  assert.equal(validateSchema(schema, 1)[0].rule, "oneOf");
  assert.deepEqual(validateSchema({ type: ["string", "integer"] }, 3), []);
  assert.equal(validateSchema({ type: ["string", "integer"] }, 3.5)[0].rule, "type");
}

console.log("registry tests passed");
