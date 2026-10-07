// src/delivery/codex-push.js
//
// Codex push (design doc R1.10–R1.12a). Every peer message to a Codex
// thread is a mailbox record first; this module then tries to show it to the
// thread as a turn through the app-server Agent Link is connected to:
//
//   - idle or not loaded: thread/resume when needed, then turn/start with
//     input = [text(envelope)], turnTrigger "agent-link" and
//     clientUserMessageId = the mailbox message id;
//   - active: turn/steer with the same input and clientUserMessageId.
//
// Success marks the message delivered (deliveredVia "codex-turn", with the
// thread's address as `to`). Failure leaves it queued and returns the push
// error as a warning; the inbox (read_agent_link_inbox) and the background
// delivery pass still reach it. Every push takes a claim beside the mailbox
// before the app-server request (claim-before-notify, audit P4-10), so two
// processes never push the same message twice.
//
// Desktop-app threads (R1.12a), decided by the B7 spike (codex-cli 0.159.2,
// docs/design/b7-spike-results.md): the mode is "mailbox-only". ChatGPT.app
// runs its own stdio app-server and no daemon control socket exists, so
// Agent Link's endpoint never serves the desktop app's threads. A thread that
// is not loaded in the endpoint Agent Link is connected to (its
// thread/loaded/list; thread/read reports such a thread as notLoaded) counts
// as held and gets no turn/start or turn/steer at all, reminder turns
// included; the message stays queued with a codex_desktop_push_disabled
// warning. A thread Agent Link launched stays pushable only while it is loaded
// in that endpoint; after the endpoint restarts it is mailbox-only. lsof on a
// thread's rollout file is diagnostic only and never a held signal here.
//
// Spike facts this module relies on: turn/start on an ACTIVE thread does not
// fail, it steers the active turn and returns {turn: {id: <active id>,
// status: "inProgress"}} (turnTrigger ignored), so a returned turn id equal
// to the active one is reported as a steer; turn/steer returns {turnId};
// clientUserMessageId comes back as `clientId` on the userMessage item
// (item/started, item/completed), which confirms a delivery.
import { env } from "../shared/env.js";
import { peerMessageFromMailbox, renderPeerEnvelope } from "../shared/envelope.js";

export const CODEX_PUSH_TURN_TRIGGER = "agent-link";
export const CODEX_PUSH_VIA = "codex-turn";
export const DESKTOP_PUSH_MODES = Object.freeze(["mailbox-only", "shared-daemon"]);
export const DEFAULT_DESKTOP_PUSH_MODE = "mailbox-only";
// The Codex version the B7 spike verified the mode on (R1.12a).
export const VERIFIED_CODEX_VERSION = "0.159.2";
// The app-server notification that reports a finished turn (B7 spike):
// turn/completed {threadId, turn: {id, items, status: completed |
// interrupted | failed, error, startedAt, completedAt, durationMs}}.
export const CODEX_TURN_COMPLETED_METHOD = "turn/completed";
export const CODEX_TURN_STARTED_METHOD = "turn/started";
export const CODEX_THREAD_STATUS_METHOD = "thread/status/changed";
const MESSAGE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * @typedef {{
 *   mode: "mailbox-only" | "shared-daemon",
 *   source: string,
 *   verifiedCodexVersion: string | null,
 *   heldSignal: string,
 *   isHeld: (status: unknown) => boolean
 * }} DesktopPushPolicy
 */

/**
 * The one decision the B7 spike makes (R1.12a): whether Agent Link pushes
 * into threads the Codex desktop app holds, and how a held thread is told
 * apart. In mailbox-only mode (the default and the spike's result) the held
 * signal is the conservative one: a thread not loaded in the connected
 * endpoint is held, which never creates a second writer.
 *
 * AGENT_LINK_CODEX_DESKTOP_PUSH=shared-daemon resumes a not-loaded thread in
 * Agent Link's endpoint and pushes to it. If the desktop app has that thread
 * open in its own app-server, two processes then write one transcript (a
 * second writer). It is honoured only when the endpoint was chosen
 * explicitly (AGENT_LINK_CODEX_URL or AGENT_LINK_CODEX_SOCK), never for
 * Agent Link's private managed app-server; otherwise it is refused, reported
 * in health, and mailbox-only applies.
 * @param {Record<string, string | undefined>} [source]
 * @returns {DesktopPushPolicy & {refused: string | null}}
 */
