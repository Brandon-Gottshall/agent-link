import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  claudeConfigDir,
  codexHome,
  expandHome,
  legacyClaudeStateDir,
  legacyPaths,
  logDir,
  logFilePath,
  mailboxPath,
  managedAppServerDir,
  migrationRecordPath,
  receiptLogPath,
  stateDir
} from "../../src/shared/paths.js";

const home = path.join(path.sep, "home", "tester");
const at = (/** @type {Record<string, string>} */ env) => ({ env, homedir: home });

test("defaults with an empty environment", () => {
  const o = at({});
  assert.equal(stateDir(o), path.join(home, ".agent-link"));
  assert.equal(claudeConfigDir(o), path.join(home, ".claude"));
  assert.equal(codexHome(o), path.join(home, ".codex"));
  assert.equal(mailboxPath(o), path.join(home, ".agent-link", "mailbox.jsonl"));
  assert.equal(receiptLogPath(o), path.join(home, ".agent-link", "receipts.jsonl"));
  assert.equal(managedAppServerDir(o), path.join(home, ".agent-link", "managed-app-servers"));
  assert.equal(logDir(o), path.join(home, ".agent-link", "logs"));
  assert.equal(logFilePath(o), path.join(home, ".agent-link", "logs", "agent-link.log"));
  assert.equal(migrationRecordPath(o), path.join(home, ".agent-link", "migration.json"));
});

test("AGENT_LINK_STATE_DIR moves every derived path", () => {
  const o = at({ AGENT_LINK_STATE_DIR: "/srv/al" });
  assert.equal(stateDir(o), path.resolve("/srv/al"));
  assert.equal(mailboxPath(o), path.resolve("/srv/al/mailbox.jsonl"));
  assert.equal(receiptLogPath(o), path.resolve("/srv/al/receipts.jsonl"));
  assert.equal(managedAppServerDir(o), path.resolve("/srv/al/managed-app-servers"));
  assert.equal(logFilePath(o), path.resolve("/srv/al/logs/agent-link.log"));
});

test("explicit file overrides, including legacy aliases", () => {
  assert.equal(mailboxPath(at({ AGENT_LINK_MAILBOX_PATH: "/m/box.jsonl" })), path.resolve("/m/box.jsonl"));
  assert.equal(receiptLogPath(at({ CODEX_AGENT_LINK_RECEIPT_LOG: "/r.jsonl" })), path.resolve("/r.jsonl"));
  assert.equal(receiptLogPath(at({ CLAUDE_AGENT_LINK_RECEIPT_LOG: "/c.jsonl" })), path.resolve("/c.jsonl"));
  assert.equal(
    receiptLogPath(at({ AGENT_LINK_RECEIPT_LOG: "/canonical.jsonl", CODEX_AGENT_LINK_RECEIPT_LOG: "/legacy.jsonl" })),
    path.resolve("/canonical.jsonl")
  );
  // The legacy CODEX_AGENT_LINK_STATE_DIR only ever meant the managed dir.
  const legacyManaged = at({ CODEX_AGENT_LINK_STATE_DIR: "/managed" });
  assert.equal(managedAppServerDir(legacyManaged), path.resolve("/managed"));
  assert.equal(stateDir(legacyManaged), path.join(home, ".agent-link"));
  assert.equal(logFilePath(at({ AGENT_LINK_LOG_FILE: "/l/x.log" })), path.resolve("/l/x.log"));
});

test("host directories honor CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
  assert.equal(claudeConfigDir(at({ CLAUDE_CONFIG_DIR: "/cfg/claude" })), path.resolve("/cfg/claude"));
  assert.equal(codexHome(at({ CODEX_HOME: "/cfg/codex" })), path.resolve("/cfg/codex"));
  assert.equal(legacyClaudeStateDir(at({ CLAUDE_CONFIG_DIR: "/cfg/claude" })), path.resolve("/cfg/claude/agent-link"));
});

test("a leading ~ expands against the home directory", () => {
  assert.equal(stateDir(at({ AGENT_LINK_STATE_DIR: "~/state" })), path.join(home, "state"));
  assert.equal(expandHome("~", home), home);
  assert.equal(expandHome("~other/x", home), path.resolve("~other/x"));
  assert.equal(expandHome("rel/dir", home), path.resolve("rel/dir"));
});

test("legacyPaths are the 0.4.x locations", () => {
  assert.deepEqual(legacyPaths(at({})), {
    mailbox: path.join(home, ".claude", "agent-link", "mailbox.jsonl"),
    mailboxDb: path.join(home, ".claude", "agent-link", "mailbox.sqlite"),
    receipts: path.join(home, ".codex", "agent-link-receipts.jsonl"),
    managedAppServers: path.join(home, ".claude", "agent-link", "managed-app-servers")
  });
  assert.equal(legacyPaths(at({ CODEX_HOME: "/ch" })).receipts, path.resolve("/ch/agent-link-receipts.jsonl"));
});

test("pure: defaults to process.env without touching the filesystem", () => {
  assert.equal(typeof stateDir(), "string");
  assert.ok(path.isAbsolute(stateDir()));
});
