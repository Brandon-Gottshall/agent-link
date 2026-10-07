// tests/codex/prompt-hook-health.test.js
//
// agent_link_health codex.promptHook (design R1.14): declared from this
// package's Codex manifest; trust only from the app-server's hooks/list
// (shapes as returned by codex-cli 0.159.2), never from Codex's config.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  findInstalledPromptHook,
  findPluginRoot,
  promptHookDeclaration,
  promptHookReport
} from "../../src/codex/prompt-hook-health.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// One hooks/list entry as codex-cli 0.159.2 returns it (paths scrubbed).
const listed = (overrides = {}) => ({
  data: [{
    cwd: "/tmp/cwd",
    hooks: [
      {
        key: "other@market:hooks/hooks.json:user_prompt_submit:0:0",
        eventName: "userPromptSubmit",
        source: "plugin",
        pluginId: "other@market",
        trustStatus: "trusted",
        enabled: true
      },
      {
        key: "codex-agent-link@agent-link:hooks/codex-hooks.json:user_prompt_submit:0:0",
        eventName: "userPromptSubmit",
        handlerType: "command",
        command: "node \"$PLUGIN_ROOT/src/codex/prompt-hook.js\" 2>/dev/null; exit 0",
        timeoutSec: 5,
        sourcePath: "/plugins/cache/agent-link/codex-agent-link/0.5.0/hooks/codex-hooks.json",
        source: "plugin",
        pluginId: "codex-agent-link@agent-link",
        enabled: true,
        isManaged: false,
        currentHash: "sha256:00",
        trustStatus: "untrusted",
        ...overrides
      }
    ],
    warnings: [],
    errors: []
  }]
});

test("the repo declares the prompt hook for Codex", () => {
  assert.equal(findPluginRoot(path.join(root, "src", "codex")), root);
  assert.equal(findPluginRoot(path.join(root, "dist")), root, "works from the bundle too");
  assert.deepEqual(promptHookDeclaration(root), { declared: true, hooksFile: "hooks/codex-hooks.json", reason: null });
});

test("a manifest without the hooks field is not declared", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-hook-health-"));
  try {
    fs.mkdirSync(path.join(dir, ".codex-plugin"));
    fs.writeFileSync(path.join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "codex-agent-link" }));
    const decl = promptHookDeclaration(dir);
    assert.equal(decl.declared, false);
    assert.match(decl.reason, /hooks is not/);
    assert.equal(promptHookDeclaration(null).declared, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trust comes from hooks/list", async () => {
  assert.equal(findInstalledPromptHook(listed()).pluginId, "codex-agent-link@agent-link");
  const untrusted = await promptHookReport({ root, listHooks: async () => listed() });
  assert.equal(untrusted.trust, "untrusted");
  assert.equal(untrusted.trustSource, "hooks/list");
  assert.equal(untrusted.enabled, true);
  assert.match(untrusted.hint, /trust it once/);

  const trusted = await promptHookReport({ root, listHooks: async () => listed({ trustStatus: "trusted" }) });
  assert.equal(trusted.trust, "trusted");
  assert.equal(trusted.hint, null);

  const modified = await promptHookReport({ root, listHooks: async () => listed({ trustStatus: "modified" }) });
  assert.equal(modified.trust, "modified");
  assert.ok(modified.hint);
});

test("an install without the hook is not_installed; the old Claude hooks file does not count", async () => {
  const legacy = listed({ key: "codex-agent-link@agent-link:hooks/hooks.json:user_prompt_submit:0:0", trustStatus: "trusted" });
  const report = await promptHookReport({ root, listHooks: async () => legacy });
  assert.equal(report.trust, "not_installed");
  assert.match(report.hint, /Update the Codex plugin/);
});

test("no connected app-server or a failing hooks/list is unknown", async () => {
  const none = await promptHookReport({ root, listHooks: null });
  assert.equal(none.declared, true);
  assert.equal(none.trust, "unknown");
  assert.equal(none.trustSource, null);
  const failing = await promptHookReport({ root, listHooks: async () => { throw new Error("method not found"); } });
  assert.equal(failing.trust, "unknown");
});
