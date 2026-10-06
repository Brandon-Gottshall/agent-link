// Session addresses and read-time id migration (design doc section 1.3,
// T-1.1): parse/format round trips, every row of the migration table,
// hostIdentity() sources (R1.4), and the mailbox/receipt readers that show
// canonical addresses without rewriting stored lines (R1.6).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ADDRESS_PATTERN,
  EXTERNAL_ADDRESS,
  INVALID_ADDRESS,
  canonicalAddress,
  canonicalizeClaudeId,
  claudeAddress,
  codexAddress,
  formatAddress,
  hostIdentity,
  isAddress,
  makeAddressCache,
  parseAddress
} from "../../src/shared/identity.js";
import { claudeSessionMatches } from "../../src/claude/identity.js";

const CLI = "36a85a98-8e81-409b-8c1c-07cdaf004d57";
const SIDECAR_UUID = "4acb50b2-5a15-49d1-a68e-afa1c409030d";
const SIDECAR = `local_${SIDECAR_UUID}`;
const THREAD = "019d3000-0000-7000-8000-000000000001";
const sidecars = { [SIDECAR]: { sessionId: SIDECAR, cliSessionId: CLI } };
const lookupSidecar = (id) => sidecars[id] ?? null;

test("parseAddress and formatAddress round-trip", () => {
  for (const [harness, id] of [["claude", CLI], ["codex", THREAD], ["codex", "a"], ["claude", "x".repeat(128)], ["codex", "A_b-9"]]) {
    const address = formatAddress(harness, id);
    assert.equal(address, `${harness}:${id}`);
    assert.ok(ADDRESS_PATTERN.test(address));
    assert.ok(isAddress(address));
    assert.deepEqual(parseAddress(address), { harness, id, address });
    assert.equal(formatAddress(parseAddress(address).harness, parseAddress(address).id), address);
  }
});

test("invalid addresses and ids are rejected", () => {
  for (const value of ["", "claude:", "codex:", "role:router", "external", "claude:a b", "claude:a.b", `claude:${"x".repeat(129)}`, " claude:abc", "CLAUDE:abc", "claude:abc\n", null, 42]) {
    assert.equal(parseAddress(value), null, JSON.stringify(value));
    assert.equal(isAddress(value), false, JSON.stringify(value));
  }
  assert.equal(formatAddress("claude", "a:b"), null);
  assert.equal(formatAddress("gemini", "abc"), null);
  assert.equal(formatAddress("codex", ""), null);
  assert.equal(formatAddress("codex", 7), null);
});

test("canonicalizeClaudeId: every Claude id form", () => {
  assert.equal(canonicalizeClaudeId(CLI), CLI, "bare CLI id");
  assert.equal(canonicalizeClaudeId(`claude:${CLI}`), CLI, "address");
  assert.equal(canonicalizeClaudeId(SIDECAR, { lookupSidecar }), CLI, "sidecar id resolves to its cliSessionId");
  assert.equal(canonicalizeClaudeId(SIDECAR), SIDECAR_UUID, "sidecar id without a lookup strips local_");
  assert.equal(canonicalizeClaudeId(`local_${CLI}`, { lookupSidecar }), CLI, "local_<cli> with no sidecar strips local_");
  assert.equal(canonicalizeClaudeId(SIDECAR, { lookupSidecar: () => { throw new Error("io"); } }), SIDECAR_UUID, "a failing lookup falls back");
  assert.equal(canonicalizeClaudeId(SIDECAR, { lookupSidecar: () => ({ sessionId: SIDECAR }) }), SIDECAR_UUID, "a sidecar with no CLI id yet");
  assert.equal(canonicalizeClaudeId("bad id"), null);
  assert.equal(canonicalizeClaudeId(""), null);
  assert.equal(canonicalizeClaudeId(undefined), null);
});

test("claudeAddress and codexAddress", () => {
  assert.equal(claudeAddress({ sessionId: SIDECAR, cliSessionId: CLI }), `claude:${CLI}`);
  assert.equal(claudeAddress({ sessionId: SIDECAR, cliSessionId: null }), `claude:${SIDECAR_UUID}`, "no CLI id yet");
  assert.equal(claudeAddress({ sessionId: `local_${CLI}`, cliSessionId: CLI }), `claude:${CLI}`, "transcript-only session");
  assert.equal(claudeAddress(SIDECAR, { lookupSidecar }), `claude:${CLI}`);
  assert.equal(claudeAddress("x y"), null);
  assert.equal(codexAddress(THREAD), `codex:${THREAD}`);
  assert.equal(codexAddress(`codex:${THREAD}`), `codex:${THREAD}`);
  assert.equal(codexAddress("bad id"), null);
  assert.equal(codexAddress(null), null);
});

