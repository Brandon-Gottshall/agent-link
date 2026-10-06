// src/shared/args.js
//
// Argument helpers shared by every tool handler. The legacy helpers
// (requiredString, optionalString, cleanString, clampInt, normalizeStringList)
// keep the exact behavior of the private copies they replace. intInRange and
// resolveAlias implement the stricter section 3.3/3.5 rules (reject, never
// clamp) for the registry PR to adopt.

import { AgentLinkError } from "./errors.js";

/**
 * @typedef {object} DeprecationWarning
 * @property {"deprecated_argument"} code
 * @property {string} message
 * @property {string} replacement
 */

/**
 * @typedef {object} ArgumentProblem
 * @property {string} path
 * @property {string} rule
 * @property {string} expected
 */

/**
 * @param {string} message
 * @param {ArgumentProblem[]} errors
 */
function invalidArguments(message, errors) {
  return new AgentLinkError("invalid_arguments", message, { details: { errors } });
}

/**
 * A non-blank string, returned untrimmed. Throws `${name} is required`.
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
export function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentLinkError("invalid_arguments", `${name} is required`);
  }
  return value;
}

/**
 * The value when it is a string (untrimmed), otherwise "".
 * @param {unknown} value
 * @returns {string}
 */
export function optionalString(value) {
  return typeof value === "string" ? value : "";
}

/**
 * The trimmed value when it is a string, otherwise "".
 * @param {unknown} value
 * @returns {string}
 */
export function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Legacy lenient integer: non-numbers become `min`, others are floored and
 * clamped into [min, max]. New code uses intInRange, which rejects instead.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Trimmed, non-empty strings from a string or an array. Non-strings drop out.
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeStringList(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean);
  }
  const text = cleanString(value);
  return text ? [text] : [];
}

/**
 * @typedef {object} IntRange
 * @property {string} name     argument name, used in the error path
 * @property {number} min
 * @property {number} max
 * @property {number} [default] returned when the value is undefined or null
 */

/**
 * Strict integer argument (R3.12): absent values take the default; anything
 * else must be an integer within [min, max] or the call fails with
 * invalid_arguments. Nothing is clamped or coerced.
 * @param {unknown} value
 * @param {IntRange} range
 * @returns {number}
 */
export function intInRange(value, { name, min, max, default: fallback }) {
  if (value === undefined || value === null) {
    if (fallback === undefined) {
      throw invalidArguments(`${name} is required`, [{ path: name, rule: "required", expected: `integer ${min}..${max}` }]);
    }
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidArguments(`${name} must be an integer`, [{ path: name, rule: "type", expected: "integer" }]);
  }
  if (value < min || value > max) {
    throw invalidArguments(`${name} must be between ${min} and ${max}`, [{ path: name, rule: "range", expected: `integer ${min}..${max}` }]);
  }
  return value;
}

/**
 * @typedef {object} AliasResult
 * @property {unknown} value          the effective value (undefined when absent)
 * @property {string | null} source   the argument name that supplied it
 * @property {DeprecationWarning[]} warnings
 */

/**
 * Resolves a canonical argument and its deprecated aliases (R3.6). Every alias
 * the caller used adds a deprecated_argument warning. An alias whose value
 * differs from the canonical one (or from another alias) is invalid_arguments.
 * @param {Record<string, unknown> | null | undefined} args
 * @param {string} canonical
 * @param {string[]} aliases
 * @returns {AliasResult}
 */
export function resolveAlias(args, canonical, aliases) {
  const input = args ?? {};
  /** @type {DeprecationWarning[]} */
  const warnings = [];
  const has = (/** @type {string} */ key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;

  let value = has(canonical) ? input[canonical] : undefined;
  let source = has(canonical) ? canonical : null;
  /** @type {ArgumentProblem[]} */
  const conflicts = [];
  for (const alias of aliases) {
    if (!has(alias)) continue;
    warnings.push({
      code: "deprecated_argument",
      message: `${alias} is deprecated; use ${canonical}.`,
      replacement: canonical
    });
    if (source === null) {
      value = input[alias];
      source = alias;
    } else if (!sameValue(input[alias], value)) {
      conflicts.push({ path: alias, rule: "alias_conflict", expected: `the same value as ${source}` });
    }
  }
  if (conflicts.length > 0) {
    throw invalidArguments(
      `${conflicts.map((c) => c.path).join(", ")} conflicts with ${source}; pass only ${canonical}.`,
      conflicts
    );
  }
  return { value, source, warnings };
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}
