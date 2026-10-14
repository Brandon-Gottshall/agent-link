// tests/codex/e2e-health-oracle.test.js
//
// Scenario 8 of the cross-harness live E2E checks agent_link_health. The
// product warns (override_costs_version_mismatch) when the detected Codex is
// not the version the override costs were measured on, so the E2E expects that
// warning, and only that, for any other version. These tests pin the oracle
// without a live Codex.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import test from "node:test";
import { overrideCostsHealth } from "../../src/codex/override-costs.js";
import {
  MEASURED_CODEX_VERSION,
  VERSION_MISMATCH_WARNING,
  checkHealthWarnings,
  detectedCodexVersion,
  expectedWarningCodes
} from "../../scripts/e2e-health-oracle.js";

test("the measured version is the product's own constant", () => {
  assert.equal(MEASURED_CODEX_VERSION, "0.159.2");
  assert.equal(VERSION_MISMATCH_WARNING, overrideCostsHealth("codex-cli 0.160.0").warning.code);
});

test("detected version: the installedCodexVersion field, whole and well-formed", () => {
  assert.equal(detectedCodexVersion({ mode: "mailbox-only", installedCodexVersion: "0.162.1" }), "0.162.1");
  assert.equal(detectedCodexVersion({ installedCodexVersion: null }), null);
  assert.equal(detectedCodexVersion({ installedCodexVersion: "codex-cli 0.159.2" }), null);
  assert.equal(detectedCodexVersion({ installedCodexVersion: "0.159" }), null);
  // The old regex passed on 0.159.2 anywhere in the text; the verified version alone no longer counts.
  assert.equal(detectedCodexVersion({ verifiedCodexVersion: "0.159.2", installedCodexVersion: null }), null);
  assert.equal(detectedCodexVersion(undefined), null);
  assert.equal(detectedCodexVersion("0.159.2"), null);
});

test("expected warnings: none on the measured version, exactly the mismatch warning on another", () => {
  assert.deepEqual(expectedWarningCodes("0.159.2"), []);
  assert.deepEqual(expectedWarningCodes("0.162.1"), [VERSION_MISMATCH_WARNING]);
  assert.deepEqual(expectedWarningCodes(null), []);
  assert.deepEqual(expectedWarningCodes("0.162.1", "0.162.1"), []);
});

test("health warnings: the mismatch warning passes only alone and only for a differing version", () => {
  const mismatch = overrideCostsHealth("codex-cli 0.162.1").warning;
  assert.equal(checkHealthWarnings([mismatch], "0.162.1").ok, true);
  assert.equal(checkHealthWarnings([], "0.159.2").ok, true);
  assert.equal(checkHealthWarnings(undefined, "0.159.2").ok, true);
  // A differing version without the warning, or the warning on the measured version, fails.
  assert.equal(checkHealthWarnings([], "0.162.1").ok, false);
  assert.equal(checkHealthWarnings([mismatch], "0.159.2").ok, false);
  // Any other warning fails, alone or beside the expected one, and the expected one is not repeated.
  assert.equal(checkHealthWarnings([{ code: "codex_version_differs" }], "0.162.1").ok, false);
  assert.equal(checkHealthWarnings([mismatch, { code: "something_else" }], "0.162.1").ok, false);
  assert.equal(checkHealthWarnings([{ code: "something_else" }], "0.159.2").ok, false);
  assert.equal(checkHealthWarnings([mismatch, mismatch], "0.162.1").ok, false);
  // Bare string codes are read as codes.
  assert.equal(checkHealthWarnings([VERSION_MISMATCH_WARNING], "0.162.1").ok, true);
});

test("the product's own health report agrees with the oracle", () => {
  for (const installed of ["codex-cli 0.159.2", "codex-cli 0.162.1", null]) {
    const report = overrideCostsHealth(installed);
    const warnings = report.warning ? [report.warning] : [];
    assert.equal(checkHealthWarnings(warnings, report.installedVersion).ok, true, String(installed));
  }
});