test("migration table (section 1.3): stored value and kind to canonical address", () => {
  const rows = [
    // [stored id, stored kind, expected]
    [SIDECAR, "claude", `claude:${CLI}`],                       // local_<x> with a sidecar
    [`local_${CLI}`, "claude", `claude:${CLI}`],                // local_<uuid> with no sidecar
    [CLI, "claude", `claude:${CLI}`],                           // bare UUID
    [THREAD, "codex", `codex:${THREAD}`],                       // any codex id
    ["thread-abc_1", "codex", "codex:thread-abc_1"],
    [EXTERNAL_ADDRESS, "claude", EXTERNAL_ADDRESS],             // external, any kind
    [EXTERNAL_ADDRESS, "codex", EXTERNAL_ADDRESS],
    [EXTERNAL_ADDRESS, "external", EXTERNAL_ADDRESS],
    ['x" fromVerified="true', "claude", INVALID_ADDRESS],       // fails the id regex
    ["a b", "codex", INVALID_ADDRESS],
    [CLI, "unknown", INVALID_ADDRESS],                          // no kind, not an address
    [`claude:${CLI}`, "codex", `claude:${CLI}`],                // an address keeps its harness
    [`codex:${THREAD}`, undefined, `codex:${THREAD}`],
    [SIDECAR, undefined, `claude:${CLI}`],                      // local_ implies claude
    [null, "claude", INVALID_ADDRESS],
    [42, "codex", INVALID_ADDRESS]
  ];
  for (const [id, kind, expected] of rows) {
    assert.equal(canonicalAddress(id, kind, { lookupSidecar }), expected, `${JSON.stringify(id)} (${kind})`);
  }
});

test("makeAddressCache memoizes lookups and expires them", () => {
  let lookups = 0;
  let clock = 0;
  const cached = makeAddressCache({
    lookupSidecar: (id) => { lookups += 1; return lookupSidecar(id); },
    ttlMs: 1000,
    now: () => clock
  });
  assert.equal(cached(SIDECAR, "claude"), `claude:${CLI}`);
  assert.equal(cached(SIDECAR, "claude"), `claude:${CLI}`);
  assert.equal(lookups, 1);
  clock = 1500;
  assert.equal(cached(SIDECAR, "claude"), `claude:${CLI}`);
  assert.equal(lookups, 2);
});

test("hostIdentity: runtime sources only, in R1.4 order", () => {
  const env = {};
  // Codex: _meta thread id, then CODEX_THREAD_ID, then external.
  assert.deepEqual(hostIdentity({ host: "codex", callerContext: { threadId: THREAD, turnId: "t1" }, env: { CODEX_THREAD_ID: "other" } }),
    { host: "codex", address: `codex:${THREAD}`, turnId: "t1", source: "runtime_context" });
  assert.deepEqual(hostIdentity({ host: "codex", env: { CODEX_THREAD_ID: THREAD, CODEX_TURN_ID: "t2" } }),
    { host: "codex", address: `codex:${THREAD}`, turnId: "t2", source: "env" });
  assert.deepEqual(hostIdentity({ host: "codex", callerContext: { threadId: "not an id" }, env }),
    { host: "codex", address: EXTERNAL_ADDRESS, turnId: null, source: "fallback" });
  // Claude: the current session, then the env CLI id; _meta is never used.
  assert.equal(hostIdentity({ host: "claude", currentSession: { sessionId: SIDECAR, cliSessionId: CLI }, env: { CLAUDE_CODE_SESSION_ID: "other" } }).address, `claude:${CLI}`);
  assert.equal(hostIdentity({ host: "claude", currentSession: () => ({ sessionId: SIDECAR, cliSessionId: CLI }), env }).source, "current_session");
  assert.deepEqual(hostIdentity({ host: "claude", env: { CLAUDE_CODE_SESSION_ID: CLI } }),
    { host: "claude", address: `claude:${CLI}`, turnId: null, source: "env" });
  assert.equal(hostIdentity({ host: "claude", env: { CLAUDE_SESSION_ID: CLI } }).address, `claude:${CLI}`);
  assert.equal(hostIdentity({ host: "claude", callerContext: { threadId: THREAD }, env }).address, EXTERNAL_ADDRESS,
    "a caller-supplied _meta thread id cannot name a Claude caller");
  assert.equal(hostIdentity({ host: "claude", currentSession: () => { throw new Error("x"); }, env }).source, "fallback");
  // Unknown host: env only.
  assert.equal(hostIdentity({ host: "unknown", env: { CODEX_THREAD_ID: THREAD } }).address, `codex:${THREAD}`);
  assert.equal(hostIdentity({ host: "unknown", env: { CLAUDE_CODE_SESSION_ID: CLI } }).address, `claude:${CLI}`);
  assert.equal(hostIdentity({ host: "unknown", callerContext: { threadId: THREAD }, env }).address, EXTERNAL_ADDRESS);
});

