// src/shared/errors.js
//
// The one error type tool handlers throw (design doc section 3.2/3.3). The
// registry wrapper (src/server/registry.js) turns it into the
// `{ok:false, error:{code, message, details, hint}}` envelope.

/**
 * @typedef {"invalid_arguments" | "unknown_tool" | "not_found" | "ambiguous"
 *   | "archived" | "wrong_recipient" | "no_current_session" | "body_too_large"
 *   | "permission_denied" | "active_turn_conflict" | "codex_unavailable"
 *   | "claude_unavailable" | "upstream_error" | "unsupported" | "state_io_error"
 *   | "internal_error"} AgentLinkErrorCode
 */

/**
 * @typedef {object} AgentLinkErrorOptions
 * @property {Record<string, unknown> | null} [details]
 * @property {string | null} [hint]
 * @property {unknown} [cause]
 */

/**
 * @typedef {object} ErrorPayload
 * @property {AgentLinkErrorCode} code
 * @property {string} message
 * @property {Record<string, unknown>} [details]
 * @property {string} [hint]
 */

/** @type {readonly AgentLinkErrorCode[]} */
export const ERROR_CODES = Object.freeze([
  "invalid_arguments",
  "unknown_tool",
  "not_found",
  "ambiguous",
  "archived",
  "wrong_recipient",
  "no_current_session",
  "body_too_large",
  "permission_denied",
  "active_turn_conflict",
  "codex_unavailable",
  "claude_unavailable",
  "upstream_error",
  "unsupported",
  "state_io_error",
  "internal_error"
]);

const ERROR_CODE_SET = new Set(ERROR_CODES);

/**
 * @param {unknown} code
 * @returns {code is AgentLinkErrorCode}
 */
export function isErrorCode(code) {
  return typeof code === "string" && ERROR_CODE_SET.has(/** @type {AgentLinkErrorCode} */ (code));
}

export class AgentLinkError extends Error {
  /**
   * @param {AgentLinkErrorCode} code
   * @param {string} message
   * @param {AgentLinkErrorOptions} [options]
   */
  constructor(code, message, { details = null, hint = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    if (!isErrorCode(code)) {
      throw new TypeError(`Unknown Agent Link error code: ${String(code)}`);
    }
    this.name = "AgentLinkError";
    /**
     * The section 3.2 code. Subclasses with a legacy `code` field of their own
     * (AppServerError) keep the canonical value here.
     * @type {AgentLinkErrorCode}
     */
    this.errorCode = code;
    /** @type {unknown} */
    this.code = code;
    /** @type {Record<string, unknown> | null} */
    this.details = details;
    /** @type {string | null} */
    this.hint = hint;
  }
}

/**
 * The section 3.2 code for any thrown value. Unknown exceptions are bugs.
 * @param {unknown} error
 * @returns {AgentLinkErrorCode}
 */
export function errorCodeOf(error) {
  if (error instanceof AgentLinkError && isErrorCode(error.errorCode)) {
    return error.errorCode;
  }
  return "internal_error";
}

/**
 * Builds the `error` object of the failure envelope (R3.3). Unknown exceptions
 * report only their class in `details.cause`: never a stack or raw message.
 * @param {unknown} error
 * @returns {ErrorPayload}
 */
export function toErrorPayload(error) {
  if (error instanceof AgentLinkError && isErrorCode(error.errorCode)) {
    /** @type {ErrorPayload} */
    const payload = { code: error.errorCode, message: error.message };
    // A subclass can show narrower details than it keeps (AppServerError).
    const details = /** @type {{envelopeDetails?: Record<string, unknown>}} */ (error).envelopeDetails ?? error.details;
    if (details && Object.keys(details).length > 0) payload.details = details;
    if (error.hint) payload.hint = error.hint;
    return payload;
  }
  const cause = error instanceof Error ? error.constructor?.name || "Error" : typeof error;
  return {
    code: "internal_error",
    message: "Agent Link hit an internal error.",
    details: { cause }
  };
}
