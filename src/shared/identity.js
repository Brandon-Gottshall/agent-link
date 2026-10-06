// src/shared/identity.js
//
// Session addresses (design doc section 1.3). One string names a session on
// every host:
//
//   address = harness ":" id      harness = "claude" | "codex"
//   id      = 1*128( ALPHA / DIGIT / "-" / "_" )
//
// The Claude id is the Claude Code CLI session id (cliSessionId): the hook
// payload `session_id`, CLAUDE_CODE_SESSION_ID / CLAUDE_SESSION_ID, the
// transcript file name and the Desktop sidecar's `cliSessionId` all carry it.
// The Codex id is the thread id. Surface (desktop, code, cli, app) is an
// attribute of a session, never part of its address (R1.1).
//
// Legacy ids (`local_<uuid>` sidecar ids, raw CLI ids, bare thread ids) are
// canonicalized when they are read (R1.6): stored mailbox and receipt lines
// are never rewritten. `external` is a valid sender and is never addressable;
// anything that cannot be canonicalized is `invalid`.

import { env as lookupEnv } from "./env.js";
import { currentClaudeSessionId } from "./host-detect.js";

/** @typedef {"claude" | "codex"} Harness */

/**
 * @typedef {object} ParsedAddress
 * @property {Harness} harness
 * @property {string} id
 * @property {string} address
 */

/**
 * @typedef {object} HostIdentity
 * @property {string} host        claude, codex, or unknown
 * @property {string} address     the caller's address, or "external"
 * @property {string | null} turnId
 * @property {"runtime_context" | "current_session" | "env" | "fallback"} source
 */

export const HARNESSES = Object.freeze(/** @type {Harness[]} */ (["claude", "codex"]));
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const ADDRESS_PATTERN = /^(claude|codex):([A-Za-z0-9_-]{1,128})$/;
export const EXTERNAL_ADDRESS = "external";
export const INVALID_ADDRESS = "invalid";

const LOCAL_PREFIX = "local_";

/**
 * @param {unknown} value
 * @returns {value is Harness}
 */