export function desktopPushPolicy(source = process.env) {
  const configured = env("AGENT_LINK_CODEX_DESKTOP_PUSH", source).value;
  const valid = typeof configured === "string" && DESKTOP_PUSH_MODES.includes(configured.trim());
  let mode = /** @type {"mailbox-only" | "shared-daemon"} */ (valid ? /** @type {string} */ (configured).trim() : DEFAULT_DESKTOP_PUSH_MODE);
  /** @type {string | null} */
  let refused = null;
  if (mode === "shared-daemon" && !explicitEndpoint(source)) {
    refused = "shared-daemon";
    mode = DEFAULT_DESKTOP_PUSH_MODE;
  }
  return {
    mode,
    source: valid && !refused ? "AGENT_LINK_CODEX_DESKTOP_PUSH" : "default",
    refused,
    verifiedCodexVersion: VERIFIED_CODEX_VERSION,
    heldSignal: "not-loaded-in-endpoint",
    isHeld: (status) => mode === "mailbox-only" && statusType(status) === "notLoaded"
  };
}

/**
 * True when the Codex endpoint was chosen explicitly (not a managed one).
 * @param {Record<string, string | undefined>} source
 */
function explicitEndpoint(source) {
  return ["AGENT_LINK_CODEX_URL", "AGENT_LINK_CODEX_SOCK"].some((name) => {
    const value = env(name, source).value;
    return typeof value === "string" && value.trim() !== "";
  });
}

/**
 * health.codex.desktopPush (R1.12a). Warns when the installed Codex differs
 * from the version the mode was verified on.
 * @param {Record<string, string | undefined>} [source]
 * @param {string | null} [installedVersion]
 */
export function desktopPushReport(source = process.env, installedVersion = null) {
  const configured = env("AGENT_LINK_CODEX_DESKTOP_PUSH", source).value;
  const policy = desktopPushPolicy(source);
  const warnings = [];
  if (typeof configured === "string" && configured.trim() && !DESKTOP_PUSH_MODES.includes(configured.trim())) {
    warnings.push({ code: "invalid_setting", message: `AGENT_LINK_CODEX_DESKTOP_PUSH=${JSON.stringify(configured).slice(0, 40)} is not one of ${DESKTOP_PUSH_MODES.join(", ")}; using ${DEFAULT_DESKTOP_PUSH_MODE}.` });
  }
  if (policy.refused) {
    warnings.push({ code: "desktop_push_override_refused", message: "AGENT_LINK_CODEX_DESKTOP_PUSH=shared-daemon is refused: it would resume desktop-app threads in Agent Link's private app-server and make it a second writer to their transcripts. It is honoured only with an explicit AGENT_LINK_CODEX_URL or AGENT_LINK_CODEX_SOCK; using mailbox-only." });
  }
  const installed = versionNumber(installedVersion);
  if (installed && installed !== policy.verifiedCodexVersion) {
    warnings.push({ code: "codex_version_differs", message: `Desktop push mode ${policy.mode} was verified on Codex ${policy.verifiedCodexVersion}; the installed Codex is ${installed}. Re-run the B7 spike checks before relying on push into desktop-app threads.` });
  }
  if (policy.mode === "shared-daemon") {
    warnings.push({ code: "desktop_push_unverified", message: "shared-daemon mode is unverified and can make Agent Link a second writer to a thread the desktop app has open: the B7 spike found no daemon control socket, and the desktop app runs its own app-server." });
  }
  return {
    mode: policy.mode,
    source: policy.source,
    refused: policy.refused,
    verifiedCodexVersion: policy.verifiedCodexVersion,
    installedCodexVersion: installed,
    heldSignal: policy.heldSignal,
    turnCompletedMethod: CODEX_TURN_COMPLETED_METHOD,
    warnings
  };
}

/**
 * The thread id of a turn-completion notification, or null for any other
 * message. The single place the spike's method name lands (R7.14).
 * @param {unknown} message  a JSON-RPC notification from the app-server
 * @returns {string | null}
 */
export function completedTurnThreadId(message) {
  const m = /** @type {Record<string, any> | null} */ (message && typeof message === "object" ? message : null);
  if (!m || m.method !== CODEX_TURN_COMPLETED_METHOD) return null;
  const params = m.params ?? {};
  const threadId = params.threadId ?? params.thread?.id ?? params.turn?.threadId ?? null;
  return typeof threadId === "string" && threadId ? threadId : null;
}

/**
 * The x.y.z part of a version string (`codex-cli 0.159.2` -> `0.159.2`).
 * @param {unknown} value
 * @returns {string | null}
 */
