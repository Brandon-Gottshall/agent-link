// tests/claude/notify-hook.test.js
//
// Verifies that src/claude/notify-hook.js, when invoked via Claude Code's
// UserPromptSubmit / SessionStart hook contract, emits the wrapped
// `hookSpecificOutput.additionalContext` notification when the per-session
// mailbox has pending messages, and emits empty stdout `{}` otherwise.
//
// Phase 0 verified that:
//   - Stop does NOT accept additionalContext (hence this pivot).
//   - UserPromptSubmit + SessionStart DO accept additionalContext.
//   - The wrapped form `{hookSpecificOutput: {hookEventName, additionalContext}}`
//     is the form Claude Code actually injects.
//
// Critical: notify-hook MUST NOT include the message body. The body is
// returned by the read_agent_link_inbox MCP tool so it appears in the
// visible transcript.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openMailbox } from "../../src/claude/mailbox.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const NOTIFY_HOOK = path.join(REPO_ROOT, "src/claude/notify-hook.js");
const FIXTURE_DIR = path.join(REPO_ROOT, "tests/fixtures/hook-stdin");
const USER_PROMPT_FIXTURE = path.join(FIXTURE_DIR, "sample-userpromptsubmit-stdin.json");
const SESSION_START_FIXTURE = path.join(FIXTURE_DIR, "sample-sessionstart-stdin.json");

function makeSandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-notify-"));
  return {
    tmp,
    dbPath: path.join(tmp, "mailbox.sqlite"),
    registryPath: path.join(tmp, "fake-registry.json")
  };
}

function cleanup(sb) {
  fs.rmSync(sb.tmp, { recursive: true, force: true });
}

function runNotifyHook({ stdinJson, dbPath, registryPath }) {
  return execFileSync("node", [NOTIFY_HOOK], {
    input: typeof stdinJson === "string" ? stdinJson : JSON.stringify(stdinJson),
    env: {
      ...process.env,
      AGENT_LINK_MAILBOX_DB: dbPath,
      AGENT_LINK_TEST_REGISTRY: registryPath
    },
    encoding: "utf8"
  });
}

function loadFixture(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeRegistry(filePath, entries) {
  fs.writeFileSync(filePath, JSON.stringify(entries));
}

// Test 1: pending messages -> wrapped additionalContext notification.
{
  const sb = makeSandbox();
  const stdinFixture = loadFixture(USER_PROMPT_FIXTURE);
  writeRegistry(sb.registryPath, [
    { sessionId: "local_test1", cliSessionId: stdinFixture.session_id, title: "Test session" }
  ]);

  const mb = openMailbox({ dbPath: sb.dbPath });
  mb.insertMessage({
    fromSessionId: "local_other",
    fromSessionKind: "claude",
    toSessionId: "local_test1",
    toSessionKind: "claude",
    body: "hello receiver"
  });
  mb.close();

  const out = runNotifyHook({
    stdinJson: stdinFixture,
    dbPath: sb.dbPath,
    registryPath: sb.registryPath
  });

  const parsed = JSON.parse(out);
  assert.ok(parsed.hookSpecificOutput, "hookSpecificOutput must be present");
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === "string" && ctx.length > 0, "additionalContext must be a non-empty string");
  assert.match(ctx, /pending/i, "additionalContext should mention pending messages");
  assert.match(ctx, /1\b/, "additionalContext should include the count");
  assert.match(ctx, /read_agent_link_inbox/, "additionalContext must instruct calling the read_agent_link_inbox tool");
  assert.match(ctx, /local_other/, "additionalContext should mention the sender id");
  assert.ok(!ctx.includes("hello receiver"),
    "notify hook leaked the message body — body must stay in the mailbox until the tool reads it");

  cleanup(sb);
}

// Test 2: messages remain undelivered after notify (notify must not drain).
{
  const sb = makeSandbox();
  const stdinFixture = loadFixture(USER_PROMPT_FIXTURE);
  writeRegistry(sb.registryPath, [
    { sessionId: "local_test1", cliSessionId: stdinFixture.session_id, title: "Test session" }
  ]);

  const mb = openMailbox({ dbPath: sb.dbPath });
  mb.insertMessage({
    fromSessionId: "local_other",
    fromSessionKind: "claude",
    toSessionId: "local_test1",
    toSessionKind: "claude",
    body: "still pending"
  });
  mb.close();

  runNotifyHook({
    stdinJson: stdinFixture,
    dbPath: sb.dbPath,
    registryPath: sb.registryPath
  });

  const mb2 = openMailbox({ dbPath: sb.dbPath });
  const stillPending = mb2.listPendingFor({ toSessionId: "local_test1" });
  mb2.close();
  assert.equal(stillPending.length, 1, "notify hook must not mark messages delivered");
  assert.equal(stillPending[0].delivered_at, null);

  cleanup(sb);
}

