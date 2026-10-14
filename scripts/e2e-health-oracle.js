// What scenario 8 of the cross-harness live E2E expects from agent_link_health,
// given the Codex version the health result reports as detected. The product
// warns on purpose: codex.overrideCosts emits `override_costs_version_mismatch`
// when the detected version is not the one the override costs were measured on
// (src/codex/override-costs.js). So a version other than the measured one is
// expected to carry exactly that warning, and any other warning still fails.
// No live-guard import: tests load this module.

import { OVERRIDE_COSTS } from "../src/codex/override-costs.js";

export const VERSION_MISMATCH_WARNING = "override_costs_version_mismatch";

/** The Codex version the override costs were measured on, from the product's own constant. */
export const MEASURED_CODEX_VERSION = OVERRIDE_COSTS.codexVersion;

/**
 * The detected Codex version in a health result's `desktopPush` report: its
 * `installedCodexVersion` field, compared whole. Null unless it is a plain
 * x.y.z string.
 * @param {unknown} desktopPush
 * @returns {string | null}
 */
export function detectedCodexVersion(desktopPush) {
  const version = desktopPush && typeof desktopPush === "object" ? /** @type {Record<string, unknown>} */ (desktopPush).installedCodexVersion : undefined;
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/**
 * The warning codes a health result may carry for this detected version: none
 * when it is the measured version (or none was detected, which the product
 * does not warn about), else exactly the version-mismatch warning.
 * @param {string | null} detected
 * @param {string | null} [measured]
 * @returns {string[]}
 */
export function expectedWarningCodes(detected, measured = MEASURED_CODEX_VERSION) {
  return detected !== null && measured !== null && detected !== measured ? [VERSION_MISMATCH_WARNING] : [];
}

/**
 * Whether a health result's warnings are exactly the expected ones.
 * @param {unknown[]} warnings  `warnings[]` entries: objects with a `code`, or bare codes
 * @param {string | null} detected
 * @param {string | null} [measured]
 * @returns {{ok: boolean, actual: unknown[], expected: string[]}}
 */
export function checkHealthWarnings(warnings, detected, measured = MEASURED_CODEX_VERSION) {
  const actual = (warnings ?? []).map((w) => /** @type {any} */ (w)?.code ?? w);
  const expected = expectedWarningCodes(detected, measured);
  return { ok: actual.length === expected.length && actual.every((code, i) => code === expected[i]), actual, expected };
}
