// src/codex/override-costs.js
//
// The B7 spike's override cost measurements (design doc R9.12), reported as
// agent_link_health codex.overrideCosts. Placeholder until the spike records
// them: `measured` is false and every value is null.
//
// TODO(spike): fill these from the R9.12 results and set codexVersion to the
// Codex version they were measured on.

import { COMPACT_FORK_AUTO_FRACTION } from "./fork.js";

export const OVERRIDE_COSTS = Object.freeze({
  measured: /** @type {boolean} */ (false),
  codexVersion: /** @type {string | null} */ (null),
  // Cached share of input on the next turn (cachedInputTokens / inputTokens),
  // relative to the turn before, or absolute for a fork's first turn.
  effortChange: /** @type {number | null} */ (null),
  modelSwitch: /** @type {number | null} */ (null),
  cwdChange: /** @type {number | null} */ (null),
  forkSameModel: /** @type {number | null} */ (null),
  forkOtherModel: /** @type {number | null} */ (null),
  compactForkAutoFraction: COMPACT_FORK_AUTO_FRACTION
});

/**
 * The health report: the recorded costs, the installed Codex version, and a
 * warning when the costs were measured on another version.
 * @param {string | null | undefined} installedVersion  `codex --version` output, or null
 * @param {typeof OVERRIDE_COSTS} [costs]
 */
export function overrideCostsHealth(installedVersion, costs = OVERRIDE_COSTS) {
  const installed = versionNumber(installedVersion);
  const measuredOn = versionNumber(costs.codexVersion);
  const differs = costs.measured === true && measuredOn !== null && installed !== null && measuredOn !== installed;
  return {
    ...costs,
    installedVersion: installed,
    warning: differs
      ? {
          code: "override_costs_version_mismatch",
          severity: "warning",
          message: `Override costs were measured on Codex ${measuredOn}, but Codex ${installed} is installed; the expected costs may be out of date.`
        }
      : null
  };
}

/**
 * "codex-cli 0.159.2" -> "0.159.2".
 * @param {unknown} value
 */
function versionNumber(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}
