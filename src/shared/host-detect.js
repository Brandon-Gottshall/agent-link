// src/shared/host-detect.js
import path from "node:path";
import { homedir } from "node:os";

// The current Claude session id, however the host exposes it. Interactive
// `claude` historically set CLAUDE_SESSION_ID, but the Claude Desktop host and
// Claude Code 2.1.x (entrypoint `claude-desktop`) expose it as
// CLAUDE_CODE_SESSION_ID and leave CLAUDE_SESSION_ID empty. Reading only the
// former silently disables the Claude receive path (read_agent_link_inbox
// returns no_current_session, sends record from="external"). Check both.
//
// The value is the Claude Code CLI session id (the transcript file name), not
// the Desktop sidecar `local_<uuid>` id. Use canonicalClaudeSessionId() from
// src/claude/identity.js when an addressable mailbox id is needed.
export function currentClaudeSessionId({ env = process.env } = {}) {
  return env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || undefined;
}

// Claude Code's configuration directory. CLAUDE_CONFIG_DIR relocates
// everything Claude Code writes under ~/.claude, including the transcripts in
// `projects/`. Every Claude-side lookup of transcripts must go through this
// helper, or a relocated install sees the hook report pending mail while the
// inbox tool cannot resolve the current session.
//
// The Agent Link mailbox/state directory intentionally stays at
// ~/.claude/agent-link for now; moving it is a separate, owner-approved change.
export function claudeConfigDir({ env = process.env } = {}) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  return configured ? path.resolve(configured) : path.join(homedir(), ".claude");
}

export function claudeProjectsRoot({ env = process.env } = {}) {
  return path.join(claudeConfigDir({ env }), "projects");
}

export function detectHost({ env = process.env } = {}) {
  const claude = !!(env.CLAUDE_PROJECT_DIR || env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID);
  const codex  = !!(env.CODEX_HOME || env.CODEX_THREAD_ID);
  if (claude) return { host: "claude", reason: "claude env vars present" };
  if (codex)  return { host: "codex",  reason: "codex env vars present" };
  return { host: "unknown", reason: "no host env vars detected" };
}
