import assert from "node:assert/strict";
import test from "node:test";
import { AgentLinkError, ERROR_CODES, errorCodeOf, isErrorCode, toErrorPayload } from "../../src/shared/errors.js";
import { AppServerError } from "../../src/codex/app-server-client.js";

test("ERROR_CODES is the section 3.2 list", () => {
  assert.deepEqual([...ERROR_CODES], [
    "invalid_arguments", "unknown_tool", "not_found", "ambiguous", "archived", "wrong_recipient",
    "no_current_session", "body_too_large", "permission_denied", "active_turn_conflict",
    "codex_unavailable", "claude_unavailable", "upstream_error", "unsupported", "state_io_error",
    "internal_error"
  ]);
  assert.ok(Object.isFrozen(ERROR_CODES));
  assert.equal(isErrorCode("not_found"), true);
  assert.equal(isErrorCode("nope"), false);
  assert.equal(isErrorCode(undefined), false);
});

test("AgentLinkError carries code, message, details, hint, cause", () => {
  const cause = new Error("disk");
  const error = new AgentLinkError("not_found", "No session 'abc'.", {
    details: { query: "abc", candidates: [] },
    hint: "Call list_agents.",
    cause
  });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "AgentLinkError");
  assert.equal(error.code, "not_found");
  assert.equal(error.errorCode, "not_found");
  assert.equal(error.message, "No session 'abc'.");
  assert.deepEqual(error.details, { query: "abc", candidates: [] });
  assert.equal(error.hint, "Call list_agents.");
  assert.equal(error.cause, cause);
});

test("AgentLinkError defaults: details and hint null, no cause", () => {
  const error = new AgentLinkError("internal_error", "x");
  assert.equal(error.details, null);
  assert.equal(error.hint, null);
  assert.equal("cause" in error, false);
});

test("AgentLinkError rejects unknown codes", () => {
  assert.throws(() => new AgentLinkError(/** @type {any} */ ("made_up"), "x"), TypeError);
});

test("AppServerError extends AgentLinkError and keeps its legacy fields", () => {
  const details = { method: "thread/read", code: "open-failed" };
  const transport = new AppServerError("socket closed", details);
  assert.ok(transport instanceof AgentLinkError);
  assert.ok(transport instanceof Error);
  assert.equal(transport.name, "AppServerError");
  assert.equal(transport.message, "socket closed");
  assert.equal(transport.details, details);
  assert.equal(transport.code, "open-failed");
  assert.equal(transport.errorCode, "codex_unavailable");

  const rpc = new AppServerError("thread not found", { method: "thread/read", code: -32600 });
  assert.equal(rpc.code, -32600);
  assert.equal(rpc.errorCode, "upstream_error");

  const bare = new AppServerError("boom");
  assert.deepEqual(bare.details, {});
  assert.equal(bare.code, null);
  assert.equal(bare.errorCode, "codex_unavailable");
});

test("errorCodeOf maps anything else to internal_error", () => {
  assert.equal(errorCodeOf(new AgentLinkError("ambiguous", "x")), "ambiguous");
  assert.equal(errorCodeOf(new AppServerError("x", { code: 5 })), "upstream_error");
  assert.equal(errorCodeOf(new TypeError("x")), "internal_error");
  assert.equal(errorCodeOf("string"), "internal_error");
  assert.equal(errorCodeOf(null), "internal_error");
});

test("toErrorPayload builds the envelope error and hides unknown exceptions", () => {
  assert.deepEqual(
    toErrorPayload(new AgentLinkError("body_too_large", "too big", { details: { limitBytes: 1, actualBytes: 2 }, hint: "shorten" })),
    { code: "body_too_large", message: "too big", details: { limitBytes: 1, actualBytes: 2 }, hint: "shorten" }
  );
  assert.deepEqual(toErrorPayload(new AgentLinkError("not_found", "gone", { details: {} })), { code: "not_found", message: "gone" });
  const secret = new RangeError("/private/path leaked");
  assert.deepEqual(toErrorPayload(secret), {
    code: "internal_error",
    message: "Agent Link hit an internal error.",
    details: { cause: "RangeError" }
  });
  assert.deepEqual(toErrorPayload("oops").details, { cause: "string" });
});