function versionNumber(value) {
  const match = /(\d+\.\d+\.\d+)/.exec(String(value ?? ""));
  return match ? match[1] : null;
}

/**
 * A delivery confirmation: the userMessage item a pushed message became,
 * carrying the mailbox message id as `clientId` (B7 spike). Null for
 * anything else.
 * @param {unknown} message  a JSON-RPC notification
 * @returns {{threadId: string, turnId: string | null, messageId: string} | null}
 */
export function deliveredClientId(message) {
  const m = /** @type {Record<string, any> | null} */ (message && typeof message === "object" ? message : null);
  if (!m || (m.method !== "item/started" && m.method !== "item/completed")) return null;
  const item = m.params?.item;
  if (item?.type !== "userMessage" || typeof item.clientId !== "string" || !MESSAGE_ID.test(item.clientId)) return null;
  const threadId = m.params?.threadId;
  if (typeof threadId !== "string" || !threadId) return null;
  return { threadId, turnId: typeof m.params?.turnId === "string" ? m.params.turnId : null, messageId: item.clientId };
}

/**
 * What Agent Link's endpoint has told it about each thread, from
 * notifications only: thread/status/changed, turn/started, turn/completed.
 * "Known idle" is the only state in which a reminder turn is sent (R7.14):
 * turn/start on an active thread would steer it instead (B7 spike). The
 * remaining race (a turn starting between the notification and our
 * turn/start) is accepted; it is milliseconds wide. The server clears it
 * whenever its endpoint connection closes or is replaced: what one
 * app-server process said about a thread says nothing about the next.
 */
export function makeThreadStatusTracker() {
  /** @type {Map<string, {type: string, activeTurnId: string | null, at: number}>} */
  const threads = new Map();
  return {
    /**
     * @param {unknown} message
     * @param {number} [now]
     * @returns {{threadId: string, idle: boolean} | null}  the thread whose state changed
     */
    observe(message, now = Date.now()) {
      const m = /** @type {Record<string, any> | null} */ (message && typeof message === "object" ? message : null);
      const threadId = typeof m?.params?.threadId === "string" ? m.params.threadId : null;
      if (!m || !threadId) return null;
      const previous = threads.get(threadId);
      if (m.method === CODEX_THREAD_STATUS_METHOD) {
        const type = statusType(m.params.status);
        if (!type) return null;
        threads.set(threadId, { type, activeTurnId: type === "active" ? previous?.activeTurnId ?? null : null, at: now });
        return { threadId, idle: type === "idle" };
      }
      if (m.method === CODEX_TURN_STARTED_METHOD) {
        threads.set(threadId, { type: "active", activeTurnId: typeof m.params.turn?.id === "string" ? m.params.turn.id : null, at: now });
        return { threadId, idle: false };
      }
      if (completedTurnThreadId(m)) {
        threads.set(threadId, { type: "idle", activeTurnId: null, at: now });
        return { threadId, idle: true };
      }
      return null;
    },
    /** @param {string} threadId */
    get(threadId) {
      return threads.get(threadId) ?? null;
    },
    /** @param {string} threadId */
    isKnownIdle(threadId) {
      return threads.get(threadId)?.type === "idle";
    },
    /** @param {string} threadId */
    activeTurnId(threadId) {
      const entry = threads.get(threadId);
      return entry?.type === "active" ? entry.activeTurnId : null;
    },
    /**
     * A turn/start or turn/steer was just accepted: the thread is busy until
     * the endpoint reports otherwise (one turn at a time, F4).
     * @param {string} threadId
     * @param {string | null} [turnId]
     * @param {number} [now]
     */
    markActive(threadId, turnId = null, now = Date.now()) {
      const previous = threads.get(threadId);
      threads.set(threadId, { type: "active", activeTurnId: turnId ?? previous?.activeTurnId ?? null, at: now });
    },
    /** @param {string} threadId */
    forget(threadId) {
      threads.delete(threadId);
    },
    /** Forget everything: the endpoint went away or was replaced. */
    clear() {
      threads.clear();
    },
    /** How many threads the tracker knows. */
    get size() {
      return threads.size;
    }
  };
}

/** @param {unknown} status */
export function statusType(status) {
  if (typeof status === "string") return status;
  const type = /** @type {any} */ (status)?.type;
  return typeof type === "string" ? type : null;
}

/** The app-server's user text input for one turn (asUserTextInput's shape). */
/** @param {string} text */
export function textInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

