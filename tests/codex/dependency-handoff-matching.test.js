import assert from "node:assert/strict";
import test from "node:test";

import {
  COORDINATION_PATTERNS,
  OBLIGATION_THRESHOLD,
  analyzeCoordinationText,
  checkCoordinationObligations,
  registerDependencyHandoff
} from "../../src/codex/dependency-handoff.js";
import { FORWARDED_MESSAGE_OPTION_KEYS } from "../../src/codex/project-orchestrator.js";
import { receiptSummary } from "../../src/shared/receipt-index.js";
import { THREAD_A, THREAD_B, negative, positive } from "../fixtures/coordination-corpus.js";

const ORIGIN = "99999999-8888-4777-8666-555555555555";
const OTHER_ORIGIN = "12121212-3434-4565-8787-909090909090";

test("corpus is large enough", () => {
  assert.ok(positive.length >= 30, `positives: ${positive.length}`);
  assert.ok(negative.length >= 30, `negatives: ${negative.length}`);
});

for (const [index, sentence] of positive.entries()) {
  test(`positive ${index + 1}: ${sentence}`, () => {
    const analysis = analyzeCoordinationText(sentence);
    assert.equal(analysis.hasObligation, true, JSON.stringify(analysis.matches));
    assert.ok(analysis.score >= OBLIGATION_THRESHOLD);
  });
}

for (const [index, sentence] of negative.entries()) {
  test(`negative ${index + 1}: ${sentence}`, () => {
    const analysis = analyzeCoordinationText(sentence);
    assert.equal(analysis.hasObligation, false, JSON.stringify(analysis.matches));
    assert.ok(analysis.score < OBLIGATION_THRESHOLD);
  });
}

test("pattern table entries are well formed", () => {
  const ids = new Set();
  for (const pattern of COORDINATION_PATTERNS) {
    assert.ok(!ids.has(pattern.id), `duplicate id ${pattern.id}`);
    ids.add(pattern.id);
    assert.ok(pattern.category, pattern.id);
    assert.ok(pattern.weight > 0 && pattern.weight <= 1, pattern.id);
    assert.ok(pattern.re instanceof RegExp, pattern.id);
    assert.ok(!pattern.re.global && !pattern.re.sticky, `${pattern.id} must be stateless`);
  }
});

test("bare words no longer trigger an obligation on their own", () => {
  for (const word of ["callback", "handoff", "return path", "another thread", "owner thread", "depends on", "waiting on"]) {
    assert.equal(analyzeCoordinationText(`Note: ${word}.`).hasObligation, false, word);
  }
});

test("a thread id alone is a signal, not an obligation", () => {
  const analysis = analyzeCoordinationText(`Summarized the notes from ${THREAD_A}.`);
  assert.deepEqual(analysis.referencedThreadIds, [THREAD_A]);
  assert.equal(analysis.hasObligation, false);
});

test("the origin thread's own id is not a referenced thread", () => {
  const analysis = analyzeCoordinationText(`Thread ${ORIGIN} is blocked on the schema agent.`, { originThreadId: ORIGIN });
  assert.deepEqual(analysis.referencedThreadIds, []);
  assert.equal(analysis.hasObligation, true);
});

test("analysis reports score, categories, and matched pattern ids", () => {
  const analysis = analyzeCoordinationText("Waiting on another agent to expose the search endpoint.");
  assert.equal(analysis.threshold, OBLIGATION_THRESHOLD);
  assert.equal(analysis.categories["blocked-on"], 0.6);
  assert.equal(analysis.categories["explicit-thread-reference"], 0.5);
  assert.equal(analysis.score, 1.1);
  assert.ok(analysis.matchedPhrases.includes("waiting-on"));
  assert.ok(analysis.matches.every((match) => typeof match.excerpt === "string"));
});

test("patterns stay fast on long adversarial input", () => {
  const inputs = [
    `when ${"word ".repeat(20000)}`,
    `can't ${"a ".repeat(20000)}until`,
    `register a callback with ${"x ".repeat(20000)}`,
    `${"another ".repeat(20000)}thread`,
    `${"the-".repeat(20000)} agent`,
    `pending ${"x ".repeat(20000)}`,
    "'".repeat(50000)
  ];
  for (const input of inputs) {
    const started = process.hrtime.bigint();
    analyzeCoordinationText(input);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 500, `took ${ms.toFixed(1)} ms on ${input.slice(0, 30)}...`);
  }
});

// ---- Satisfaction rule ----

