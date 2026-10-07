// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  clampInt,
  cleanString,
  intInRange,
  normalizeStringList,
  optionalString,
  requiredString,
  resolveAlias
} from "../../src/shared/args.js";
import { AgentLinkError } from "../../src/shared/errors.js";

/** @param {() => unknown} fn */
function invalid(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AgentLinkError, "throws AgentLinkError");
    assert.equal(error.code, "invalid_arguments");
    return error;
  }
  assert.fail("expected invalid_arguments");
}

test("requiredString returns the untrimmed string and keeps the legacy message", () => {
  assert.equal(requiredString("  id ", "threadId"), "  id ");
  for (const bad of [undefined, null, "", "   ", 5, {}]) {
    const error = invalid(() => requiredString(bad, "threadId"));
    assert.equal(error.message, "threadId is required");
    assert.equal(error.details, null, "details stay null so the legacy catch still prints details:null");
  }
});

test("optionalString and cleanString", () => {
  assert.equal(optionalString(" a "), " a ");
  assert.equal(optionalString(3), "");
  assert.equal(optionalString(undefined), "");
  assert.equal(cleanString(" a "), "a");
  assert.equal(cleanString(null), "");
  assert.equal(cleanString(["a"]), "");
});

test("clampInt keeps the lenient legacy behavior", () => {
  assert.equal(clampInt(5.9, 1, 10), 5);
  assert.equal(clampInt("7", 1, 10), 7);
  assert.equal(clampInt(0, 1, 10), 1);
  assert.equal(clampInt(99, 1, 10), 10);
  assert.equal(clampInt("abc", 1, 10), 1);
  assert.equal(clampInt(undefined, 1, 10), 1);
  assert.equal(clampInt(Infinity, 1, 10), 1);
  assert.equal(clampInt(-3.5, -10, 10), -4);
});

test("normalizeStringList", () => {
  assert.deepEqual(normalizeStringList(undefined), []);
  assert.deepEqual(normalizeStringList(null), []);
  assert.deepEqual(normalizeStringList(" a "), ["a"]);
  assert.deepEqual(normalizeStringList("  "), []);
  assert.deepEqual(normalizeStringList([" a", "", 3, "b ", null]), ["a", "b"]);
  assert.deepEqual(normalizeStringList(5), []);
});

test("intInRange accepts in-range integers and applies the default", () => {
  const range = { name: "limit", min: 1, max: 200, default: 20 };
  assert.equal(intInRange(undefined, range), 20);
  assert.equal(intInRange(null, range), 20);
  assert.equal(intInRange(1, range), 1);
  assert.equal(intInRange(200, range), 200);
  assert.equal(intInRange(0, { name: "receiptLimit", min: 0, max: 100, default: 10 }), 0);
});

test("intInRange rejects instead of clamping", () => {
  const range = { name: "limit", min: 1, max: 200, default: 20 };
  const high = invalid(() => intInRange(201, range));
  assert.equal(high.message, "limit must be between 1 and 200");
  assert.deepEqual(high.details, { errors: [{ path: "limit", rule: "range", expected: "integer 1..200" }] });
  invalid(() => intInRange(0, range));
  const frac = invalid(() => intInRange(2.5, range));
  assert.deepEqual(frac.details.errors[0], { path: "limit", rule: "type", expected: "integer" });
  invalid(() => intInRange("5", range));
  invalid(() => intInRange(NaN, range));
  invalid(() => intInRange(Infinity, range));
  const missing = invalid(() => intInRange(undefined, { name: "timeoutMs", min: 0, max: 10 }));
  assert.equal(missing.details.errors[0].rule, "required");
});

test("resolveAlias: canonical only, no warnings", () => {
  assert.deepEqual(resolveAlias({ message: "hi" }, "message", ["body"]), { value: "hi", source: "message", warnings: [] });
});

test("resolveAlias: absent everywhere", () => {
  assert.deepEqual(resolveAlias({}, "message", ["body"]), { value: undefined, source: null, warnings: [] });
  assert.deepEqual(resolveAlias(undefined, "message", ["body"]), { value: undefined, source: null, warnings: [] });
  assert.deepEqual(resolveAlias({ body: undefined }, "message", ["body"]).warnings, []);
});

test("resolveAlias: alias alone supplies the value with a deprecation warning", () => {
  assert.deepEqual(resolveAlias({ body: "hi" }, "message", ["body"]), {
    value: "hi",
    source: "body",
    warnings: [{ code: "deprecated_argument", message: "body is deprecated; use message.", replacement: "message" }]
  });
});

test("resolveAlias: same value under both names warns but succeeds", () => {
  const result = resolveAlias({ message: "hi", body: "hi" }, "message", ["body"]);
  assert.equal(result.value, "hi");
  assert.equal(result.source, "message");
  assert.equal(result.warnings.length, 1);
  assert.equal(resolveAlias({ to: ["a"], query: ["a"] }, "query", ["to"]).value[0], "a");
});

test("resolveAlias: differing values are invalid_arguments", () => {
  const error = invalid(() => resolveAlias({ message: "a", body: "b" }, "message", ["body"]));
  assert.equal(error.message, "body conflicts with message; pass only message.");
  assert.deepEqual(error.details, { errors: [{ path: "body", rule: "alias_conflict", expected: "the same value as message" }] });
  // Two aliases that disagree with each other, canonical absent.
  const twoAliases = invalid(() => resolveAlias({ searchTerm: "x", q: "y" }, "query", ["searchTerm", "q"]));
  assert.equal(twoAliases.details.errors[0].path, "q");
});