// Test 3: empty mailbox -> empty stdout `{}`.
{
  const sb = makeSandbox();
  const stdinFixture = loadFixture(USER_PROMPT_FIXTURE);
  writeRegistry(sb.registryPath, [
    { sessionId: "local_test1", cliSessionId: stdinFixture.session_id, title: "Test session" }
  ]);

  // No messages inserted.
  const out = runNotifyHook({
    stdinJson: stdinFixture,
    dbPath: sb.dbPath,
    registryPath: sb.registryPath
  });

  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {}, "empty mailbox must produce empty `{}` stdout");

  cleanup(sb);
}

// Test 4: unknown cliSessionId -> empty stdout `{}`.
{
  const sb = makeSandbox();
  const stdinFixture = loadFixture(USER_PROMPT_FIXTURE);
  // Registry contains *no* entry whose cliSessionId matches the fixture.
  writeRegistry(sb.registryPath, [
    { sessionId: "local_someone-else", cliSessionId: "totally-unrelated-uuid", title: "Other" }
  ]);

  const out = runNotifyHook({
    stdinJson: stdinFixture,
    dbPath: sb.dbPath,
    registryPath: sb.registryPath
  });

  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {}, "unknown cliSessionId must produce empty `{}` stdout");

  cleanup(sb);
}

// Test 5: SessionStart fixture works the same way.
{
  const sb = makeSandbox();
  const stdinFixture = loadFixture(SESSION_START_FIXTURE);
  assert.equal(stdinFixture.hook_event_name, "SessionStart", "fixture sanity check");
  writeRegistry(sb.registryPath, [
    { sessionId: "local_sessionstart", cliSessionId: stdinFixture.session_id, title: "Session start test" }
  ]);

  const mb = openMailbox({ dbPath: sb.dbPath });
  mb.insertMessage({
    fromSessionId: "local_sender",
    fromSessionKind: "claude",
    toSessionId: "local_sessionstart",
    toSessionKind: "claude",
    body: "queued before resume"
  });
  mb.close();

  const out = runNotifyHook({
    stdinJson: stdinFixture,
    dbPath: sb.dbPath,
    registryPath: sb.registryPath
  });

  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(parsed.hookSpecificOutput.additionalContext, /read_agent_link_inbox/);
  assert.ok(!parsed.hookSpecificOutput.additionalContext.includes("queued before resume"),
    "notify hook leaked body on SessionStart event");

  cleanup(sb);
}

// Test 6: transcript-only session (no sidecar) still gets the nudge, resolved
// from the hook payload's transcript_path. This is the Claude-Code-inside-
// Claude-Desktop case where no sidecar exists. No AGENT_LINK_TEST_REGISTRY is
// set, so resolution falls through findSidecar (miss) to the transcript path.
{
  const sb = makeSandbox();
  const sessionId = "transcript-only-wf-0001";
  const transcriptPath = path.join(sb.tmp, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, JSON.stringify({ sessionId, type: "summary" }) + "\n");

  const mb = openMailbox({ dbPath: sb.dbPath });
  mb.insertMessage({
    fromSessionId: "local_sender",
    fromSessionKind: "claude",
    toSessionId: `local_${sessionId}`,
    toSessionKind: "claude",
    body: "transcript-only receiver body"
  });
  mb.close();

  const out = execFileSync("node", [NOTIFY_HOOK], {
    input: JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      hook_event_name: "UserPromptSubmit"
    }),
    env: { ...process.env, AGENT_LINK_MAILBOX_DB: sb.dbPath }, // no AGENT_LINK_TEST_REGISTRY
    encoding: "utf8"
  });

  const parsed = JSON.parse(out);
  assert.ok(parsed.hookSpecificOutput, "transcript-only session must still get the nudge");
  assert.match(parsed.hookSpecificOutput.additionalContext, /read_agent_link_inbox/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /local_sender/);
  assert.ok(!parsed.hookSpecificOutput.additionalContext.includes("transcript-only receiver body"),
    "notify hook leaked the body for a transcript-only session");

  cleanup(sb);
}

console.log("notify-hook tests passed");