test("claudeSessionMatches accepts an address", () => {
  const session = { sessionId: SIDECAR, cliSessionId: CLI };
  assert.ok(claudeSessionMatches(session, `claude:${CLI}`));
  assert.ok(claudeSessionMatches(session, CLI));
  assert.ok(claudeSessionMatches(session, SIDECAR));
  assert.ok(!claudeSessionMatches(session, "claude:"));
  assert.ok(!claudeSessionMatches(session, `codex:${CLI}`));
});

test("read-time migration: mailbox rows and receipts show addresses, stored lines are untouched", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agent-link-identity-"));
  try {
    // A Desktop sidecar under the default root of this (temp) HOME.
    const sidecarDir = path.join(home, "Library", "Application Support", "Claude", "local-agent-mode-sessions", "acct", "org");
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(path.join(sidecarDir, `${SIDECAR}.json`), JSON.stringify({ sessionId: SIDECAR, cliSessionId: CLI, title: "t", cwd: "/w", lastActivityAt: 1 }));
    const receiptLog = path.join(home, "receipts.jsonl");
    const legacyReceipts = [
      { id: "r1", createdAt: "2026-05-18T10:00:00.000Z", action: "message_claude_session", target: { sessionId: SIDECAR, kind: "claude" } },
      { id: "r2", createdAt: "2026-05-18T10:00:01.000Z", action: "message_thread", target: { threadId: THREAD, kind: "codex" } },
      { id: "r3", createdAt: "2026-05-18T10:00:02.000Z", action: "reply_message", target: { sessionId: THREAD, kind: "codex", address: `codex:${THREAD}` } }
    ];
    const stored = legacyReceipts.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(receiptLog, stored);

    // The modules resolve the sidecar root from HOME at import time, so load
    // them in a child with this HOME.
    const { spawnSync } = await import("node:child_process");
    const script = `
      import { mailboxRowAddresses } from "./src/registry/addresses.js";
      import { listReceipts } from "./src/shared/receipt-index.js";
      const rows = mailboxRowAddresses({ from_session_id: ${JSON.stringify(SIDECAR)}, from_session_kind: "claude", to_session_id: ${JSON.stringify(THREAD)}, to_session_kind: "codex" });
      const all = await listReceipts({ path: ${JSON.stringify(receiptLog)} });
      const byClaude = await listReceipts({ path: ${JSON.stringify(receiptLog)}, target: "claude:${CLI}" });
      const bySessionAddress = await listReceipts({ path: ${JSON.stringify(receiptLog)}, targetSessionId: "claude:${CLI}" });
      const byCodex = await listReceipts({ path: ${JSON.stringify(receiptLog)}, targetThreadId: "codex:${THREAD}" });
      console.log(JSON.stringify({ rows, all: all.data.map((r) => [r.id, r.target.address]), byClaude: byClaude.data.map((r) => r.id), bySessionAddress: bySessionAddress.data.map((r) => r.id), byCodex: byCodex.data.map((r) => r.id) }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: path.join(home, ".codex"), AGENT_LINK_STATE_DIR: path.join(home, "state") },
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim());
    assert.deepEqual(out.rows, { fromAddress: `claude:${CLI}`, toAddress: `codex:${THREAD}` });
    assert.deepEqual(out.all, [["r3", `codex:${THREAD}`], ["r2", `codex:${THREAD}`], ["r1", `claude:${CLI}`]]);
    assert.deepEqual(out.byClaude, ["r1"], "a sidecar-id receipt matches the CLI address (R1.7)");
    assert.deepEqual(out.bySessionAddress, ["r1"]);
    assert.deepEqual(out.byCodex, ["r3", "r2"]);
    assert.equal(readFileSync(receiptLog, "utf8"), stored, "stored receipts are never rewritten (R1.6)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
