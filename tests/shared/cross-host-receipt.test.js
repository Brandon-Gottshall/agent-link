// tests/shared/cross-host-receipt.test.js
//
// Verifies cross-host receipt logging for Phase 8:
//   1. `message_claude_session` called FROM a Codex host (with a runtime
//      caller context that carries a Codex thread id) logs a receipt with
//      host="codex", target.kind="claude", and target.sessionId set.
//   2. `from_session_id` in the mailbox row prefers the MCP runtime caller
//      context's threadId even when CODEX_THREAD_ID is unset (Phase 6 review
//      follow-up).
//   3. `buildReceipt` accepts target.kind and threads it through.
//   4. Codex-side receipts built with host="codex" and target.kind="codex"
//      surface those fields in the schema.

// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openMailbox } from "../../src/claude/mailbox.js";
import { makeClaudeSendHandler } from "../../src/tools/claude-send.js";
import { appendReceipt, buildReceipt, listReceipts } from "../../src/shared/receipt-index.js";

const SESSIONS = [
  {
    sessionId: "local_target_claude",
    cliSessionId: "uuid-claude",
    title: "Claude target session",
    cwd: "/sessions/target",
    loaded: true
  }
];

function makeSandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-crosshost-"));
  return {
    tmp,
    mailboxPath: path.join(tmp, "mailbox.jsonl"),
    receiptLog: path.join(tmp, "receipts.jsonl")
  };
}

function cleanup(sb) {
  delete process.env.CODEX_AGENT_LINK_RECEIPT_LOG;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CLAUDE_SESSION_ID;
  fs.rmSync(sb.tmp, { recursive: true, force: true });
}

function withCleanEnv(fn) {
  const saved = {
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID
  };
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CLAUDE_SESSION_ID;
  try {
    return fn();
  } finally {
    if (saved.CODEX_THREAD_ID === undefined) {
      delete process.env.CODEX_THREAD_ID;
    } else {
      process.env.CODEX_THREAD_ID = saved.CODEX_THREAD_ID;
    }
    if (saved.CLAUDE_SESSION_ID === undefined) {
      delete process.env.CLAUDE_SESSION_ID;
    } else {
      process.env.CLAUDE_SESSION_ID = saved.CLAUDE_SESSION_ID;
    }
  }
}

// Test 1: Codex caller -> Claude target.
// Receipt records host="codex", target.kind="claude", target.sessionId set,
// and origin.threadId comes from the runtime caller context (not env, which
// is intentionally unset).
{
  const sb = makeSandbox();
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = sb.receiptLog;

  await withCleanEnv(async () => {
    const handlers = makeClaudeSendHandler({
      host: "codex",
      listSessions: () => SESSIONS,
      mailboxOpener: () => openMailbox({ mailboxPath: sb.mailboxPath })
    });

    // Simulate the runtime caller context Codex hosts pass via _meta.
    const runtimeCallerContext = {
      available: true,
      threadId: "019df300-0000-7000-8000-codex-caller",
      turnId: "019df300-0000-7000-8000-codex-turn",
      toolCallId: "call_codex_caller",
      source: "runtime_context",
      sources: {},
      requestId: "req-1",
      sessionId: null,
      metaKeys: { requestParams: [], extra: [] }
    };

    const result = await handlers.message_claude_session(
      {
        sessionId: "local_target_claude",
        message: "cross-host hello",
        receipt: { purpose: "cross-host codex->claude" }
      },
      { runtimeCallerContext }
    );

    assert.equal(result.error, undefined, "no error for cross-host send");
    assert.equal(result.target.sessionId, "local_target_claude");

    // Mailbox row records from_session_id from the runtime caller context,
    // not the "external" fallback (since CODEX_THREAD_ID is unset).
    const mb = openMailbox({ mailboxPath: sb.mailboxPath });
    const rows = mb.inspect({ toSessionId: "local_target_claude" });
    mb.close();
    assert.equal(rows.length, 1, "exactly one mailbox row");
    assert.equal(
      rows[0].from_session_id,
      "019df300-0000-7000-8000-codex-caller",
      "from_session_id should reflect the runtime caller context's threadId"
    );
    assert.equal(rows[0].from_session_kind, "codex");
    assert.equal(rows[0].to_session_kind, "claude");

    // Receipt records host=codex, target.kind=claude.
    const receipts = await listReceipts();
    assert.equal(receipts.data.length, 1, "one receipt written");
    const receipt = receipts.data[0];
    assert.equal(receipt.action, "message_claude_session");
    assert.equal(receipt.host, "codex", "receipt.host must be codex");
    assert.equal(receipt.target.kind, "claude", "target.kind must be claude");
    assert.equal(receipt.target.sessionId, "local_target_claude");
    assert.equal(receipt.target.loaded, true);
    assert.equal(
      receipt.origin.threadId,
      "019df300-0000-7000-8000-codex-caller",
      "origin.threadId must come from runtime caller context"
    );
    assert.equal(receipt.origin.source, "runtime_context");
  });

  cleanup(sb);
}

