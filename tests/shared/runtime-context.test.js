// tests/shared/runtime-context.test.js
//
// Defensive coverage for `summarizeRuntimeCallerContext`. The function is
// called from both the receipt-index normalization path and the server's
// health/handler bookkeeping; if any caller passes `null` (e.g. a code path
// that hasn't been wired through `extractRuntimeCallerContext` yet), the
// summary must degrade gracefully instead of throwing.
//
// Phase 8 review locked this with a one-line regression case.

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

console.log("runtime-context tests passed");
