// tests/shared/host-detect.test.js
import assert from "node:assert/strict";
import { detectHost, currentClaudeSessionId } from "../../src/shared/host-detect.js";

// Codex env: CODEX_HOME set, CLAUDE_PROJECT_DIR not
{
  const env = { CODEX_HOME: "/Users/me/.codex" };
  assert.equal(detectHost({ env }).host, "codex");
}

// Claude env: CLAUDE_PROJECT_DIR or CLAUDE_PLUGIN_ROOT set
{
  const env = { CLAUDE_PLUGIN_ROOT: "/whatever/agent-link" };
  assert.equal(detectHost({ env }).host, "claude");
}

// Both set: prefer Claude (we're running INSIDE Claude that called the tool)
{
  const env = { CODEX_HOME: "/x", CLAUDE_PLUGIN_ROOT: "/y" };
  assert.equal(detectHost({ env }).host, "claude");
}

// Claude Desktop / Claude Code 2.1.x env: only CLAUDE_CODE_SESSION_ID is set
// (CLAUDE_SESSION_ID is empty). Must still detect the Claude host — otherwise
// the receive tools never register.
{
  const env = { CLAUDE_CODE_SESSION_ID: "1ca3e5fe-86b5-4323-b364-6fce99403002" };
  assert.equal(detectHost({ env }).host, "claude");
}

// Neither set: unknown
{
  const env = {};
  const r = detectHost({ env });
  assert.equal(r.host, "unknown");
  assert.ok(r.reason);
}

// currentClaudeSessionId: CLAUDE_SESSION_ID wins when both are present.
{
  const env = { CLAUDE_SESSION_ID: "interactive-id", CLAUDE_CODE_SESSION_ID: "desktop-id" };
  assert.equal(currentClaudeSessionId({ env }), "interactive-id");
}

// currentClaudeSessionId: falls back to CLAUDE_CODE_SESSION_ID (the Desktop /
// Claude Code 2.1.x host name). Regression guard for the no_current_session bug.
{
  const env = { CLAUDE_CODE_SESSION_ID: "desktop-id" };
  assert.equal(currentClaudeSessionId({ env }), "desktop-id");
}

// currentClaudeSessionId: empty string is not a valid id — fall through.
{
  const env = { CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "desktop-id" };
  assert.equal(currentClaudeSessionId({ env }), "desktop-id");
}

// currentClaudeSessionId: undefined when neither is set.
{
  assert.equal(currentClaudeSessionId({ env: {} }), undefined);
}

// W2C-04: one claudeConfigDir() helper honors CLAUDE_CONFIG_DIR.
{
  const hostDetect = await import("../../src/shared/host-detect.js");
  assert.equal(typeof hostDetect.claudeConfigDir, "function", "claudeConfigDir() must exist");
  const os = await import("node:os");
  const path = await import("node:path");
  assert.equal(hostDetect.claudeConfigDir({ env: {} }), path.join(os.homedir(), ".claude"));
  assert.equal(hostDetect.claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: "/tmp/relocated-claude" } }), "/tmp/relocated-claude");
  assert.equal(hostDetect.claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: "  " } }), path.join(os.homedir(), ".claude"));
  assert.equal(hostDetect.claudeProjectsRoot({ env: { CLAUDE_CONFIG_DIR: "/tmp/relocated-claude" } }), "/tmp/relocated-claude/projects");
}

console.log("host-detect tests passed");