// Test 2: Phase 6 review follow-up — env var fallback still works when
// no runtime caller context is supplied.
{
  const sb = makeSandbox();
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = sb.receiptLog;

  await withCleanEnv(async () => {
    process.env.CODEX_THREAD_ID = "019df301-0000-7000-8000-env-codex";

    const handlers = makeClaudeSendHandler({
      host: "codex",
      listSessions: () => SESSIONS,
      mailboxOpener: () => openMailbox({ mailboxPath: sb.mailboxPath })
    });

    const result = await handlers.message_claude_session({
      sessionId: "local_target_claude",
      message: "env fallback hello"
    });

    assert.equal(result.error, undefined);

    const mb = openMailbox({ mailboxPath: sb.mailboxPath });
    const rows = mb.inspect({ toSessionId: "local_target_claude" });
    mb.close();
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].from_session_id,
      "019df301-0000-7000-8000-env-codex",
      "from_session_id falls back to CODEX_THREAD_ID when no runtime context"
    );
  });

  cleanup(sb);
}

// Test 3: external fallback when neither runtime context nor env is set.
{
  const sb = makeSandbox();
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = sb.receiptLog;

  await withCleanEnv(async () => {
    const handlers = makeClaudeSendHandler({
      host: "codex",
      listSessions: () => SESSIONS,
      mailboxOpener: () => openMailbox({ mailboxPath: sb.mailboxPath })
    });

    const result = await handlers.message_claude_session({
      sessionId: "local_target_claude",
      message: "external fallback"
    });

    assert.equal(result.error, undefined);

    const mb = openMailbox({ mailboxPath: sb.mailboxPath });
    const rows = mb.inspect({ toSessionId: "local_target_claude" });
    mb.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].from_session_id, "external");
  });

  cleanup(sb);
}

// Test 4: Claude caller -> Claude target with runtime context (Claude host).
{
  const sb = makeSandbox();
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = sb.receiptLog;

  await withCleanEnv(async () => {
    process.env.CLAUDE_SESSION_ID = "uuid-claude-caller-env";
    const handlers = makeClaudeSendHandler({
      host: "claude",
      listSessions: () => SESSIONS,
      mailboxOpener: () => openMailbox({ mailboxPath: sb.mailboxPath })
    });

    const result = await handlers.message_claude_session({
      sessionId: "local_target_claude",
      message: "claude->claude"
    });

    assert.equal(result.error, undefined);

    const receipts = await listReceipts();
    assert.equal(receipts.data.length, 1);
    const receipt = receipts.data[0];
    assert.equal(receipt.host, "claude");
    assert.equal(receipt.target.kind, "claude");
    assert.equal(receipt.target.sessionId, "local_target_claude");

    const mb = openMailbox({ mailboxPath: sb.mailboxPath });
    const rows = mb.inspect({ toSessionId: "local_target_claude" });
    mb.close();
    // P4-04: the env carries the raw CLI id; the mailbox records the
    // canonical `local_<cli>` form so replies reach the sender's inbox.
    assert.equal(rows[0].from_session_id, "local_uuid-claude-caller-env");
    assert.equal(rows[0].from_session_kind, "claude");
  });

  cleanup(sb);
}

