// src/registry/index.js
//
// The session registry (design doc section 1.4): one interface over Claude
// sessions and Codex threads, with both providers active on every host.
//
//   list({harness?, surface?, loaded?, includeArchived?, limit}) -> {sessions, providers, warnings}
//   get(addressOrId)                                             -> AgentSession, or not_found / ambiguous
//   resolve({query, harness?, limit})                            -> {status, best, candidates, selection, ...}
//
// A provider that cannot answer contributes no sessions and a warning; it
// never fails the whole call (R1.8).

import { AgentLinkError } from "../shared/errors.js";
import { ID_PATTERN, parseAddress } from "../shared/identity.js";

/**
 * A session as the registry reports it. Host-specific fields (sessionId and
 * cliSessionId for Claude; threadId and status for Codex) are additional
 * (R1.2). No session carries another agent's text: titles are metadata, and
 * Codex previews stay on list_codex_threads.
 * @typedef {{
 *   address: string,
 *   harness: "claude" | "codex",
 *   id: string,
 *   title: string | null,
 *   cwd: string | null,
 *   surface: string[],
 *   loaded: boolean,
 *   archived: boolean,
 *   lastActivityAt: string | null,
 *   receive: {push: string | null, nudge: string | null, pull: boolean},
 *   [key: string]: any
 * }} AgentSession
 */

/**
 * @typedef {{
 *   available: boolean,
 *   reason: string | null,
 *   source: string | null,
 *   sessions: AgentSession[],
 *   warnings: {code: string, message: string}[],
 *   searched?: string[]
 * }} ProviderList
 */

/**
 * @typedef {{
 *   harness: "claude" | "codex",
 *   list: (options: {includeArchived?: boolean, limit?: number, searchTerm?: string}) => Promise<ProviderList>,
 *   get: (id: string) => Promise<AgentSession | null>
 * }} SessionProvider
 */

export const AGENT_SURFACES = Object.freeze(["desktop", "code", "cli", "app"]);

