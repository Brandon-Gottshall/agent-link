// src/claude/identity.js
//
// Canonical Claude session identity for the Agent Link mailbox.
//
// A Claude session can be named three ways:
//   - the Desktop sidecar id, `local_<uuid>` (stable for the session's life),
//   - the Claude Code CLI session id, a bare uuid (what CLAUDE_CODE_SESSION_ID
//     and hook payloads carry; it can change, see `priorCliSessionIds`),
//   - `local_<cliSessionId>`, the id the session index gives transcript-only
//     sessions that have no sidecar.
//
// The canonical mailbox address is the session index's `sessionId`: the
// sidecar id when a sidecar exists, otherwise `local_<cliSessionId>`. Send,
// reply, wait, receipts and every receive path use canonicalClaudeSessionId()
// to write ids, and claudeSessionAliases() to read them, so mail that older
// versions queued under the raw CLI id or the other `local_` form is still
// found.
import { env as lookupEnv } from "../shared/env.js";
import { currentClaudeSessionId } from "../shared/host-detect.js";

// Write-time check: what may be stored as a from_session_id at all.
export const SENDER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
export const UNKNOWN_SENDER = "unknown sender";
export const UNKNOWN_MESSAGE_ID = "unknown message";
export const EXTERNAL_SENDER = "external";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
// Render-time check: only the id shapes Agent Link itself produces —
// `external`, a Claude `local_<uuid>` sidecar/transcript id, or a bare uuid
// (Claude CLI session id or Codex thread id).
export const KNOWN_SENDER_PATTERN = new RegExp(`^(?:external|(?:local_)?${UUID})$`);
// Mailbox message ids are ULIDs (Crockford base32, 26 characters).
export const MESSAGE_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const KNOWN_KINDS = new Set(["claude", "codex", "external"]);

export function isValidSenderId(id) {
  return typeof id === "string" && SENDER_ID_PATTERN.test(id);
}

export function isKnownSenderId(id) {
  return typeof id === "string" && KNOWN_SENDER_PATTERN.test(id);
}

// Sender ids reach hidden hook context and visible transcript blocks. Only
// known shapes are rendered; anything else could carry markup or
// instructions and is shown as "unknown sender".
export function displaySenderId(id) {
  return isKnownSenderId(id) ? id : UNKNOWN_SENDER;
}

export function displaySenderKind(kind) {
  return typeof kind === "string" && KNOWN_KINDS.has(kind) ? kind : "unknown";
}

export function displayMessageId(id) {
  return typeof id === "string" && MESSAGE_ID_PATTERN.test(id) ? id : UNKNOWN_MESSAGE_ID;
}

export function canonicalClaudeSessionId(sessionOrId) {
  if (sessionOrId && typeof sessionOrId === "object") {
    if (typeof sessionOrId.sessionId === "string" && sessionOrId.sessionId.trim()) {
      return sessionOrId.sessionId.trim();
    }
    return canonicalClaudeSessionId(sessionOrId.cliSessionId);
  }
  const id = typeof sessionOrId === "string" ? sessionOrId.trim() : "";
  if (!id) return null;
  return id.startsWith("local_") ? id : `local_${id}`;
}

export function claudeSessionAliases(sessionOrId) {
  const out = new Set();
  const add = (value) => {
    if (typeof value !== "string") return;
    const v = value.trim();
    if (v) out.add(v);
  };
  const addCli = (cli) => {
    if (typeof cli !== "string" || !cli.trim()) return;
    const v = cli.trim();
    if (v.startsWith("local_")) {
      add(v);
      add(v.slice("local_".length));
    } else {
      add(v);
      add(`local_${v}`);
    }
  };
  if (sessionOrId && typeof sessionOrId === "object") {
    add(sessionOrId.sessionId);
    addCli(sessionOrId.cliSessionId);
    for (const prior of Array.isArray(sessionOrId.priorCliSessionIds) ? sessionOrId.priorCliSessionIds : []) {
      addCli(prior);
    }
    for (const extra of Array.isArray(sessionOrId.aliases) ? sessionOrId.aliases : []) add(extra);
  } else {
    addCli(sessionOrId);
  }
  return [...out];
}

export function claudeSessionMatches(session, id) {
  if (!session || typeof id !== "string" || !id.trim()) return false;
  return claudeSessionAliases(session).includes(id.trim());
}

// Who is calling a mailbox tool. `id` is the canonical address written as
// `from_session_id` and used as the reply target; `aliases` are every id the
// caller's mail may be addressed to.
//
// Claude host: the resolved current session wins, then the env CLI id. MCP
// runtime metadata is a Codex concept and is only a last resort here, so a
// loosely-shaped `_meta` can never impersonate the session.
// Codex host: the runtime caller thread, then CODEX_THREAD_ID.
// Anything that fails SENDER_ID_PATTERN falls through to "external".
/**
 * @param {{host?: string, runtimeCallerContext?: any, currentSession?: any, env?: NodeJS.ProcessEnv}} [options]
 */
export function resolveCallerIdentity({ host, runtimeCallerContext = null, currentSession = null, env = process.env } = {}) {
  const runtimeThreadId = isValidSenderId(runtimeCallerContext?.threadId) ? runtimeCallerContext.threadId : null;
  if (host === "claude") {
    const session = typeof currentSession === "function" ? safeCall(currentSession) : currentSession;
    const sessionId = canonicalClaudeSessionId(session);
    if (session && isValidSenderId(sessionId)) {
      return { id: sessionId, kind: "claude", aliases: claudeSessionAliases(session), source: "current_session" };
    }
    const envId = currentClaudeSessionId({ env });
    const canonicalEnvId = canonicalClaudeSessionId(envId);
    if (isValidSenderId(canonicalEnvId)) {
      return { id: canonicalEnvId, kind: "claude", aliases: claudeSessionAliases(envId), source: "env" };
    }
    if (runtimeThreadId) {
      return { id: runtimeThreadId, kind: "claude", aliases: [runtimeThreadId], source: "runtime_context" };
    }
    return { id: EXTERNAL_SENDER, kind: "claude", aliases: [EXTERNAL_SENDER], source: "fallback" };
  }
  if (host === "codex") {
    if (runtimeThreadId) {
      return { id: runtimeThreadId, kind: "codex", aliases: [runtimeThreadId], source: "runtime_context" };
    }
    const envThread = lookupEnv("CODEX_THREAD_ID", env).value;
    if (isValidSenderId(envThread)) {
      return { id: envThread, kind: "codex", aliases: [envThread], source: "env" };
    }
    return { id: EXTERNAL_SENDER, kind: "codex", aliases: [EXTERNAL_SENDER], source: "fallback" };
  }
  return { id: EXTERNAL_SENDER, kind: "external", aliases: [EXTERNAL_SENDER], source: "fallback" };
}

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