// Test 5: buildReceipt threads target.kind through (Codex-side receipts).
// This simulates how the Codex thread tools (message_codex_thread,
// launch_codex_thread, archive_codex_thread) record receipts. The receipt
// schema must accept target.kind="codex" alongside threadId etc., without
// regressing the existing fields. Tested directly because the live tools
// require an app-server connection.
{
  const receipt = buildReceipt({
    action: "message_thread",
    host: "claude",
    receipt: { purpose: "claude->codex receipt" },
    target: {
      threadId: "019df400-0000-7000-8000-codex-target",
      turnId: "019df400-0000-7000-8000-codex-turn",
      kind: "codex",
      name: "Codex target thread",
      deepLink: "codex://threads/019df400-0000-7000-8000-codex-target"
    },
    message: "from claude to codex",
    finalResponse: null,
    delivery: { state: "accepted_by_app_server", action: "started_turn" },
    replyConfirmation: null,
    runtimeCallerContext: {
      available: true,
      threadId: "uuid-claude-caller-runtime",
      turnId: null,
      toolCallId: null,
      source: "runtime_context",
      sources: {},
      requestId: null,
      sessionId: null,
      metaKeys: { requestParams: [], extra: [] }
    },
    appServer: {}
  });

  assert.equal(receipt.action, "message_thread");
  assert.equal(receipt.host, "claude");
  assert.equal(
    receipt.target.kind,
    "codex",
    "target.kind must be preserved on the built receipt"
  );
  assert.equal(receipt.target.threadId, "019df400-0000-7000-8000-codex-target");
  assert.equal(receipt.target.turnId, "019df400-0000-7000-8000-codex-turn");
  assert.equal(receipt.origin.threadId, "uuid-claude-caller-runtime");
}

// Test 6: backward compat — buildReceipt without target.kind still works,
// target.kind defaults to null. test:feedback exercises this path.
{
  const receipt = buildReceipt({
    action: "launch_thread",
    receipt: { purpose: "no-kind backwards compat" },
    target: { threadId: "019df500-0000-7000-8000-target" },
    message: null,
    finalResponse: null,
    delivery: null,
    appServer: {}
  });

  assert.equal(receipt.target.threadId, "019df500-0000-7000-8000-target");
  assert.equal(
    receipt.target.kind,
    null,
    "target.kind defaults to null when caller does not supply it"
  );
  assert.equal(receipt.host, null);
}

// Test 7: list_agent_link_receipts filters by host, targetKind, and
// targetSessionId. Phase 8 review locked these so cross-host receipts can be
// queried by what they recorded. Writes a controlled set of 4 receipts and
// asserts each new filter narrows correctly, both alone and combined.
{
  const sb = makeSandbox();
  process.env.CODEX_AGENT_LINK_RECEIPT_LOG = sb.receiptLog;

  await withCleanEnv(async () => {
    const claudeToCodex = (id) => buildReceipt({
      action: "message_thread",
      host: "claude",
      receipt: { purpose: `claude->codex ${id}` },
      target: {
        threadId: `019df600-codex-target-${id}`,
        kind: "codex",
        name: `Codex target ${id}`
      },
      message: `c2x-${id}`,
      delivery: null,
      appServer: {}
    });
    const codexToClaude = (id) => buildReceipt({
      action: "message_claude_session",
      host: "codex",
      receipt: { purpose: `codex->claude ${id}` },
      target: {
        sessionId: `local_target_claude_${id}`,
        kind: "claude",
        name: `Claude target ${id}`,
        loaded: true
      },
      message: `x2c-${id}`,
      delivery: null,
      appServer: {}
    });

    await appendReceipt(claudeToCodex("a"));
    await appendReceipt(claudeToCodex("b"));
    await appendReceipt(codexToClaude("a"));
    await appendReceipt(codexToClaude("b"));

    const byHostClaude = await listReceipts({ host: "claude" });
    assert.equal(byHostClaude.data.length, 2, "host=claude returns 2");
    for (const r of byHostClaude.data) {
      assert.equal(r.host, "claude");
    }

    const byTargetKindCodex = await listReceipts({ targetKind: "codex" });
    assert.equal(byTargetKindCodex.data.length, 2, "targetKind=codex returns 2");
    for (const r of byTargetKindCodex.data) {
      assert.equal(r.target.kind, "codex");
    }

    const combined = await listReceipts({ host: "claude", targetKind: "codex" });
    assert.equal(combined.data.length, 2, "host=claude+targetKind=codex returns the same 2");

    const byAction = await listReceipts({ action: "message_claude_session" });
    assert.equal(byAction.data.length, 2, "action=message_claude_session returns 2");
    for (const r of byAction.data) {
      assert.equal(r.action, "message_claude_session");
    }

    const bySession = await listReceipts({ targetSessionId: "local_target_claude_a" });
    assert.equal(bySession.data.length, 1, "targetSessionId narrows to one row");
    assert.equal(bySession.data[0].target.sessionId, "local_target_claude_a");
  });

  cleanup(sb);
}

console.log("cross-host receipt tests passed");
