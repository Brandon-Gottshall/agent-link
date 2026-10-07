// src/delivery/recipient.js
//
// Who is reading or answering mail (design doc R1.4, R1.13). The inbox and
// reply tools work for a Claude session and for a Codex thread alike; the
// caller is identified from the runtime only, never from tool arguments:
//
//   Claude host: the resolved current Claude session.
//   Codex host:  the caller `_meta` thread id, then CODEX_THREAD_ID.
//
// Anything else is null, and the tools fail with no_current_session.
import { canonicalClaudeSessionId, claudeSessionAliases } from "../claude/identity.js";
import { AgentLinkError } from "../shared/errors.js";
import { claudeAddress, hostIdentity, parseAddress } from "../shared/identity.js";

/**
 * @typedef {{
 *   harness: "claude" | "codex",
 *   address: string,
 *   storedId: string,
 *   aliases: string[],
 *   source: string,
 *   session: any,
 *   sessionId: string | null,
 *   threadId: string | null
 * }} Recipient
 *   storedId: the id written as from_session_id on the caller's replies
 *   aliases: every stored id the caller's mail may be addressed to
 */

/**
 * @param {{
 *   host: string,
 *   callerContext?: any,
 *   resolveCurrentSession?: (() => any) | null,
 *   env?: Record<string, string | undefined>
 * }} options
 * @returns {Recipient | null}
 */
export function currentRecipient({ host, callerContext = null, resolveCurrentSession = null, env = process.env }) {
  if (host === "claude") {
    let session = null;
    try {
      session = typeof resolveCurrentSession === "function" ? resolveCurrentSession() : null;
    } catch {
      session = null;
    }
    const address = session ? claudeAddress(session) : null;
    if (!session?.sessionId || !address) return null;
    return {
      harness: "claude",
      address,
      storedId: canonicalClaudeSessionId(session),
      aliases: claudeSessionAliases(session),
      source: "current_session",
      session,
      sessionId: session.sessionId,
      threadId: null
    };
  }
  if (host !== "codex") return null;
  const identity = hostIdentity({ host, callerContext, env });
  const parsed = parseAddress(identity.address);
  if (parsed?.harness !== "codex") return null;
  return {
    harness: "codex",
    address: parsed.address,
    storedId: parsed.id,
    aliases: [parsed.id, parsed.address],
    source: identity.source,
    session: null,
    sessionId: null,
    threadId: parsed.id
  };
}

/**
 * no_current_session for a mail tool, with a host-specific hint (R1.13).
 * @param {string} tool
 * @param {string} host
 */
export function noCurrentSession(tool, host) {
  if (host === "codex") {
    return new AgentLinkError("no_current_session", `${tool} could not identify the calling Codex thread.`, {
      details: { host: "codex", sources: ["caller _meta threadId", "CODEX_THREAD_ID"] },
      hint: "Call it from inside a Codex thread: Codex passes the thread id in the tool call's _meta, or the MCP server sees CODEX_THREAD_ID. " +
        "Without an identity there is no inbox; to message a peer use message_agent."
    });
  }
  return new AgentLinkError("no_current_session", `${tool} could not identify the current Claude session.`, {
    details: { host, sources: ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "session sidecar", "transcript"] },
    hint: "Run inside a Claude session whose sidecar or transcript is indexed, with CLAUDE_SESSION_ID or CLAUDE_CODE_SESSION_ID set."
  });
}