export function isHarness(value) {
  return value === "claude" || value === "codex";
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAddress(value) {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

/**
 * Parses a strict address (`claude:<id>` or `codex:<id>`). Anything else,
 * including a bare id, `external` and surrounding whitespace, is null.
 * @param {unknown} value
 * @returns {ParsedAddress | null}
 */
export function parseAddress(value) {
  if (typeof value !== "string") return null;
  const match = ADDRESS_PATTERN.exec(value);
  if (!match) return null;
  return { harness: /** @type {Harness} */ (match[1]), id: match[2], address: value };
}

/**
 * The address for a harness and an id, or null when either is invalid.
 * @param {unknown} harness
 * @param {unknown} id
 * @returns {string | null}
 */
export function formatAddress(harness, id) {
  if (!isHarness(harness) || typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  return `${harness}:${id}`;
}

/**
 * The canonical Claude id (the session's current CLI session id) for any
 * Claude id form: an address, a `local_<x>` sidecar id, or a bare CLI id.
 *
 * Claude Desktop rotates a session's CLI id (the sidecar keeps the old ones
 * in `priorCliSessionIds`), so an id recorded earlier, or a `claude:<id>`
 * address built from it, is resolved through `lookupSession` (the
 * prior-id-aware session index) to the session's current cliSessionId.
 * Without a lookup, or when the lookup finds nothing, `local_<x>` becomes
 * `x` and a bare id stays as it is. Null when the result is not a valid id.
 * @param {unknown} value
 * @param {{lookupSession?: ((id: string) => {cliSessionId?: string | null} | null | undefined) | null}} [options]
 * @returns {string | null}
 */
export function canonicalizeClaudeId(value, { lookupSession = null } = {}) {
  if (typeof value !== "string") return null;
  let id = value.trim();
  if (id.startsWith("claude:")) id = id.slice("claude:".length);
  if (!id) return null;
  let session = null;
  if (typeof lookupSession === "function") {
    try {
      session = lookupSession(id);
    } catch {
      session = null;
    }
  }
  const cli = typeof session?.cliSessionId === "string" ? session.cliSessionId.trim() : "";
  if (cli && ID_PATTERN.test(cli)) return cli;
  if (id.startsWith(LOCAL_PREFIX)) id = id.slice(LOCAL_PREFIX.length);
  return ID_PATTERN.test(id) ? id : null;
}

/**
 * The address of a Claude session object (the session index shape) or of
 * any Claude id form. A session without a cliSessionId yet (a sidecar that
 * has not started its CLI) falls back to its sidecar id without `local_`.
 * @param {unknown} sessionOrId
 * @param {{lookupSession?: ((id: string) => any) | null}} [options]
 * @returns {string | null}
 */
export function claudeAddress(sessionOrId, options = {}) {
  if (sessionOrId && typeof sessionOrId === "object") {
    const session = /** @type {Record<string, unknown>} */ (sessionOrId);
    const fromCli = canonicalizeClaudeId(session.cliSessionId);
    if (fromCli) return formatAddress("claude", fromCli);
    return formatAddress("claude", canonicalizeClaudeId(session.sessionId) ?? "");
  }
  const id = canonicalizeClaudeId(sessionOrId, options);
  return id ? formatAddress("claude", id) : null;
}

/**
 * The address of a Codex thread id (bare or already an address).
 * @param {unknown} threadId
 * @returns {string | null}
 */
export function codexAddress(threadId) {
  if (typeof threadId !== "string") return null;
  const id = threadId.trim().startsWith("codex:") ? threadId.trim().slice("codex:".length) : threadId.trim();
  return formatAddress("codex", id);
}

/**
 * Read-time migration of one stored sender/recipient (the section 1.3
 * migration table): `external` stays, `claude` ids and `claude:` addresses
 * canonicalize through the session lookup (sidecar ids and prior CLI ids
 * resolve to the current CLI id), `codex` ids are prefixed, and anything
 * else is `invalid`.
 * @param {unknown} storedId
 * @param {unknown} storedKind  claude, codex, external, or unknown
 * @param {{lookupSession?: ((id: string) => any) | null}} [options]
 * @returns {string}
 */
export function canonicalAddress(storedId, storedKind, options = {}) {
  if (typeof storedId !== "string") return INVALID_ADDRESS;
  const id = storedId.trim();
  if (id === EXTERNAL_ADDRESS) return EXTERNAL_ADDRESS;
  const parsed = parseAddress(id);
  if (parsed) {
    return parsed.harness === "claude"
      ? claudeAddress(parsed.address, options) ?? INVALID_ADDRESS
      : parsed.address;
  }
  if (storedKind === "codex") return codexAddress(id) ?? INVALID_ADDRESS;
  if (storedKind === "claude" || id.startsWith(LOCAL_PREFIX)) return claudeAddress(id, options) ?? INVALID_ADDRESS;
  return INVALID_ADDRESS;
}

/**
 * Memoizes canonicalAddress() for a mailbox view (R1.6: migration happens
 * at read time, with a cache). Entries expire after `ttlMs`, so a sidecar
 * that appears later is picked up.
 * @param {{lookupSession?: ((id: string) => any) | null, ttlMs?: number, maxEntries?: number, now?: () => number}} [options]
 */
export function makeAddressCache({ lookupSession = null, ttlMs = 30_000, maxEntries = 2_000, now = () => Date.now() } = {}) {
  /** @type {Map<string, {address: string, at: number}>} */
  const cache = new Map();
  /**
   * @param {unknown} storedId
   * @param {unknown} storedKind
   * @returns {string}
   */
  return function cachedCanonicalAddress(storedId, storedKind) {
    const key = `${String(storedKind)}\u0000${String(storedId)}`;
    const at = now();
    const hit = cache.get(key);
    if (hit && at - hit.at < ttlMs) return hit.address;
    const address = canonicalAddress(storedId, storedKind, { lookupSession });
    if (cache.size >= maxEntries) cache.delete(/** @type {string} */ (cache.keys().next().value));
    cache.set(key, { address, at });
    return address;
  };
}

/**
 * The caller's own address, from the runtime only (R1.4), never from tool
 * arguments:
 *   Codex host:  the caller `_meta` thread id, then CODEX_THREAD_ID.
 *   Claude host: the resolved current session, then CLAUDE_SESSION_ID /
 *                CLAUDE_CODE_SESSION_ID.
 *   Unknown:     CODEX_THREAD_ID, then the Claude variables.
 * Otherwise `external` (a valid sender, never addressable).
 * @param {{
 *   host?: string,
 *   callerContext?: {threadId?: unknown, turnId?: unknown} | null,
 *   currentSession?: unknown,
 *   env?: Record<string, string | undefined>
 * }} [options]
 * @returns {HostIdentity}
 */
export function hostIdentity({ host = "unknown", callerContext = null, currentSession = null, env = process.env } = {}) {
  const turnId = typeof callerContext?.turnId === "string" && callerContext.turnId.trim() ? callerContext.turnId.trim() : null;
  const codexFromMeta = codexAddress(callerContext?.threadId);
  const codexFromEnv = codexAddress(lookupEnv("CODEX_THREAD_ID", env).value ?? null);
  const claudeFromEnv = claudeAddress(currentClaudeSessionId({ env }) ?? null);
  /**
   * @param {string} address
   * @param {HostIdentity["source"]} source
   * @param {string | null} [turn]
   * @returns {HostIdentity}
   */
  const result = (address, source, turn = null) => ({ host, address, turnId: turn, source });

  if (host === "codex") {
    if (codexFromMeta) return result(codexFromMeta, "runtime_context", turnId);
    if (codexFromEnv) return result(codexFromEnv, "env", lookupEnv("CODEX_TURN_ID", env).value ?? null);
    return result(EXTERNAL_ADDRESS, "fallback");
  }
  if (host === "claude") {
    let session = currentSession;
    if (typeof session === "function") {
      try {
        session = session();
      } catch {
        session = null;
      }
    }
    const fromSession = session ? claudeAddress(session) : null;
    if (fromSession) return result(fromSession, "current_session");
    if (claudeFromEnv) return result(claudeFromEnv, "env");
    return result(EXTERNAL_ADDRESS, "fallback");
  }
  if (codexFromEnv) return result(codexFromEnv, "env", lookupEnv("CODEX_TURN_ID", env).value ?? null);
  if (claudeFromEnv) return result(claudeFromEnv, "env");
  return result(EXTERNAL_ADDRESS, "fallback");
}
