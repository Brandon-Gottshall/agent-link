// src/shared/host-detect.js
import path from "node:path";
import { env as lookup } from "./env.js";
import { claudeConfigDir as resolveClaudeConfigDir } from "./paths.js";

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
  return lookup("CLAUDE_SESSION_ID", env).value || lookup("CLAUDE_CODE_SESSION_ID", env).value || undefined;
}

// Claude Code's configuration directory. CLAUDE_CONFIG_DIR relocates
// everything Claude Code writes under ~/.claude, including the transcripts in
// `projects/`. Every Claude-side lookup of transcripts must go through this
// helper, or a relocated install sees the hook report pending mail while the
// inbox tool cannot resolve the current session.
//
// Agent Link's own state lives in ~/.agent-link (src/shared/paths.js), not
// here; <CLAUDE_CONFIG_DIR>/agent-link is only read as a legacy location.
export function claudeConfigDir({ env = process.env } = {}) {
  return resolveClaudeConfigDir({ env });
}

export function claudeProjectsRoot({ env = process.env } = {}) {
  return path.join(claudeConfigDir({ env }), "projects");
}

const HOSTS = new Set(["claude", "codex"]);

// AGENT_LINK_HOST, set in each host's plugin manifest, is authoritative.
// Without it (an older manifest, a hand-written MCP config) the host is
// inferred from the variables each host sets for its children.
export function detectHost({ env = process.env } = {}) {
  const declared = lookup("AGENT_LINK_HOST", env).value?.trim().toLowerCase();
  if (declared && HOSTS.has(declared)) {
    return { host: declared, reason: `AGENT_LINK_HOST=${declared}` };
  }
  const ignored = declared ? ` (ignored unknown AGENT_LINK_HOST=${JSON.stringify(declared)})` : "";
  const has = (name) => Boolean(lookup(name, env).value);
  const claude = has("CLAUDE_PROJECT_DIR") || has("CLAUDE_PLUGIN_ROOT") || has("CLAUDE_SESSION_ID") || has("CLAUDE_CODE_SESSION_ID");
  const codex = has("CODEX_HOME") || has("CODEX_THREAD_ID");
  if (claude) return { host: "claude", reason: `claude env vars present${ignored}` };
  if (codex) return { host: "codex", reason: `codex env vars present${ignored}` };
  return { host: "unknown", reason: `no host env vars detected${ignored}` };
}