/**
 * The envelope a Codex turn carries for a mailbox row: renderPeerEnvelope of
 * the stored message, so its reply line names reply_agent_link_message
 * (R1.15, R2.6a). `overrides` are the turn settings actually sent.
 * @param {Record<string, any>} row
 * @param {Record<string, any> | null} [overrides]
 */
export function codexTurnText(row, overrides = null) {
  return renderPeerEnvelope({ ...peerMessageFromMailbox(row), ...(overrides ? { overrides } : {}) });
}

/**
 * @typedef {{
 *   delivery: "delivered" | "queued",
 *   deliveredVia: "codex-turn" | null,
 *   request: "turn/start" | "turn/steer" | null,
 *   steered: boolean,
 *   resumed: boolean,
 *   response: any,
 *   warnings: Array<Record<string, any>>,
 *   error: {message: string, method: string | null} | null
 * }} PushResult
 */

/**
 * Deny-only check (R1.12a, B7 spike): is the thread's rollout file open in a
 * process other than Agent Link's endpoint? When it is, another app-server
 * (the desktop app's) has the thread loaded, so a push would be a second
 * writer. src/codex/rollout-holders.js builds it; it never blocks when it
 * cannot answer.
 * @typedef {(rolloutPath: string | null | undefined) => Promise<{held: boolean, checked: boolean, reason?: string}>} RolloutCheck
 */

/** @typedef {ReturnType<typeof makeThreadStatusTracker>} ThreadStatusTracker */

/**
 * Pushes one mailbox message to a Codex thread (R1.11).
 *
 * `plan` is decided by the caller from the thread's status: "start"
 * (turn/start, after thread/resume when `resume` is set) or "steer"
 * (turn/steer with expectedTurnId), or "held" (nothing is sent).
 * @param {{
 *   appServer: {request: (method: string, params?: any) => Promise<any>},
 *   mailbox: ReturnType<import("../claude/mailbox.js").openMailbox>,
 *   messageId: string,
 *   threadId: string,
 *   text: string,
 *   plan: "start" | "steer" | "held",
 *   resume?: Record<string, any> | null,
 *   startParams?: Record<string, any>,
 *   expectedTurnId?: string | null,
 *   turnTrigger?: string,
 *   tracker?: ThreadStatusTracker | null,
 *   rolloutPath?: string | null,
 *   rolloutCheck?: RolloutCheck | null
 * }} options
 *   tracker: the server's thread status tracker. Its active turn id tells a
 *   turn/start that steered apart from a new turn (B7 spike), and an
 *   accepted turn marks the thread active at once (one turn at a time).
 *   rolloutPath / rolloutCheck: the deny-only "open elsewhere" check (R1.12a).
 * @returns {Promise<PushResult>}
 */
