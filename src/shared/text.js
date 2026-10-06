// src/shared/text.js
//
// Text helpers shared across hosts: truncation, timestamp conversion, the one
// XML escaper for model-visible Agent Link blocks, and the control-character
// sanitizer from design doc section 2.3.

/**
 * Cuts text longer than `max` characters to `max - 3` plus "...".
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function truncate(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

/**
 * Unix seconds (Codex app-server timestamps) to ISO 8601 UTC, or null.
 * @param {number | null | undefined} seconds
 * @returns {string | null}
 */
export function toIso(seconds) {
  if (!seconds) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

/**
 * Escapes element text: `&`, `<`, `>`.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeXml(value) {
  return String(value ?? "").replace(/[&<>]/g, (c) => /** @type {Record<string, string>} */ ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

/**
 * Escapes an attribute value: escapeXml plus both quote characters.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeAttr(value) {
  return escapeXml(value).replace(/["']/g, (c) => (c === '"' ? "&quot;" : "&apos;"));
}

// C0 controls except \t (09) and \n (0A), plus DEL. \r is gone by then.
// eslint-disable-next-line no-control-regex
const C0_CONTROLS = /[\u0001-\u0008\u000B-\u001F\u007F]/g;
// Bidi and invisible format controls (section 2.3 step 4).
const FORMAT_CONTROLS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Section 2.3 steps 2-4: normalize CRLF and lone CR to LF, drop NUL, show
 * other C0 controls and DEL as `\u{XX}` text, and show bidi/invisible format
 * controls as `&#xHHHH;`. The result contains no `&`, `<` or `>` that the
 * input did not, so `sanitizeControlChars(escapeXml(text))` is the full
 * steps 2-5 pipeline without double-escaping the inserted references.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeControlChars(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(C0_CONTROLS, (c) => `\\u{${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}}`)
    .replace(FORMAT_CONTROLS, (c) => `&#x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")};`);
}

/**
 * Element text for a model-visible block: section 2.3 steps 2-5.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeXmlText(value) {
  return sanitizeControlChars(escapeXml(value));
}