function handoffReceipt(overrides = {}) {
  return {
    id: overrides.id ?? "agent-link-receipt-1",
    createdAt: overrides.createdAt ?? "2026-01-02T03:04:05.000Z",
    action: "message_thread",
    purpose: "Dependency handoff: Search endpoint",
    tags: overrides.tags ?? ["dependency-handoff", "dependency:search-endpoint", `callback:${ORIGIN}`],
    origin: { threadId: overrides.originThreadId ?? ORIGIN, turnId: overrides.originTurnId ?? "turn-1" },
    target: { threadId: overrides.targetThreadId ?? THREAD_A },
    messagePreview: overrides.messagePreview ?? "Dependency callback request"
  };
}

function receiptsDeps(data) {
  const calls = [];
  return {
    calls,
    listReceipts: async (options) => {
      calls.push(options);
      return { ok: true, path: "/dev/null", scannedReceipts: data.length, data };
    }
  };
}

const NAMED = `Waiting on ${THREAD_A} to expose the search endpoint.`;
const UNNAMED = "Waiting on the search agent to expose the endpoint.";

test("named thread: a handoff receipt targeting it satisfies", async () => {
  const deps = receiptsDeps([handoffReceipt()]);
  const result = await checkCoordinationObligations({ text: NAMED, originThreadId: ORIGIN }, deps);
  assert.equal(result.status, "satisfied");
  assert.equal(result.satisfaction.rule, "target_in_referenced_thread_ids");
  assert.deepEqual(result.satisfaction.targetThreadIds, [THREAD_A]);
  assert.deepEqual(deps.calls[0], { originThreadId: ORIGIN, action: "message_thread", searchTerm: "dependency-handoff", limit: 20 });
});

test("named thread: ids match case-insensitively", async () => {
  const deps = receiptsDeps([handoffReceipt({ targetThreadId: THREAD_B.toUpperCase() })]);
  const result = await checkCoordinationObligations({ text: `Blocked on ${THREAD_B}.`, originThreadId: ORIGIN }, deps);
  assert.equal(result.status, "satisfied");
});

test("named thread: a handoff to a different thread does not satisfy", async () => {
  const deps = receiptsDeps([handoffReceipt({ targetThreadId: THREAD_B })]);
  const result = await checkCoordinationObligations({ text: NAMED, originThreadId: ORIGIN }, deps);
  assert.equal(result.status, "needs_handoff");
  assert.equal(result.ok, false);
});

test("named thread: mentioning the id in the message body is not enough", async () => {
  const deps = receiptsDeps([handoffReceipt({ targetThreadId: THREAD_B, messagePreview: `see ${THREAD_A}` })]);
  const result = await checkCoordinationObligations({ text: NAMED, originThreadId: ORIGIN }, deps);
  assert.equal(result.status, "needs_handoff");
});

test("a receipt without the dependency-handoff tag never satisfies", async () => {
  const deps = receiptsDeps([handoffReceipt({ tags: ["unrelated"], messagePreview: "mentions dependency-handoff in text" })]);
  const result = await checkCoordinationObligations({ text: NAMED, originThreadId: ORIGIN }, deps);
  assert.equal(result.status, "needs_handoff");
});

test("a receipt from another origin thread never satisfies", async () => {
  const deps = receiptsDeps([handoffReceipt({ originThreadId: OTHER_ORIGIN })]);
  const result = await checkCoordinationObligations({ text: NAMED, originThreadId: ORIGIN }, deps);
  assert.equal(result.status, "needs_handoff");
});

test("unnamed thread without any scope: no receipt satisfies", async () => {
  const deps = receiptsDeps([handoffReceipt()]);
  const result = await checkCoordinationObligations({ text: UNNAMED, originThreadId: ORIGIN }, deps);
  assert.equal(result.status, "needs_handoff");
  assert.equal(result.satisfaction.rule, "unscoped");
  assert.match(result.nextRequiredAction, /dependencyName/);
});

test("unnamed thread: a matching dependency tag satisfies, a different one does not", async () => {
  const deps = receiptsDeps([handoffReceipt()]);
  const hit = await checkCoordinationObligations({ text: UNNAMED, originThreadId: ORIGIN, dependencyName: "Search endpoint" }, deps);
  assert.equal(hit.status, "satisfied");
  assert.equal(hit.satisfaction.rule, "dependency_tag_or_same_turn_or_since");
  assert.equal(hit.satisfaction.dependencyTag, "dependency:search-endpoint");
  const miss = await checkCoordinationObligations({ text: UNNAMED, originThreadId: ORIGIN, dependencyName: "Billing export" }, deps);
  assert.equal(miss.status, "needs_handoff");
});