export async function pushCodexMessage({ appServer, mailbox, messageId, threadId, text, plan, resume = null, startParams = {}, expectedTurnId = null, turnTrigger = CODEX_PUSH_TURN_TRIGGER, tracker = null, rolloutPath = null, rolloutCheck = null }) {
  /** @type {PushResult} */
  const result = { delivery: "queued", deliveredVia: null, request: null, steered: false, resumed: false, response: null, warnings: [], error: null };
  if (plan === "held") {
    result.warnings.push(heldWarning(threadId));
    return result;
  }
  if (rolloutCheck) {
    const elsewhere = await safeRolloutCheck(rolloutCheck, rolloutPath);
    if (elsewhere.held) {
      result.warnings.push(openElsewhereWarning(threadId));
      return result;
    }
  }
  const claimKey = pushClaimKey(messageId);
  if (!mailbox.claim(claimKey)) {
    // Another process is pushing (or pushed) this message.
    result.warnings.push({ code: "codex_push_claimed_elsewhere", message: `Another Agent Link process is delivering message ${messageId}; it stays queued here.`, details: { messageId } });
    return result;
  }
  const activeTurnId = plan === "start" ? tracker?.activeTurnId(threadId) ?? null : null;
  const input = textInput(text);
  /** @type {string | null} */
  let method = null;
  try {
    if (plan === "steer") {
      method = "turn/steer";
      result.response = await appServer.request("turn/steer", { threadId, input, expectedTurnId, clientUserMessageId: messageId });
    } else {
      if (resume) {
        method = "thread/resume";
        await appServer.request("thread/resume", resume);
        result.resumed = true;
      }
      method = "turn/start";
      result.response = await appServer.request("turn/start", {
        ...startParams,
        threadId,
        input,
        turnTrigger,
        clientUserMessageId: messageId
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.error = { message, method };
    // The request may have reached the thread even though it failed or
    // timed out: look for the userMessage item carrying this id (clientId)
    // before letting anyone push it again.
    const seen = method === "thread/resume" ? { found: false } : await findClientIdDelivery(appServer, threadId, messageId);
    if (seen.found) {
      mailbox.markDelivered({ messageId, to: `codex:${threadId}`, via: CODEX_PUSH_VIA });
      tracker?.markActive(threadId, null);
      result.delivery = "delivered";
      result.deliveredVia = CODEX_PUSH_VIA;
      result.request = /** @type {"turn/start" | "turn/steer"} */ (method);
      result.warnings.push({ code: "codex_push_response_lost", message: `${method} failed (${message.slice(0, 200)}), but codex:${threadId} shows the message (clientId ${messageId}), so it counts as delivered.`, details: { messageId, method } });
      return result;
    }
    if (seen.found === false) {
      // Not there: released so a later pass (or the inbox) can deliver it.
      mailbox.removeClaim(claimKey);
    }
    result.warnings.push({
      code: "codex_push_failed",
      message: `The message is queued in the mailbox; pushing it to codex:${threadId} failed${method ? ` at ${method}` : ""}: ${message}`.slice(0, 600),
      details: { messageId, method, rpcCode: /** @type {any} */ (error)?.code ?? null, verified: seen.found === false },
      hint: seen.found === false
        ? "The thread can read it with read_agent_link_inbox; Agent Link retries the push when the thread is idle."
        : "Whether the thread got it could not be checked; Agent Link checks again within minutes before any retry. The thread can read it with read_agent_link_inbox."
    });
    return result;
  }
  result.request = /** @type {"turn/start" | "turn/steer"} */ (method);
  // B7 spike: turn/start on a thread that became active steers its turn and
  // returns that turn's id instead of a new one.
  const startedId = result.response?.turn?.id ?? null;
  if (method === "turn/steer" || (method === "turn/start" && startedId && activeTurnId && startedId === activeTurnId)) {
    result.request = "turn/steer";
    result.steered = true;
  }
  // The thread is busy from now on: no second turn/start races this one.
  // The active turn id itself comes only from the endpoint's turn/started
  // (steer detection relies on what the endpoint reported).
  tracker?.markActive(threadId, null);
  mailbox.markDelivered({ messageId, to: `codex:${threadId}`, via: CODEX_PUSH_VIA });
  result.delivery = "delivered";
  result.deliveredVia = CODEX_PUSH_VIA;
  return result;
}

/** @param {string} messageId */
export function pushClaimKey(messageId) {
  return `push-${messageId}`;
}

/**
 * Whether the thread shows a userMessage item whose clientId is the message
 * id (B7 spike: clientUserMessageId comes back as clientId). found is null
 * when the thread could not be read.
 * @param {{request: (method: string, params?: any) => Promise<any>}} appServer
 * @param {string} threadId
 * @param {string} messageId
 * @returns {Promise<{found: boolean | null, turnId?: string | null}>}
 */
export async function findClientIdDelivery(appServer, threadId, messageId) {
  let thread;
  try {
    thread = (await appServer.request("thread/read", { threadId, includeTurns: true }))?.thread;
  } catch {
    return { found: null };
  }
  for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (item?.type === "userMessage" && item.clientId === messageId) {
        return { found: true, turnId: typeof turn.id === "string" ? turn.id : null };
      }
    }
  }
  return { found: false };
}

/**
 * @param {RolloutCheck} check
 * @param {string | null | undefined} rolloutPath
 */
async function safeRolloutCheck(check, rolloutPath) {
  try {
    return await check(rolloutPath);
  } catch {
    return { held: false, checked: false, reason: "check_failed" };
  }
}

/** @param {string} threadId */
export function heldWarning(threadId) {
  return {
    code: "codex_desktop_push_disabled",
    message: `codex:${threadId} is not loaded in Agent Link's Codex app-server, so it is treated as held by the Codex desktop app (desktop push mode mailbox-only, R1.12a). The message is queued in the mailbox; the thread reads it with read_agent_link_inbox.`,
    details: { address: `codex:${threadId}`, mode: "mailbox-only" }
  };
}

/** @param {string} threadId */
export function openElsewhereWarning(threadId) {
  return {
    code: "codex_desktop_push_disabled",
    message: `codex:${threadId} is open in another Codex process (its transcript is held by a process other than Agent Link's app-server), so it is treated as held (R1.12a) and gets no turn. The message is queued in the mailbox; the thread reads it with read_agent_link_inbox.`,
    details: { address: `codex:${threadId}`, mode: "mailbox-only", signal: "rollout-open-elsewhere" }
  };
}

/**
 * The check every background push and reminder turn passes immediately
 * before its turn/start (R1.12a, R7.14, B7 spike). In order:
 *   - at most one background turn per thread per pass (`sent`);
 *   - the server's tracker last saw the thread idle in its own endpoint
 *     (threads it never saw loaded there are held anyway, and nothing else
 *     is touched, so the pass never starts or keeps alive an endpoint for
 *     them);
 *   - a fresh thread/read: not held (a stale idle record never skips this),
 *     and idle;
 *   - the rollout file is not open in another process (deny-only).
 * The returned `markSent` records an accepted turn.
 * @param {{
 *   appServer: {request: (method: string, params?: any) => Promise<any>},
 *   tracker: ThreadStatusTracker,
 *   policy?: DesktopPushPolicy,
 *   rolloutCheck?: RolloutCheck | null,
 *   sent?: Set<string>
 * }} options
 */
export function makeBackgroundPreflight({ appServer, tracker, policy = desktopPushPolicy(), rolloutCheck = null, sent = new Set() }) {
  /**
   * @param {string} threadId
   * @returns {Promise<{ok: true, status: any} | {ok: false, outcome: "turn_sent_this_pass" | "not_known_idle" | "busy" | "held" | "failed", error?: string}>}
   */
  async function check(threadId) {
    if (sent.has(threadId)) return { ok: false, outcome: "turn_sent_this_pass" };
    if (!tracker.isKnownIdle(threadId)) return { ok: false, outcome: tracker.get(threadId) ? "busy" : "not_known_idle" };
    let thread;
    try {
      thread = (await appServer.request("thread/read", { threadId, includeTurns: false }))?.thread ?? null;
    } catch (error) {
      return { ok: false, outcome: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    const status = thread?.status ?? null;
    if (policy.isHeld(status)) {
      // Not loaded here any more (the endpoint restarted): forget it.
      tracker.forget(threadId);
      return { ok: false, outcome: "held" };
    }
    if (statusType(status) !== "idle") {
      tracker.markActive(threadId, null);
      return { ok: false, outcome: "busy" };
    }
    if (rolloutCheck && (await safeRolloutCheck(rolloutCheck, thread?.path)).held) return { ok: false, outcome: "held" };
    return { ok: true, status };
  }
  return {
    check,
    /**
     * @param {string} threadId
     * @param {string | null} [turnId]
     */
    markSent(threadId, turnId = null) {
      sent.add(threadId);
      tracker.markActive(threadId, turnId);
    },
    sent
  };
}

/**
 * Background delivery of queued Codex mail (R1.11): a message whose push
 * failed, a reply to a Codex sender that was busy, or a message handed over
 * to a Codex role holder (R7.20), sent within the last `maxAgeMs` (default
 * one hour; older mail is left to inbox pull). Every thread passes
 * makeBackgroundPreflight first, so only an idle thread this server saw
 * loaded in its own endpoint gets a turn, never more than one per pass, and
 * a busy thread is never steered (a thread blocked in a wait for this very
 * reply does not see it twice).
 * @param {{
 *   appServer: {request: (method: string, params?: any) => Promise<any>},
 *   mailbox: ReturnType<import("../claude/mailbox.js").openMailbox>,
 *   preflight: ReturnType<typeof makeBackgroundPreflight>,
 *   now?: number,
 *   minAgeMs?: number,
 *   maxAgeMs?: number,
 *   recipientOf: (row: Record<string, any>) => string | null,
 *   isPendingFor: (row: Record<string, any>, threadId: string) => boolean
 * }} options
 * @returns {Promise<{threadId: string, messageId: string, outcome: string, error?: string}[]>}
 */
export async function pushQueuedCodexMail({ appServer, mailbox, preflight, now = Date.now(), minAgeMs = 5_000, maxAgeMs = 3_600_000, recipientOf, isPendingFor }) {
  /** @type {Map<string, Record<string, any>[]>} */
  const byThread = new Map();
  for (const row of mailbox.inspect({ limit: Number.MAX_SAFE_INTEGER })) {
    // Older mail is left to inbox pull: a backlog written before Codex had
    // an inbox (0.5.x replies to Codex senders) must not arrive as a burst
    // of turns.
    const age = now - Number(row.sent_at);
    if (row.resolution || !(age >= minAgeMs && age <= maxAgeMs)) continue;
    const threadId = recipientOf(row);
    if (!threadId || !isPendingFor(row, threadId)) continue;
    if (!byThread.has(threadId)) byThread.set(threadId, []);
    byThread.get(threadId)?.push(row);
  }
  /** @type {{threadId: string, messageId: string, outcome: string, error?: string}[]} */
  const results = [];
  for (const [threadId, rows] of byThread) {
    // One turn per pass and thread; the next message waits for it to end.
    const [row] = rows.sort((a, b) => a.sent_at - b.sent_at);
    const ready = /** @type {{ok: boolean, outcome?: string, error?: string}} */ (await preflight.check(threadId));
    if (!ready.ok) {
      results.push({ threadId, messageId: row.id, outcome: ready.outcome ?? "failed", ...(ready.error ? { error: ready.error } : {}) });
      continue;
    }
    const push = await pushCodexMessage({ appServer, mailbox, messageId: row.id, threadId, text: codexTurnText(row), plan: "start" });
    if (push.delivery === "delivered") preflight.markSent(threadId, push.response?.turn?.id ?? null);
    results.push({ threadId, messageId: row.id, outcome: push.delivery === "delivered" ? "sent" : push.error ? "failed" : "claimed_elsewhere", ...(push.error ? { error: push.error.message } : {}) });
  }
  return results;
}

/**
 * State the stale-claim sweep keeps between passes (one per server).
 * @typedef {{offset: number, kept: Map<string, number>, abandoned: Set<string>}} PushClaimSweepState
 */

/** @returns {PushClaimSweepState} */
export function makePushClaimSweepState() {
  return { offset: 0, kept: new Map(), abandoned: new Set() };
}

/**
 * Push claims left by a crash or an unanswered request (F10): a claim older
 * than `staleMs` on a message that is still undelivered is checked against
 * the thread (clientId on a userMessage item). Found: the message is marked
 * delivered. Not found: the claim is removed so the message can be pushed
 * again. Unreadable: the claim stays for the next pass.
 *
 * Bounded so it can neither starve nor keep an idle endpoint alive (N1):
 *   - only claims that still need settling are candidates: the message
 *     exists, is undelivered and unresolved, is for a Codex thread, and is
 *     inside the push window (`maxAgeMs`, the same hour as
 *     pushQueuedCodexMail); older ones are left to inbox pull;
 *   - a claim that stayed unreadable for `maxKeptPasses` passes is abandoned
 *     (logged once, never read again by this server; the claim stays, so the
 *     message is never pushed again and the thread reads it from its inbox);
 *   - `max` applies after that filtering, and the start rotates across
 *     passes (`state.offset`), so one batch cannot starve the rest;
 *   - with no candidates it makes no request at all.
 * @param {{
 *   appServer: {request: (method: string, params?: any) => Promise<any>},
 *   mailbox: ReturnType<import("../claude/mailbox.js").openMailbox>,
 *   staleMs?: number,
 *   max?: number,
 *   maxAgeMs?: number,
 *   maxKeptPasses?: number,
 *   wallNow?: number,
 *   state?: PushClaimSweepState,
 *   onAbandon?: (info: {messageId: string, reason: "unreadable" | "outside_push_window"}) => void,
 *   recipientOf: (row: Record<string, any>) => string | null
 * }} options
 * @returns {Promise<{messageId: string, outcome: "delivered" | "released" | "kept" | "abandoned"}[]>}
 */
export async function sweepStalePushClaims({ appServer, mailbox, staleMs = 180_000, max = 20, maxAgeMs = 3_600_000, maxKeptPasses = 5, wallNow = Date.now(), state = makePushClaimSweepState(), onAbandon = () => {}, recipientOf }) {
  /** @type {{messageId: string, outcome: "delivered" | "released" | "kept" | "abandoned"}[]} */
  const results = [];
  const names = mailbox.listClaims().filter((name) => /^push-[0-9A-HJKMNP-TV-Z]{26}$/.test(name) && !state.abandoned.has(name)).sort();
  if (!names.length) return results;
  /** @type {{name: string, messageId: string, threadId: string}[]} */
  const candidates = [];
  let rows = null;
  for (const name of names) {
    const at = mailbox.claimTakenAt(name);
    if (at === null || wallNow - at < staleMs) continue;
    // One mailbox read for the whole pass, and only when a claim is stale.
    rows ??= new Map(mailbox.inspect({ limit: Number.MAX_SAFE_INTEGER }).map((row) => [row.id, row]));
    const messageId = name.slice("push-".length);
    const row = rows.get(messageId);
    if (!row || row.delivered_at || row.resolution) continue; // the claim sweep collects these
    const threadId = recipientOf(row);
    if (!threadId) continue;
    if (wallNow - Number(row.sent_at) > maxAgeMs) {
      state.abandoned.add(name);
      onAbandon({ messageId, reason: "outside_push_window" });
      results.push({ messageId, outcome: "abandoned" });
      continue;
    }
    candidates.push({ name, messageId, threadId });
  }
  if (!candidates.length) return results;
  const start = state.offset % candidates.length;
  const batch = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, max);
  state.offset = start + batch.length;
  for (const { name, messageId, threadId } of batch) {
    const seen = await findClientIdDelivery(appServer, threadId, messageId);
    if (seen.found) {
      state.kept.delete(name);
      mailbox.markDelivered({ messageId, to: `codex:${threadId}`, via: CODEX_PUSH_VIA });
      results.push({ messageId, outcome: "delivered" });
    } else if (seen.found === false) {
      state.kept.delete(name);
      mailbox.removeClaim(name);
      results.push({ messageId, outcome: "released" });
    } else {
      const passes = (state.kept.get(name) ?? 0) + 1;
      if (passes >= maxKeptPasses) {
        state.kept.delete(name);
        state.abandoned.add(name);
        onAbandon({ messageId, reason: "unreadable" });
        results.push({ messageId, outcome: "abandoned" });
      } else {
        state.kept.set(name, passes);
        results.push({ messageId, outcome: "kept" });
      }
    }
  }
  return results;
}

/**
 * Pushes one queued message to a Codex thread only if the thread is idle
 * (or, outside mailbox-only mode, not loaded). Used for replies to a Codex
 * sender (R1.10): a busy sender may be blocked in a wait that returns this
 * reply itself, so it is never steered; pushQueuedCodexMail delivers it once
 * the thread is idle, if nothing consumed it first.
 * @param {{
 *   appServer: {request: (method: string, params?: any) => Promise<any>},
 *   mailbox: ReturnType<import("../claude/mailbox.js").openMailbox>,
 *   messageId: string,
 *   threadId: string,
 *   policy?: DesktopPushPolicy,
 *   tracker?: ThreadStatusTracker | null,
 *   rolloutCheck?: RolloutCheck | null,
 *   text?: string | null,
 *   turnTrigger?: string
 * }} options
 *   text: the turn text (default: the stored message's envelope)
 * @returns {Promise<{delivery: "delivered" | "queued", deliveredVia: "codex-turn" | null, turnId: string | null, warnings: Array<Record<string, any>>}>}
 */
export async function pushWhenIdle({ appServer, mailbox, messageId, threadId, policy = desktopPushPolicy(), tracker = null, rolloutCheck = null, text = null, turnTrigger = CODEX_PUSH_TURN_TRIGGER }) {
  // The stored row decides, even when the caller supplies the turn text: a
  // message already delivered or resolved is never pushed again.
  const row = mailbox.getMessage({ messageId });
  if (!row || row.resolution) return { delivery: "queued", deliveredVia: null, turnId: null, warnings: [] };
  if (row.delivered_at) return { delivery: "delivered", deliveredVia: row.delivered_via ?? null, turnId: null, warnings: [] };
  /** @type {any} */
  let thread;
  try {
    thread = (await appServer.request("thread/read", { threadId, includeTurns: false }))?.thread ?? null;
  } catch (error) {
    return {
      delivery: "queued",
      deliveredVia: null,
      turnId: null,
      warnings: [{ code: "codex_push_failed", message: `The message is queued in the mailbox; reading codex:${threadId} failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600), details: { messageId, method: "thread/read" } }]
    };
  }
  const status = thread?.status ?? null;
  if (policy.isHeld(status)) return { delivery: "queued", deliveredVia: null, turnId: null, warnings: [heldWarning(threadId)] };
  const type = statusType(status);
  if (type !== "idle" && type !== "notLoaded") return { delivery: "queued", deliveredVia: null, turnId: null, warnings: [] };
  const push = await pushCodexMessage({
    appServer,
    mailbox,
    messageId,
    threadId,
    text: text ?? codexTurnText(row),
    plan: "start",
    resume: type === "notLoaded" ? { threadId, excludeTurns: true, persistExtendedHistory: true } : null,
    turnTrigger,
    tracker,
    rolloutPath: thread?.path ?? null,
    rolloutCheck
  });
  return { delivery: push.delivery, deliveredVia: push.deliveredVia, turnId: push.response?.turn?.id ?? push.response?.turnId ?? null, warnings: push.warnings };
}
