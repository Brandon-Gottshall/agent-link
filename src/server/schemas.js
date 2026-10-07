// src/server/schemas.js
//
// Shared JSON Schema fragments for tool definitions (design doc R3.13). Each
// description is written once here; tool modules compose these instead of
// keeping their own copies. Integer limits follow the section 3.5 table:
// values outside [minimum, maximum] are rejected by the registry, not clamped.

import { ERROR_CODES } from "../shared/errors.js";

/** @typedef {import("./validate.js").JsonSchema} JsonSchema */

/** The release that removes the deprecated argument aliases and duplicated output keys. */
export const ALIAS_REMOVAL_VERSION = "0.6.0";

export const EFFORT_VALUES = Object.freeze(["minimal", "low", "medium", "high", "xhigh"]);
export const MESSAGE_MODES = Object.freeze(["auto", "start_turn", "steer_active"]);
export const ARCHIVE_SCOPES = Object.freeze(["active", "archived", "all"]);
export const CLAUDE_SURFACES = Object.freeze(["all", "desktop", "code"]);
export const RECEIPT_ACTIONS = Object.freeze([
  "launch_thread",
  "message_thread",
  "archive_thread",
  "message_claude_session",
  "reply_message",
  "message_status",
  "model_switch",
  "effort_change",
  "cwd_change",
  "fork_thread",
  "reconcile_fork"
]);

/** Receipt kinds for the section 9 receipts (R9.10), for list_agent_link_receipts `kind`. */
export const RECEIPT_KINDS = Object.freeze(["fork", "reconcile", "model-switch", "effort-change", "cwd-change"]);

/**
 * @param {string} description
 * @returns {JsonSchema}
 */
export const str = (description) => ({ type: "string", description });

/**
 * @param {string} description
 * @returns {JsonSchema}
 */
export const bool = (description) => ({ type: "boolean", description });

/**
 * @param {string} description
 * @returns {JsonSchema}
 */
export const stringList = (description) => ({ type: "array", items: { type: "string", description: "One entry." }, description });

/**
 * A string or a list of strings.
 * @param {string} description
 * @returns {JsonSchema}
 */
export const stringOrList = (description) => ({
  oneOf: [
    { type: "string", description: "A single value." },
    { type: "array", items: { type: "string", description: "One value." }, description: "Several values." }
  ],
  description
});

/**
 * @param {readonly string[]} values
 * @param {string} description
 * @returns {JsonSchema}
 */
export const enumOf = (values, description) => ({ type: "string", enum: [...values], description });

/**
 * Integer with the section 3.5 bounds and default.
 * @param {{min: number, max: number, def: number, description: string}} options
 * @returns {JsonSchema}
 */
export function intRange({ min, max, def, description }) {
  return { type: "integer", minimum: min, maximum: max, default: def, description: `${description} Integer ${min}..${max}; defaults to ${def}.` };
}

/**
 * `limit` for one of the section 3.5 rows.
 * @param {"list" | "resolve" | "receipts" | "inbox"} kind
 * @param {string} what  plural noun, e.g. "threads"
 * @returns {JsonSchema}
 */
export function limit(kind, what) {
  return intRange({ ...LIMITS[kind], description: `Maximum ${what} to return.` });
}

export const LIMITS = Object.freeze({
  list: { min: 1, def: 20, max: 200 },
  resolve: { min: 1, def: 10, max: 50 },
  receipts: { min: 1, def: 50, max: 500 },
  inbox: { min: 1, def: 20, max: 100 },
  receiptLimit: { min: 0, def: 10, max: 100 },
  timeoutMs: { min: 0, def: 60000, max: 600000 },
  pollIntervalMs: { min: 250, def: 1000, max: 10000 },
  // recentItems counts items, not turns (0.4.0); the doc's recentTurns rename
  // is not applied because the count is no longer of turns.
  recentItems: { min: 0, def: 20, max: 100 },
  replyRecentItems: { min: 0, def: 10, max: 100 }
});

/** @param {string} [description] */
export const receiptLimit = (description = "Maximum receipts to include.") => intRange({ ...LIMITS.receiptLimit, description });
/** @param {string} [description] */
export const timeoutMs = (description = "Maximum time to wait, in milliseconds.") => intRange({ ...LIMITS.timeoutMs, description });
/** @param {string} [description] */
export const pollIntervalMs = (description = "Polling interval, in milliseconds.") => intRange({ ...LIMITS.pollIntervalMs, description });

export const archiveScope = (/** @type {string} */ defaultScope = "all") =>
  enumOf(ARCHIVE_SCOPES, `Which persisted thread scope to search. Defaults to ${defaultScope}.`);

export const cwdFilter = stringOrList("Optional exact cwd filter or list of exact cwd filters.");
export const useLocalFallback = bool("Use local JSONL transcript scanning if the app-server is unavailable. Defaults to true.");
export const effort = enumOf(EFFORT_VALUES, "Reasoning effort for the target turn.");

/** @type {JsonSchema} */
export const receiptInput = {
  type: "object",
  description: "Optional provenance metadata for the local Agent Link receipt index. Receipts are recorded by default for launch, message, reply, and archive actions; set record=false to opt out.",
  properties: {
    record: bool("When false, skip writing a receipt for this action. Defaults to true."),
    purpose: str("Short human-readable reason, such as WF verification, handoff, coordination, or receipt test."),
    originThreadId: str("Thread ID that caused this action, when known."),
    originTurnId: str("Turn ID that caused this action, when known."),
    originToolCallId: str("Tool call ID that caused this action, when known."),
    cleanupRecommendation: str("Caller guidance for the created, messaged, or archived target, for example archiveable, archived, keep_as_evidence, or review_before_archive."),
    note: str("Brief extra provenance note."),
    tags: stringList("Optional searchable tags.")
  },
  additionalProperties: false
};

