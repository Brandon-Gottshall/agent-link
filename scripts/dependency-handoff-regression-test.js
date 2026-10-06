#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  checkCoordinationObligations,
  registerDependencyHandoff
} from "../src/codex/dependency-handoff.js";

const originThreadId = "4ae1fe3d-348d-7ffb-817f-90976bd28f4d";
const targetThreadId = "4ae1fe3d-c38c-7aa5-a89c-60a317316954";
const dependencyText = `Use the surface from ${targetThreadId} when ready.`;

const emptyDeps = {
  listReceipts: async () => ({
    ok: true,
    path: "/tmp/agent-link-receipts.jsonl",
    data: [],
    scannedReceipts: 0
  })
};

const needsHandoff = await checkCoordinationObligations({
  text: dependencyText,
  originThreadId
}, emptyDeps);
assert.equal(needsHandoff.status, "needs_handoff");
assert.equal(needsHandoff.ok, false);
assert.deepEqual(needsHandoff.analysis.referencedThreadIds, [targetThreadId]);

const calls = [];
const registerDeps = {
  readThread: async (threadId) => ({
    ok: true,
    source: "mock",
    thread: {
      id: threadId,
      name: "Add snoozable full-screen alerts",
      status: { type: "idle" }
    }
  }),
  messageThread: async (args) => {
    calls.push(args);
    return {
      ok: true,
      threadId: args.threadId,
      receipt: {
        recorded: true,
        id: "agent-link-receipt-test"
      }
    };
  }
};

const registered = await registerDependencyHandoff({
  targetThreadId,
  dependencyName: "Snoozable full-screen Auditions alert surface",
  readinessContract: "ready when implemented, built, installed if applicable, and callable by the Outlook alert automation",
  callbackThreadId: originThreadId,
  evidenceRequirements: ["command or API shape", "verification evidence"]
}, registerDeps, {
  callerContext: {
    available: true,
    threadId: originThreadId
  }
});
assert.equal(registered.ok, true);
assert.equal(registered.target.threadId, targetThreadId);
assert.equal(calls.length, 1);
assert.equal(calls[0].threadId, targetThreadId);
assert.match(calls[0].message, /Dependency callback request/);
assert.match(calls[0].message, new RegExp(originThreadId));
assert.deepEqual(calls[0].receipt.tags, [
  "dependency-handoff",
  "dependency:snoozable-full-screen-auditions-alert-surface",
  `callback:${originThreadId}`
]);

const satisfiedDeps = {
  listReceipts: async () => ({
    ok: true,
    path: "/tmp/agent-link-receipts.jsonl",
    scannedReceipts: 1,
    data: [
      {
        id: "agent-link-receipt-test",
        action: "message_thread",
        purpose: "Dependency handoff: Snoozable full-screen Auditions alert surface",
        origin: { threadId: originThreadId },
        target: { threadId: targetThreadId },
        messagePreview: calls[0].message,
        delivery: { state: "accepted_by_app_server" }
      }
    ]
  })
};

const satisfied = await checkCoordinationObligations({
  text: dependencyText,
  originThreadId
}, satisfiedDeps);
assert.equal(satisfied.status, "satisfied");
assert.equal(satisfied.ok, true);
assert.equal(satisfied.receipts.matchingCount, 1);

const notApplicable = await checkCoordinationObligations({
  text: "Implemented the local parser and ran the tests.",
  originThreadId
}, emptyDeps);
assert.equal(notApplicable.status, "not_applicable");
assert.equal(notApplicable.ok, true);

console.log("Dependency handoff regression test passed");
