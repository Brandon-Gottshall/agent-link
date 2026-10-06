import assert from "node:assert/strict";
import { resolveSession } from "../../src/claude/session-resolver.js";

const SESSIONS = [
  { sessionId: "local_aaa1111", title: "Investigate game for subject adaptation", processName: "blissful-wonderful-goldberg", cwd: "/sessions/blissful-wonderful-goldberg", userSelectedFolders: ["/Users/example/courses"] },
  { sessionId: "local_bbb2222", title: "Refactor payment retry logic",            processName: "calm-electric-rabbit",         cwd: "/sessions/calm-electric-rabbit",          userSelectedFolders: ["/Users/example/work/payments"] },
  { sessionId: "local_ccc3333", title: "Investigate flaky tests",                  processName: "lazy-quiet-otter",             cwd: "/sessions/lazy-quiet-otter",              userSelectedFolders: [] }
];

// Exact ID match wins
{
  const r = resolveSession({ query: "local_bbb2222" }, SESSIONS);
  assert.equal(r.best.sessionId, "local_bbb2222");
  assert.equal(r.selection.matchReasons[0], "sessionId-exact");
}

// Partial ID match
{
  const r = resolveSession({ query: "ccc333" }, SESSIONS);
  assert.equal(r.best.sessionId, "local_ccc3333");
}

// Title fuzzy match
{
  const r = resolveSession({ query: "payment retry" }, SESSIONS);
  assert.equal(r.best.sessionId, "local_bbb2222");
}

// Ambiguous title match
{
  const r = resolveSession({ query: "Investigate" }, SESSIONS);
  assert.equal(r.selection.ambiguous, true);
  assert.ok(r.candidates.length >= 2);
}

console.log("session-resolver tests passed");