const RECENT_ITEMS_REPLY = "When waitForReply is true, include up to this many recent ITEMS (not turns) of the target thread in wait.recentItems, oldest first, each with its turnId.";

/**
 * The options every tool that sends a Codex turn accepts (message_codex_thread
 * and its project-orchestrator and dependency-handoff wrappers).
 * @type {Record<string, JsonSchema>}
 */
export const turnOptions = {
  mode: enumOf(MESSAGE_MODES, "auto resumes idle or not-loaded threads, or steers an active turn when its turn id is known. Defaults to auto."),
  resumeIfNeeded: bool("Allow thread/resume before messaging a not-loaded target. Defaults to true."),
  expectedTurnId: str("Required by the app-server when steering an active turn unless Agent Link can infer the active turn."),
  model: str("Optional model for the target turn. A model different from the thread's own is refused (permission_denied, model_switch_requires_fork_or_opt_in) unless the target's override policy allows you (or the deprecated allowTargetOverride is set); an allowed switch persists and the next turn re-reads the thread uncached. Not applied (with a warning) when the thread reports no model and nothing allows it."),
  effort: enumOf(EFFORT_VALUES, "Optional reasoning effort for the target turn. The thread's launcher may change it; anyone else needs the target's override policy (or the deprecated allowTargetOverride), otherwise permission_denied (effort_not_permitted). A change persists. Not applied (with a warning) when the thread reports none and you may not change it."),
  allowParallelTurn: bool("Allow mode=start_turn even when the target appears active or waiting. Defaults to false."),
  waitForReply: bool("After delivery, wait for the target turn to finish and return the result in `wait`. Defaults to false."),
  timeoutMs: timeoutMs("Maximum wait when waitForReply is true, in milliseconds."),
  pollIntervalMs: pollIntervalMs("Polling interval when waitForReply is true, in milliseconds."),
  recentItems: intRange({ ...LIMITS.replyRecentItems, description: RECENT_ITEMS_REPLY }),
  allowTargetOverride: bool("Deprecated (deprecated_argument warning). Until 0.7.0 it still lets you change an existing thread's cwd, model, and effort (the change persists; a cwd must stay inside the thread's workspace); from 0.7.0 it grants nothing and from 0.8.0 it is rejected. Prefer a new thread for another model, the thread's launcher for effort, or the target's override policy.")
};

/**
 * How the project-orchestrator tools find the orchestrator thread.
 * @type {Record<string, JsonSchema>}
 */
export const orchestratorTarget = {
  projectRoot: str("Source project root containing .codex/project-orchestrator.json."),
  projectId: str("Stable project identifier, used as a fallback search signal."),
  orchestratorThreadId: str("Explicit orchestrator thread ID. Skips binding and search ambiguity but is still checked for readability."),
  threadId: str("Same as orchestratorThreadId."),
  query: str("Fallback search query when no readable source-owned binding is available."),
  cwd: str("Optional cwd filter for the fallback search. Defaults to projectRoot. Never used as the turn's working directory."),
  archiveScope: archiveScope("all"),
  useLocalFallback
};

// ---------------------------------------------------------------------------
// Output schemas (R3.2). Every tool's outputSchema is the section 3.1
// envelope: `ok`, then `error` on failure or the tool's payload keys on
// success, plus `warnings`. The top level is closed (additionalProperties
// false); nested payload values are described, not fully specified, because
// several carry app-server objects whose shape Agent Link does not own.

/** @type {JsonSchema} */
const errorObject = {
  type: "object",
  description: "Present only when ok is false.",
  properties: {
    code: enumOf(ERROR_CODES, "Stable error code (design doc section 3.2)."),
    message: str("Human-readable description of the failure."),
    details: { type: "object", description: "Code-specific details, for example errors[] for invalid_arguments or limitBytes/actualBytes for body_too_large." },
    hint: str("Suggested next step, when there is one.")
  },
  required: ["code", "message"],
  additionalProperties: false
};

/** @type {JsonSchema} */
const warningsArray = {
  type: "array",
  description: "Non-fatal notices, omitted when empty. Deprecated arguments add {code:'deprecated_argument', message, replacement}.",
  items: {
    type: "object",
    description: "One warning: at least code and message.",
    properties: {
      code: str("Warning code."),
      message: str("Human-readable warning.")
    },
    required: ["code", "message"]
  }
};

/**
 * Loosely typed output property.
 * @param {string | string[]} type
 * @param {string} description
 * @returns {JsonSchema}
 */
export const out = (type, description) => ({ type, description });

export const outAny = (/** @type {string} */ description) => ({ description });

/**
 * The section 3.1 envelope around a tool's payload keys.
 * @param {Record<string, JsonSchema>} payload
 * @returns {JsonSchema}
 */
export function envelopeOutput(payload) {
  return {
    type: "object",
    properties: {
      ok: bool("true on success, false on failure; isError is set exactly when this is false."),
      error: errorObject,
      warnings: warningsArray,
      ...payload
    },
    required: ["ok"],
    additionalProperties: false
  };
}

/** Output keys that many tools share. */
export const commonOut = {
  source: out("string", "Where the data came from, e.g. app-server or local-jsonl-fallback."),
  appServer: out(["object", "null"], "Connection summary for the Codex app-server."),
  appServerError: out(["string", "null"], "Why the app-server could not answer, when a fallback was used."),
  stateSemantics: out("object", "How to read loaded, status, and archive state."),
  receipt: out("object", "Result of writing the receipt for this action."),
  peerMessage: out(["object", "null"], "The envelope fields of the message sent: {messageId, from, fromHarness, fromVerified, sentAt, enveloped}.")
};
