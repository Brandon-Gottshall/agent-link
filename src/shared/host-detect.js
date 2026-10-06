// src/shared/host-detect.js

// The current Claude session id, however the host exposes it. Interactive
// `claude` historically set CLAUDE_SESSION_ID, but the Claude Desktop host and
// Claude Code 2.1.x (entrypoint `claude-desktop`) expose it as
// CLAUDE_CODE_SESSION_ID and leave CLAUDE_SESSION_ID empty. Reading only the
// former silently disables the Claude receive path (read_agent_link_inbox
// returns no_current_session, sends record from="external"). Check both.
export function currentClaudeSessionId({ env = process.env } = {}) {
  return env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || undefined;
}

export function detectHost({ env = process.env } = {}) {
  const claude = !!(env.CLAUDE_PROJECT_DIR || env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID);
  const codex  = !!(env.CODEX_HOME || env.CODEX_THREAD_ID);
  if (claude) return { host: "claude", reason: "claude env vars present" };
  if (codex)  return { host: "codex",  reason: "codex env vars present" };
  return { host: "unknown", reason: "no host env vars detected" };
}