// Ids that are worth an exact lookup in both registries: UUIDs (Claude CLI
// session ids and Codex thread ids) and Claude `local_<uuid>` sidecar ids.
const LOOKS_LIKE_ID = /^(?:local_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {AgentSession} session
 */
function activityMs(session) {
  const ms = Date.parse(session.lastActivityAt ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

/** @param {AgentSession} a @param {AgentSession} b */
const newestFirst = (a, b) => activityMs(b) - activityMs(a) || a.address.localeCompare(b.address);

/** @param {unknown} value */
const norm = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

/**
 * Host-neutral match score for resolve_agent. One scale for both harnesses,
 * so candidates from Claude and Codex rank against each other:
 *   exact address or id (any id form)      1000
 *   id prefix / partial id                  300 / 150
 *   title exact / prefix / contains / words 400 / 300 / 200 / 100
 *   cwd basename exact / cwd contains       120 / 60
 * Ties break by most recent activity.
 * @param {AgentSession} session
 * @param {string} query
 * @returns {{score: number, reasons: string[]}}
 */
export function scoreAgent(session, query) {
  const q = norm(query);
  if (!q) return { score: 0, reasons: [] };
  const reasons = [];
  let score = 0;
  const ids = [session.address, session.id, session.sessionId, session.cliSessionId, session.threadId].map(norm).filter(Boolean);
  if (ids.includes(q)) {
    score += 1000;
    reasons.push("id-exact");
  } else if (q.length >= 4 && ids.some((id) => id.startsWith(q))) {
    score += 300;
    reasons.push("id-prefix");
  } else if (q.length >= 4 && ids.some((id) => id.includes(q))) {
    score += 150;
    reasons.push("id-partial");
  }
  const title = norm(session.title);
  if (title) {
    if (title === q) { score += 400; reasons.push("title-exact"); }
    else if (title.startsWith(q)) { score += 300; reasons.push("title-prefix"); }
    else if (title.includes(q)) { score += 200; reasons.push("title-contains"); }
    else if (q.split(/\s+/).every((word) => title.includes(word))) { score += 100; reasons.push("title-words"); }
  }
  const cwd = norm(session.cwd);
  if (cwd) {
    const base = cwd.split("/").filter(Boolean).pop() ?? "";
    if (base === q) { score += 120; reasons.push("cwd-basename"); }
    else if (cwd.includes(q)) { score += 60; reasons.push("cwd-contains"); }
  }
  return { score, reasons };
}

/**
 * @param {{claude: SessionProvider, codex: SessionProvider}} providers
 */
export function createSessionRegistry(providers) {
  /**
   * @param {string | undefined} harness
   * @returns {SessionProvider[]}
   */
  function selected(harness) {
    if (harness === "claude") return [providers.claude];
    if (harness === "codex") return [providers.codex];
    return [providers.claude, providers.codex];
  }

  /**
   * @param {Record<string, ProviderList>} results
   */
  function providerSummary(results) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [harness, result] of Object.entries(results)) {
      out[harness] = {
        available: result.available,
        reason: result.reason,
        source: result.source,
        count: result.sessions.length
      };
    }
    return out;
  }

  /**
   * @param {{harness?: string, surface?: string, loaded?: boolean, includeArchived?: boolean, limit?: number}} [options]
   */
  async function list({ harness, surface, loaded, includeArchived = false, limit = 20 } = {}) {
    const filtered = surface !== undefined || loaded !== undefined;
    /** @type {Record<string, ProviderList>} */
    const results = {};
    await Promise.all(selected(harness).map(async (provider) => {
      // Each provider returns newest first, so `limit` from each is enough
      // for the merged top `limit`, unless a filter drops rows afterwards.
      results[provider.harness] = await provider.list({ includeArchived, limit: filtered ? 200 : limit });
    }));
    const sessions = Object.values(results)
      .flatMap((result) => result.sessions)
      .filter((session) => includeArchived || !session.archived)
      .filter((session) => surface === undefined || session.surface.includes(surface))
      .filter((session) => loaded === undefined || session.loaded === loaded)
      .sort(newestFirst)
      .slice(0, limit);
    return {
      sessions,
      providers: providerSummary(results),
      warnings: Object.values(results).flatMap((result) => result.warnings)
    };
  }

  /**
   * Every session an address or bare id names exactly: one provider for an
   * address, both for a bare id.
   * @param {string} value
   * @returns {Promise<AgentSession[]>}
   */
  async function exactMatches(value) {
    const parsed = parseAddress(value);
    const found = parsed
      ? [await providers[parsed.harness].get(parsed.id)]
      : await Promise.all([providers.claude.get(value), providers.codex.get(value)]);
    return found.filter(/** @returns {s is AgentSession} */ (s) => s !== null);
  }

  /**
   * Exact lookup by address or bare id. A bare id known to both registries
   * is ambiguous (R1.3).
   * @param {string} addressOrId
   * @returns {Promise<AgentSession>}
   */
  async function get(addressOrId) {
    const value = String(addressOrId ?? "").trim();
    if (!parseAddress(value) && (!value || !ID_PATTERN.test(value))) {
      throw new AgentLinkError("invalid_arguments", `${JSON.stringify(value.slice(0, 80))} is not an address (claude:<id> or codex:<id>) or a session id.`, {
        details: { errors: [{ path: "agent", rule: "format", expected: "claude:<id>, codex:<id>, or a bare session id" }] }
      });
    }
    const matches = await exactMatches(value);
    if (matches.length === 0) throw notFound(value);
    if (matches.length > 1) {
      throw new AgentLinkError("ambiguous", `${value} names a Claude session and a Codex thread.`, {
        details: { query: value, candidates: matches.map(brief) },
        hint: "Pass the address (claude:<id> or codex:<id>) instead of the bare id."
      });
    }
    return matches[0];
  }

  /**
   * @param {{query: string, harness?: string, limit?: number}} options
   */
  async function resolve({ query, harness, limit = 10 }) {
    const q = String(query ?? "").trim();
    const wanted = (/** @type {AgentSession} */ session) => harness === undefined || harness === "all" || session.harness === harness;
    // An address or a UUID-shaped id is looked up exactly first. An address
    // that matches nothing is not_found; a bare id that matches nothing is
    // then tried as a fuzzy query.
    const parsed = parseAddress(q);
    if (parsed || LOOKS_LIKE_ID.test(q)) {
      const candidates = (await exactMatches(q)).filter(wanted).map((session) => ({ ...session, score: 1000, matchReasons: ["id-exact"] }));
      if (candidates.length > 0 || parsed) {
        const status = candidates.length === 0 ? "not_found" : candidates.length > 1 ? "ambiguous" : "resolved";
        return {
          status,
          query: q,
          best: candidates[0] ?? null,
          candidates,
          selection: { ambiguous: candidates.length > 1, tiedCount: candidates.length, matchReasons: candidates.length ? ["id-exact"] : [] },
          providers: null
        };
      }
    }

    /** @type {Record<string, ProviderList>} */
    const results = {};
    await Promise.all(selected(harness).map(async (provider) => {
      results[provider.harness] = await provider.list({ includeArchived: true, limit: 200, searchTerm: provider.harness === "codex" ? q : "" });
    }));
    const scored = Object.values(results)
      .flatMap((result) => result.sessions)
      .map((session) => ({ session, ...scoreAgent(session, q) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || newestFirst(a.session, b.session));
    const candidates = scored.slice(0, limit).map(({ session, score, reasons }) => ({ ...session, score, matchReasons: reasons }));
    const top = scored[0];
    const tiedCount = top ? scored.filter((entry) => entry.score === top.score).length : 0;
    const status = !top ? "not_found" : tiedCount > 1 ? "ambiguous" : "resolved";
    return {
      status,
      query: q,
      best: candidates[0] ?? null,
      candidates,
      selection: { ambiguous: tiedCount > 1, tiedCount, matchReasons: top?.reasons ?? [] },
      providers: providerSummary(results),
      warnings: Object.values(results).flatMap((result) => result.warnings)
    };
  }

  return { list, get, resolve };
}

/**
 * @param {AgentSession} session
 */
function brief(session) {
  return { address: session.address, harness: session.harness, title: session.title, cwd: session.cwd, archived: session.archived };
}

/**
 * @param {string} value
 */
function notFound(value) {
  return new AgentLinkError("not_found", `No Claude session or Codex thread matches ${JSON.stringify(value.slice(0, 80))}.`, {
    details: { query: value, candidates: [] },
    hint: "Call list_agents or resolve_agent to find an address."
  });
}
