// Registry unit tests (design doc section 3): one list drives tools/list and
// tools/call, schema validation rejects unknown and out-of-range arguments,
// arguments removed in 0.6.0 are rejected with a hint naming their
// replacement, and every result is the section 3.1 envelope.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { AgentLinkError } from "../../src/shared/errors.js";
import { createRegistry, removedArgumentHint, toMcpTool } from "../../src/server/registry.js";
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
      required: ["message"],
      additionalProperties: false
    },
    removedArguments: [
      { name: "body", replacement: "message" },
      { name: "count", rule: "type", replacement: "count as an integer", hint: "count as a word was removed in 0.6.0; pass an integer." }
    ],
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

// tools/list: derived from the same entries, with the envelope output schema
// and openWorldHint:false by default. Removed arguments are not listed.
{
  const tools = registry.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["echo", "fail"]);
  const tool = tools[0];
  assert.equal(tool.inputSchema.properties.body, undefined, "a removed argument is not an input property");
  assert.equal(Object.values(tool.inputSchema.properties).some((p) => p.deprecated), false);
  assert.deepEqual(tool.annotations, { openWorldHint: false, readOnlyHint: true });
  assert.equal(tool.outputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.outputSchema.properties), ["ok", "error", "warnings", "echoed"]);
  assert.deepEqual(registry.names(), ["echo", "fail"]);
  assert.ok(registry.has("echo") && !registry.has("nope"));
  assert.throws(() => createRegistry([echo, echo]), /Duplicate tool definition: echo/);
  assert.equal(toMcpTool(echo.definition).inputSchema.properties.body, undefined);
}

// Success envelope: ok:true, payload keys, the handler's own `ok` ignored,
// warnings omitted when empty.
{
  const result = await registry.callTool("echo", { message: "hi" });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, { ok: true, echoed: { message: "hi" } });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
}

// Handler warnings land in warnings[].
{
  const envelope = await registry.invoke("echo", { message: "warn" });
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.warnings.map((w) => w.code), ["custom"]);
}

// 0.6.0 (R6.1-R6.4): a removed alias is an unknown property, rejected with
// invalid_arguments and a hint naming the replacement; it is never renamed.
{
  let envelope = await registry.invoke("echo", { body: "a" });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "invalid_arguments");
  assert.deepEqual(envelope.error.details.errors.map((e) => [e.path, e.rule]).sort(), [["body", "additionalProperties"], ["message", "required"]]);
  assert.equal(envelope.error.hint, "body was removed in 0.6.0; use message.");
  assert.deepEqual(envelope.error.details.removed, [{ argument: "body", replacement: "message" }]);
  envelope = await registry.invoke("echo", { body: "same", message: "same" });
  assert.equal(envelope.error.code, "invalid_arguments", "a removed alias is rejected even beside its replacement");
  assert.equal(envelope.error.hint, "body was removed in 0.6.0; use message.");
  // A rule-scoped entry (a removed value form) uses its own hint text.
  envelope = await registry.invoke("echo", { message: "x", count: "three" });
  assert.equal(envelope.error.hint, "count as a word was removed in 0.6.0; pass an integer.");
  // A failure that matches no entry keeps the generic error (the fallback hint).
  envelope = await registry.invoke("echo", { message: "x", bogus: 1 });
  assert.equal(envelope.error.hint, "fallback hint");
  assert.equal(envelope.error.details.removed, undefined);
  // A required argument missing is invalid_arguments.
  envelope = await registry.invoke("echo", {});
  assert.equal(envelope.error.code, "invalid_arguments");
  assert.deepEqual(envelope.error.details.errors.map((e) => [e.path, e.rule]), [["message", "required"]]);
  assert.equal(removedArgumentHint(echo.definition, [{ path: "message", rule: "required", expected: "" }]), null);
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

// Review I1: null for an optional property is dropped before validation and
// before the handler; exact-format scalar strings are coerced with a
// coerced_argument warning; everything else of the wrong type is rejected.
{
  let envelope = await registry.invoke("echo", { message: "x", limit: null, count: null, receipt: null });
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.deepEqual(envelope.echoed, { message: "x" }, "nulls never reach the handler");
  assert.equal(envelope.warnings, undefined);
  envelope = await registry.invoke("echo", { message: "x", receipt: { purpose: null, record: "false", tags: ["a"] } });
  assert.deepEqual(envelope.echoed.receipt, { record: false, tags: ["a"] });
  assert.deepEqual(envelope.warnings.map((w) => [w.code, w.path]), [["coerced_argument", "receipt.record"]]);
  envelope = await registry.invoke("echo", { message: "x", count: "6" });
  assert.deepEqual(envelope.error.details.errors.map((e) => [e.path, e.rule]), [["count", "range"]], "coerced values are still range-checked");
  envelope = await registry.invoke("echo", { message: "x", limit: "7" });
  assert.deepEqual(envelope.echoed, { message: "x", limit: 7 });
  for (const bad of [{ limit: "7.0" }, { limit: "seven" }, { limit: "" }, { limit: "0" }, { limit: true }, { receipt: { record: "TRUE" } }, { receipt: { record: 1 } }]) {
    envelope = await registry.invoke("echo", { message: "x", ...bad });
    assert.equal(envelope.error?.code, "invalid_arguments", JSON.stringify(bad));
  }
  // A required argument given as null is not dropped.
  envelope = await registry.invoke("echo", { message: null });
  assert.equal(envelope.error.code, "invalid_arguments");
  // A string property is never coerced.
  envelope = await registry.invoke("echo", { message: "5" });
  assert.deepEqual(envelope.echoed, { message: "5" });
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
