// src/codex/prompt-hook-health.js
//
// Health for the Codex prompt hook (design R1.14): whether this package's
// Codex manifest declares it, and, when Agent Link's app-server is already
// connected, the trust state Codex reports for the installed hook through
// the app-server's `hooks/list`. Agent Link never reads Codex's config.toml
// for this; without a connected app-server the trust state is "unknown".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROMPT_HOOK_FILE = "hooks/codex-hooks.json";
export const PROMPT_HOOK_SCRIPT = "src/codex/prompt-hook.js";
const CODEX_PLUGIN_NAME = "codex-agent-link";
const TRUST_STATES = new Set(["trusted", "untrusted", "modified", "managed"]);

/**
 * The plugin root holding this module: the nearest ancestor (at most four
 * levels up, so it works from src/codex/ and from the dist/ bundle) with a
 * Codex manifest named codex-agent-link. Null when none is found.
 * @param {string} [from]
 */
export function findPluginRoot(from = path.dirname(fileURLToPath(import.meta.url))) {
  let dir = from;
  for (let i = 0; i < 4; i++) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".codex-plugin", "plugin.json"), "utf8"));
      if (manifest?.name === CODEX_PLUGIN_NAME) return dir;
    } catch {
      // not here
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Whether the Codex manifest under `root` declares the prompt hook: its
 * `hooks` field names hooks/codex-hooks.json, whose UserPromptSubmit entry
 * runs src/codex/prompt-hook.js. Never throws.
 * @param {string | null} root
 * @returns {{declared: boolean, hooksFile: string | null, reason: string | null}}
 */
export function promptHookDeclaration(root) {
  if (!root) return { declared: false, hooksFile: null, reason: "plugin root not found" };
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
    const file = typeof manifest.hooks === "string" ? path.posix.normalize(manifest.hooks) : null;
    if (file !== PROMPT_HOOK_FILE) {
      return { declared: false, hooksFile: file, reason: `.codex-plugin/plugin.json hooks is not ./${PROMPT_HOOK_FILE}` };
    }
    const hooks = JSON.parse(fs.readFileSync(path.join(root, PROMPT_HOOK_FILE), "utf8"));
    const commands = (hooks?.hooks?.UserPromptSubmit ?? [])
      .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
      .map((hook) => (typeof hook?.command === "string" ? hook.command : ""));
    const declared = commands.some((command) => command.includes(PROMPT_HOOK_SCRIPT));
    return { declared, hooksFile: file, reason: declared ? null : `${PROMPT_HOOK_FILE} has no UserPromptSubmit entry for ${PROMPT_HOOK_SCRIPT}` };
  } catch (error) {
    return { declared: false, hooksFile: null, reason: `manifest unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The installed prompt hook in a `hooks/list` result, or null.
 * @param {any} listResult
 */
export function findInstalledPromptHook(listResult) {
  const entries = Array.isArray(listResult?.data) ? listResult.data : [];
  for (const entry of entries) {
    for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
      if (hook?.source !== "plugin" || hook?.eventName !== "userPromptSubmit") continue;
      if (typeof hook.pluginId !== "string" || !hook.pluginId.startsWith(`${CODEX_PLUGIN_NAME}@`)) continue;
      if (typeof hook.key !== "string" || !hook.key.includes(`:${PROMPT_HOOK_FILE}:`)) continue;
      return hook;
    }
  }
  return null;
}

/**
 * @param {{
 *   root?: string | null,
 *   listHooks?: (() => Promise<any>) | null
 * }} [options]  listHooks: a `hooks/list` call on the already connected
 *   app-server, or null to skip it (trust "unknown").
 */
export async function promptHookReport({ root = findPluginRoot(), listHooks = null } = {}) {
  const declaration = promptHookDeclaration(root);
  const base = {
    declared: declaration.declared,
    hooksFile: declaration.hooksFile,
    event: "UserPromptSubmit",
    ...(declaration.reason ? { reason: declaration.reason } : {})
  };
  if (typeof listHooks !== "function") {
    return { ...base, trust: "unknown", trustSource: null, enabled: null, pluginId: null, hint: null };
  }
  let hook;
  try {
    hook = findInstalledPromptHook(await listHooks());
  } catch {
    return { ...base, trust: "unknown", trustSource: null, enabled: null, pluginId: null, hint: null };
  }
  if (!hook) {
    return {
      ...base,
      trust: "not_installed",
      trustSource: "hooks/list",
      enabled: null,
      pluginId: null,
      hint: "The Codex install of Agent Link does not declare the prompt hook. Update the Codex plugin to this version."
    };
  }
  const trust = TRUST_STATES.has(hook.trustStatus) ? hook.trustStatus : "unknown";
  return {
    ...base,
    trust,
    trustSource: "hooks/list",
    enabled: hook.enabled === true,
    pluginId: hook.pluginId,
    hint: trust === "untrusted" || trust === "modified"
      ? "Codex runs the Agent Link prompt hook only after you trust it once: choose Review hooks / Trust when Codex asks, or open /hooks in the Codex CLI."
      : null
  };
}