test("unnamed thread: a receipt from the caller's current turn satisfies", async () => {
  const deps = receiptsDeps([handoffReceipt({ originTurnId: "turn-7" })]);
  const context = (turnId) => ({ callerContext: { available: true, threadId: ORIGIN, turnId } });
  const hit = await checkCoordinationObligations({ text: UNNAMED }, deps, context("turn-7"));
  assert.equal(hit.status, "satisfied");
  assert.equal(hit.originThreadId, ORIGIN);
  const miss = await checkCoordinationObligations({ text: UNNAMED }, deps, context("turn-8"));
  assert.equal(miss.status, "needs_handoff");
  const explicit = await checkCoordinationObligations({ text: UNNAMED, originTurnId: "turn-7" }, deps, context("turn-8"));
  assert.equal(explicit.status, "satisfied");
});

test("unnamed thread: since selects receipts created at or after it", async () => {
  const deps = receiptsDeps([handoffReceipt({ createdAt: "2026-01-02T03:04:05.000Z" })]);
  const hit = await checkCoordinationObligations({ text: UNNAMED, originThreadId: ORIGIN, since: "2026-01-02T03:04:05.000Z" }, deps);
  assert.equal(hit.status, "satisfied");
  const miss = await checkCoordinationObligations({ text: UNNAMED, originThreadId: ORIGIN, since: "2026-01-02T03:04:06.000Z" }, deps);
  assert.equal(miss.status, "needs_handoff");
  await assert.rejects(
    checkCoordinationObligations({ text: UNNAMED, originThreadId: ORIGIN, since: "yesterday-ish" }, deps),
    /since must be an ISO-8601 timestamp/
  );
});

test("text below the threshold is not_applicable and reads no receipts", async () => {
  const deps = receiptsDeps([handoffReceipt()]);
  const result = await checkCoordinationObligations({ text: "The callback function returns a promise.", originThreadId: ORIGIN }, deps);
  assert.equal(result.status, "not_applicable");
  assert.equal(deps.calls.length, 0);
});

test("receipt summaries carry tags so the satisfaction rule can see them", () => {
  const summary = receiptSummary({ id: "r", tags: ["dependency-handoff", "dependency:x"] });
  assert.deepEqual(summary.tags, ["dependency-handoff", "dependency:x"]);
  assert.deepEqual(receiptSummary({ id: "r" }).tags, []);
});

// ---- Forwarded options ----

test("register_dependency_handoff forwards the shared allowlist and never cwd", async () => {
  const calls = [];
  const resolveCalls = [];
  const deps = {
    resolveThread: async (resolveArgs) => {
      resolveCalls.push(resolveArgs);
      return { source: "mock", best: { id: THREAD_A }, selection: { ambiguous: false } };
    },
    messageThread: async (messageArgs) => {
      calls.push(messageArgs);
      return { ok: true };
    }
  };
  const forwarded = {
    mode: "start_turn",
    resumeIfNeeded: true,
    expectedTurnId: "turn-x",
    model: "model-x",
    effort: "low",
    allowParallelTurn: true,
    allowTargetOverride: true,
    waitForReply: true,
    timeoutMs: 1000,
    pollIntervalMs: 50,
    recentItems: 3
  };
  assert.deepEqual(Object.keys(forwarded).sort(), [...FORWARDED_MESSAGE_OPTION_KEYS].sort());
  await registerDependencyHandoff({
    targetQuery: "search agent",
    cwd: "/some/project",
    dependencyName: "Search endpoint",
    readinessContract: "ready when callable",
    ...forwarded
  }, deps, { callerContext: { available: true, threadId: ORIGIN } });
  assert.equal(resolveCalls[0].cwd, "/some/project", "cwd still filters target resolution");
  assert.equal(calls.length, 1);
  assert.equal("cwd" in calls[0], false, "cwd is not forwarded as a turn override");
  for (const [key, value] of Object.entries(forwarded)) {
    assert.equal(calls[0][key], value, key);
  }
  assert.deepEqual(
    Object.keys(calls[0]).sort(),
    [...FORWARDED_MESSAGE_OPTION_KEYS, "threadId", "message", "receipt"].sort()
  );

  calls.length = 0;
  await registerDependencyHandoff({
    targetThreadId: THREAD_A,
    dependencyName: "Search endpoint",
    readinessContract: "ready when callable"
  }, { ...deps, readThread: async () => ({ source: "mock", thread: null }) }, { callerContext: { available: true, threadId: ORIGIN } });
  assert.deepEqual(Object.keys(calls[0]).sort(), ["message", "receipt", "threadId"], "unset options are not sent as undefined");
});
