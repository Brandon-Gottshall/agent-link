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
 * Escapes an attribute value: escapeXml plus both quote characters (`&quot;`,
 * and `&#39;` rather than `&apos;`, which HTML 4 lacks; design doc 2.3).
 * @param {unknown} value
 * @returns {string}
 */
export function escapeAttr(value) {
  return escapeXml(value).replace(/["']/g, (c) => (c === '"' ? "&quot;" : "&#39;"));
}

// Code point ranges built as regex source text ("\\u{...}"), so this file
// holds no literal invisible characters.
const hex = (n) => n.toString(16).toUpperCase();
const cls = (ranges) => ranges.map(([a, b = a]) => (a === b ? `\\u{${hex(a)}}` : `\\u{${hex(a)}}-\\u{${hex(b)}}`)).join("");

// C0 controls except \t (09) and \n (0A), DEL, and the C1 controls. \r is
// gone by then. Shown as `\u{XX}` text.
const CONTROL_RANGES = [[0x01, 0x08], [0x0b, 0x1f], [0x7f, 0x9f]];
// Bidi, invisible and format characters (section 2.3 step 4, extended):
// soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and
// directional marks, line/paragraph separators, embeddings and overrides,
// invisible operators, isolates, variation selectors, BOM, tag characters,
// and the variation selectors supplement. Shown as `&#xHHHH;`.
const FORMAT_RANGES = [
  [0xad], [0x61c], [0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064],
  [0x2066, 0x2069], [0xfe00, 0xfe0f], [0xfeff], [0xe0000, 0xe007f], [0xe0100, 0xe01ef]
];
const CONTROL_CHAR = new RegExp(`[${cls(CONTROL_RANGES)}]`, "u");
const INVISIBLE_RUN = new RegExp(`[${cls(CONTROL_RANGES)}${cls(FORMAT_RANGES)}]+`, "gu");
// A run longer than this shows its first characters and a count, so a body
// of nothing but invisible characters cannot grow ninefold when escaped.
export const MAX_ESCAPED_INVISIBLE_RUN = 16;

function escapeInvisible(c) {
  const code = /** @type {number} */ (c.codePointAt(0));
  return CONTROL_CHAR.test(c)
    ? `\\u{${hex(code).padStart(2, "0")}}`
    : `&#x${hex(code).padStart(4, "0")};`;
}

/**
 * Section 2.3 steps 2-4: normalize CRLF and lone CR to LF, drop NUL, show
 * other C0/C1 controls and DEL as `\u{XX}` text, and show bidi/invisible
 * format characters as `&#xHHHH;`. A run of more than 16 such characters
 * shows the first 16 and `[+N more invisible characters]`. The result
 * contains no `&`, `<` or `>` that the input did not, so
 * `sanitizeControlChars(escapeXml(text))` is the full steps 2-5 pipeline
 * without double-escaping the inserted references.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeControlChars(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(INVISIBLE_RUN, (run) => {
      const chars = Array.from(run);
      const shown = chars.slice(0, MAX_ESCAPED_INVISIBLE_RUN).map(escapeInvisible).join("");
      const more = chars.length - MAX_ESCAPED_INVISIBLE_RUN;
      return more > 0 ? `${shown}[+${more} more invisible characters]` : shown;
    });
}

/**
 * Element text for a model-visible block: section 2.3 steps 2-5.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeXmlText(value) {
  return sanitizeControlChars(escapeXml(value));
}
