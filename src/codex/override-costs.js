// src/codex/override-costs.js
//
// The B7 spike's override cost measurements (design doc R9.12; raw numbers
// in docs/design/b7-spike-results.md section C), reported as
// agent_link_health codex.overrideCosts. Each value is the cached share of
// input (cachedInputTokens / inputTokens) on the first turn after the change,
// per rep; the turn before had a share of about 0.99 (0.77 for the forks'
// originals).

import { COMPACT_FORK_AUTO_FRACTION } from "./fork.js";

export const OVERRIDE_COSTS = Object.freeze({
  measured: /** @type {boolean} */ (true),
  codexVersion: /** @type {string | null} */ ("0.159.2"),
  measuredAt: "2026-10-07",
  // Not cache-neutral: the R9.3 fallback applies (expectedCost on effort changes).
  effortChange: { cachedShare: [0.434, 0.0], cacheNeutral: false },
  // Only the static prefix shared across threads hits; about +4.4k input.
  modelSwitch: { cachedShare: [0.256, 0.256], cacheNeutral: false },
  // Cache-neutral; about +158 input tokens of environment context.
  cwdChange: { cachedShare: [0.988, 0.988], cacheNeutral: true },
  // A fork does not reuse the original's cache, on any model.
  forkSameModel: { cachedShare: [0.0, 0.33], cacheNeutral: false },
  forkOtherModel: { cachedShare: [0.202, 0.202], cacheNeutral: false },
  compactForkAutoFraction: COMPACT_FORK_AUTO_FRACTION
});

/**
 * The health report: the recorded costs, the installed Codex version, and a
 * warning when the costs were measured on another version.
 * @param {string | null | undefined} installedVersion  `codex --version` output, or null
 * @param {Record<string, any>} [costs]
 */
export function overrideCostsHealth(installedVersion, costs = /** @type {Record<string, any>} */ (OVERRIDE_COSTS)) {
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
