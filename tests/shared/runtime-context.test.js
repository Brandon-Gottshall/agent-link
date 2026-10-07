// tests/shared/runtime-context.test.js
//
// Defensive coverage for `summarizeRuntimeCallerContext`. The function is
// called from both the receipt-index normalization path and the server's
// health/handler bookkeeping; if any caller passes `null` (e.g. a code path
// that hasn't been wired through `extractRuntimeCallerContext` yet), the
// summary must degrade gracefully instead of throwing.
//
// Phase 8 review locked this with a one-line regression case.

// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { summarizeRuntimeCallerContext } from "../../src/shared/caller-context.js";

// Defensive: explicit null does not crash and returns available=false.
{
  const summary = summarizeRuntimeCallerContext(null);
  assert.equal(summary.available, false);
  assert.equal(summary.threadId, null);
  assert.equal(summary.turnId, null);
  assert.equal(summary.toolCallId, null);
  assert.equal(summary.source, "not_supplied");
  assert.deepEqual(summary.metaKeys.requestParams, []);
  assert.deepEqual(summary.metaKeys.extra, []);
}

// Defensive: explicit undefined behaves the same as null.
{
  const summary = summarizeRuntimeCallerContext(undefined);
  assert.equal(summary.available, false);
  assert.equal(summary.source, "not_supplied");
}

// Sanity: a populated context round-trips its identifying fields.
{
  const summary = summarizeRuntimeCallerContext({
    available: true,
    threadId: "019df300-0000-7000-8000-codex-caller",
    turnId: "019df300-0000-7000-8000-codex-turn",
    toolCallId: "call_codex_caller",
    source: "runtime_context",
    sources: { threadId: { source: "request.params._meta", path: "threadId" } },
    requestId: "req-1",
    sessionId: null,
    metaKeys: { requestParams: ["threadId"], extra: [] }
  });
  assert.equal(summary.available, true);
  assert.equal(summary.threadId, "019df300-0000-7000-8000-codex-caller");
  assert.equal(summary.turnId, "019df300-0000-7000-8000-codex-turn");
  assert.equal(summary.toolCallId, "call_codex_caller");
  assert.equal(summary.source, "runtime_context");
  assert.equal(summary.requestId, "req-1");
  assert.deepEqual(summary.metaKeys.requestParams, ["threadId"]);
}

// P4-08: caller context comes from an explicit allowlist of exact keys and
// paths. These shapes used to be misclassified by fuzzy key matching.
{
  const { extractRuntimeCallerContext } = await import("../../src/shared/caller-context.js");
  const extract = (meta) => extractRuntimeCallerContext({ params: { _meta: meta } }, {});

  // A turn id nested under `thread` is not the thread id.
  let ctx = extract({ thread: { turnId: "turn-1" } });
  assert.equal(ctx.threadId, null, "{thread:{turnId}} must not become the threadId");

  // Look-alike keys are not accepted.
  ctx = extract({ conversationId: "conv-1", sourceThreadId: "src-1", threadsId: "x", requestThreadId: "r" });
  assert.equal(ctx.threadId, null);
  ctx = extract({ toolCall: { threadId: "t" }, toolcallsid: "c" });
  assert.equal(ctx.toolCallId, null, "{toolCall:{threadId}} must not become the toolCallId");
  assert.equal(ctx.threadId, null);
  ctx = extract({ returnId: "r", stateId: "s" });
  assert.equal(ctx.turnId, null);
  assert.equal(ctx.available, false);

  // Accepted shapes still work.
  ctx = extract({ "openai/codex": { caller: { thread: { id: "T1" }, turn: { id: "U1" } }, toolCallId: "C1" } });
  assert.deepEqual([ctx.threadId, ctx.turnId, ctx.toolCallId], ["T1", "U1", "C1"]);
  assert.equal(ctx.sources.threadId.path, "openai/codex.caller.thread.id");
  ctx = extract({ "openai/codex": { callerThreadId: "T2", callerTurnId: "U2", callerToolCallId: "C2" } });
  assert.deepEqual([ctx.threadId, ctx.turnId, ctx.toolCallId], ["T2", "U2", "C2"]);
  ctx = extract({ thread_id: "T3", turn_id: "U3", tool_call_id: "C3" });
  assert.deepEqual([ctx.threadId, ctx.turnId, ctx.toolCallId], ["T3", "U3", "C3"]);

  // Defined priority: an explicit caller id beats a generic or origin id,
  // wherever the keys appear.
  ctx = extract({ originThreadId: "origin", threadId: "generic", "openai/codex": { callerThreadId: "caller" } });
  assert.equal(ctx.threadId, "caller");
  ctx = extract({ originThreadId: "origin", threadId: "generic" });
  assert.equal(ctx.threadId, "generic");

  // toolUseId (Claude Code) is accepted as the tool call id.
  ctx = extract({ "claudecode/toolUseId": "toolu_01ABC" });
  assert.equal(ctx.toolCallId, "toolu_01ABC");
  assert.equal(ctx.threadId, null);
  ctx = extract({ toolUseId: "toolu_02" });
  assert.equal(ctx.toolCallId, "toolu_02");

  // request params win over handler extra.
  ctx = extractRuntimeCallerContext({ params: { _meta: { threadId: "req" } } }, { _meta: { threadId: "extra" } });
  assert.equal(ctx.threadId, "req");
  ctx = extractRuntimeCallerContext({ params: {} }, { _meta: { threadId: "extra" } });
  assert.equal(ctx.threadId, "extra");
  assert.equal(ctx.source, "handler.extra._meta");
}

console.log("runtime-context tests passed");
