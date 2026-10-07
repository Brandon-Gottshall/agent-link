// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import test from "node:test";
import { ENV_ALIASES, HOST_PROVIDED_ENV, env, envFlag, envReport, envValue } from "../../src/shared/env.js";

test("every canonical name starts with AGENT_LINK_ and no alias does", () => {
  for (const [canonical, aliases] of Object.entries(ENV_ALIASES)) {
    assert.match(canonical, /^AGENT_LINK_/);
    for (const alias of aliases) assert.doesNotMatch(alias, /^AGENT_LINK_/);
  }
  const allAliases = Object.values(ENV_ALIASES).flat();
  assert.equal(new Set(allAliases).size, allAliases.length, "an alias maps to one canonical name");
  for (const name of HOST_PROVIDED_ENV) assert.equal(name in ENV_ALIASES, false);
});

test("section 4.2 mappings", () => {
  assert.deepEqual(ENV_ALIASES.AGENT_LINK_CODEX_URL, ["CODEX_AGENT_LINK_URL", "CODEX_APP_SERVER_URL"]);
  assert.deepEqual(ENV_ALIASES.AGENT_LINK_CODEX_SOCK, ["CODEX_AGENT_LINK_SOCK", "CODEX_APP_SERVER_SOCK"]);
  assert.deepEqual(ENV_ALIASES.AGENT_LINK_CODEX_BIN, ["CODEX_AGENT_LINK_CODEX_BIN", "CODEX_BIN"]);
  assert.deepEqual(ENV_ALIASES.AGENT_LINK_MANAGED_DIR, ["CODEX_AGENT_LINK_STATE_DIR"]);
  assert.deepEqual(ENV_ALIASES.AGENT_LINK_STATE_DIR, []);
  assert.deepEqual(ENV_ALIASES.AGENT_LINK_RECEIPT_LOG, ["CODEX_AGENT_LINK_RECEIPT_LOG", "CLAUDE_AGENT_LINK_RECEIPT_LOG"]);
});

// T-4.1 for every row: canonical only, alias only, both differing.
test("each table row: canonical only, each alias only, canonical and alias differing", () => {
  for (const [canonical, aliases] of Object.entries(ENV_ALIASES)) {
    assert.deepEqual(env(canonical, {}), { value: undefined, source: null });
    assert.deepEqual(env(canonical, { [canonical]: "c" }), { value: "c", source: canonical });
    assert.deepEqual(envReport({ [canonical]: "c" }), { deprecated: [], conflicts: [] });
    for (const alias of aliases) {
      assert.deepEqual(env(canonical, { [alias]: "a" }), { value: "a", source: alias }, `${alias} alone`);
      assert.deepEqual(envReport({ [alias]: "a" }), { deprecated: [{ name: alias, canonical }], conflicts: [] });
      const both = { [canonical]: "c", [alias]: "a" };
      assert.deepEqual(env(canonical, both), { value: "c", source: canonical }, "canonical wins");
      assert.deepEqual(envReport(both), { deprecated: [], conflicts: [{ canonical, winner: canonical, ignored: alias }] });
      assert.deepEqual(envReport({ [canonical]: "same", [alias]: "same" }), { deprecated: [], conflicts: [] });
    }
  }
});

test("aliases are tried in table order", () => {
  const source = { CODEX_APP_SERVER_URL: "ws://second", CODEX_AGENT_LINK_URL: "ws://first" };
  assert.deepEqual(env("AGENT_LINK_CODEX_URL", source), { value: "ws://first", source: "CODEX_AGENT_LINK_URL" });
  assert.deepEqual(envReport(source), {
    deprecated: [{ name: "CODEX_AGENT_LINK_URL", canonical: "AGENT_LINK_CODEX_URL" }],
    conflicts: [{ canonical: "AGENT_LINK_CODEX_URL", winner: "CODEX_AGENT_LINK_URL", ignored: "CODEX_APP_SERVER_URL" }]
  });
});

test("empty strings count as unset", () => {
  assert.deepEqual(env("AGENT_LINK_CODEX_URL", { AGENT_LINK_CODEX_URL: "", CODEX_AGENT_LINK_URL: "ws://x" }), {
    value: "ws://x",
    source: "CODEX_AGENT_LINK_URL"
  });
  assert.deepEqual(env("CODEX_HOME", { CODEX_HOME: "" }), { value: undefined, source: null });
});

test("host-provided variables are read as-is", () => {
  assert.deepEqual(env("CODEX_HOME", { CODEX_HOME: "/x" }), { value: "/x", source: "CODEX_HOME" });
  assert.deepEqual(env("CLAUDE_CONFIG_DIR", {}), { value: undefined, source: null });
});

test("unknown names throw", () => {
  assert.throws(() => env("AGENT_LINK_TYPO", {}), /Unknown Agent Link environment variable/);
  assert.throws(() => env("CODEX_AGENT_LINK_URL", {}), TypeError, "legacy names are not looked up directly");
});

test("envValue and envFlag", () => {
  assert.equal(envValue("AGENT_LINK_HOST", "fallback", {}), "fallback");
  assert.equal(envValue("AGENT_LINK_HOST", "fallback", { AGENT_LINK_HOST: "codex" }), "codex");
  for (const yes of ["1", "true", "YES", " on "]) assert.equal(envFlag("AGENT_LINK_DEBUG", false, { AGENT_LINK_DEBUG: yes }), true);
  for (const no of ["0", "false", "No", "off"]) assert.equal(envFlag("AGENT_LINK_CODEX_AUTOSTART", true, { CODEX_AGENT_LINK_AUTOSTART: no }), false);
  assert.equal(envFlag("AGENT_LINK_DEBUG", false, { AGENT_LINK_DEBUG: "maybe" }), false);
  assert.equal(envFlag("AGENT_LINK_DEBUG", true, {}), true);
});

test("envReport never includes values", () => {
  const report = envReport({ CODEX_AGENT_LINK_URL: "ws://secret-token@host", AGENT_LINK_CODEX_SOCK: "/a", CODEX_AGENT_LINK_SOCK: "/b" });
  assert.equal(JSON.stringify(report).includes("secret-token"), false);
  assert.equal(JSON.stringify(report).includes("/b"), false);
});
