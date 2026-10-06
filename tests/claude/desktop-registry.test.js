import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidecar, listSidecars, enrichLoaded, findSidecar } from "../../src/claude/desktop-registry.js";

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url)) + "/../fixtures/claude-sidecars";

// parseSidecar picks the documented fields and ignores the rest
{
  const fp = FIXTURE_DIR + "/local_4acb50b2-5a15-49d1-a68e-afa1c409030d.json";
  const sess = parseSidecar(fp);
  assert.equal(sess.sessionId, "local_4acb50b2-5a15-49d1-a68e-afa1c409030d");
  assert.equal(sess.cliSessionId, "36a85a98-8e81-409b-8c1c-07cdaf004d57");
  assert.ok(sess.title.length > 0);
  assert.equal(sess.isArchived, true);
  assert.ok(Array.isArray(sess.userSelectedFolders));
  assert.equal(sess.sourceSidecar, fp);
}

// listSidecars enumerates an account directory
{
  const sessions = listSidecars({ rootDir: FIXTURE_DIR });
  assert.ok(sessions.length >= 1);
  assert.ok(sessions.every(s => s.sessionId.startsWith("local_")));
}

// Synthetic ps output where one session is loaded
{
  const sessions = [
    { sessionId: "local_a", cliSessionId: "uuid-a" },
    { sessionId: "local_b", cliSessionId: "uuid-b" }
  ];
  const fakePs = "claude --resume uuid-a --whatever\nfoo --bar\n";
  const enriched = enrichLoaded(sessions, { psOutput: fakePs });
  assert.equal(enriched.find(s => s.sessionId === "local_a").loaded, true);
  assert.equal(enriched.find(s => s.sessionId === "local_b").loaded, false);
}

// Tighter matcher: substrings in unrelated commands must NOT count as loaded.
// `tail` line lacks --resume; `grep` line has `claude` as an arg, not the program.
{
  const sessions = [
    { sessionId: "local_a", cliSessionId: "uuid-a" },
    { sessionId: "local_b", cliSessionId: "uuid-b" }
  ];
  const fakePs = "tail -f ~/.claude/log\ngrep claude --resume uuid-a /var/tmp/notes\n";
  const enriched = enrichLoaded(sessions, { psOutput: fakePs });
  assert.equal(enriched.find(s => s.sessionId === "local_a").loaded, false);
  assert.equal(enriched.find(s => s.sessionId === "local_b").loaded, false);
}

// findSidecar returns the first matching session and short-circuits.
{
  const found = findSidecar(s => s.sessionId === "local_4acb50b2-5a15-49d1-a68e-afa1c409030d", { rootDir: FIXTURE_DIR });
  assert.ok(found);
  assert.equal(found.sessionId, "local_4acb50b2-5a15-49d1-a68e-afa1c409030d");
  assert.equal(found.cliSessionId, "36a85a98-8e81-409b-8c1c-07cdaf004d57");
}

// findSidecar returns null when no sidecar matches.
{
  const found = findSidecar(s => s.sessionId === "local_does_not_exist", { rootDir: FIXTURE_DIR });
  assert.equal(found, null);
}

// findSidecar's predicate is called only until a match is found. We can't
// directly observe the short-circuit in a one-fixture test, but we can lock
// in the contract: the function returns as soon as the predicate matches,
// and never aggregates beyond the match.
{
  let callCount = 0;
  const found = findSidecar(s => {
    callCount += 1;
    return true; // first sidecar matches
  }, { rootDir: FIXTURE_DIR });
  assert.ok(found);
  assert.equal(callCount, 1, "findSidecar must short-circuit at first match");
}

console.log("desktop-registry tests passed");
