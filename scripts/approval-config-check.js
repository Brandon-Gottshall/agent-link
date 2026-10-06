#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Public marketplace id by default; set CODEX_AGENT_LINK_PLUGIN_ID for a local marketplace.
const pluginId = process.env.CODEX_AGENT_LINK_PLUGIN_ID || "codex-agent-link@agent-link";
const mcpServer = "codex-agent-link";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tools = [
  "agent_link_health",
  "archive_codex_thread",
  "check_coordination_obligations",
  "get_codex_sidebar_state",
  "list_codex_threads",
  "list_loaded_codex_threads",
  "get_codex_thread",
  "launch_codex_thread",
  "launch_project_worker",
  "list_agent_link_receipts",
  "message_codex_thread",
  "message_project_orchestrator",
  "register_dependency_handoff",
  "resolve_codex_thread",
  "resolve_project_orchestrator",
  "return_project_work_result",
  "wait_for_codex_thread"
];

const configPath = process.env.CODEX_CONFIG
  || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");

const source = fs.readFileSync(configPath, "utf8");
const lines = source.split(/\r?\n/);

const failures = [];
const envelopeFailures = validatePluginEnvelope(pluginRoot);

if (!hasSetting(`plugins."${pluginId}"`, "enabled", "true")) {
  failures.push(`[plugins."${pluginId}"] enabled = true`);
}

for (const tool of tools) {
  const section = `plugins."${pluginId}".mcp_servers.${mcpServer}.tools.${tool}`;
  if (!hasSetting(section, "approval_mode", "\"approve\"")) {
    failures.push(`[${section}] approval_mode = "approve"`);
  }
}

if (failures.length > 0 || envelopeFailures.length > 0) {
  console.error(`Codex Agent Link approval config is incomplete in ${configPath}.`);
  if (envelopeFailures.length > 0) {
    console.error("Plugin envelope failures:");
    for (const failure of envelopeFailures) {
      console.error(`- ${failure}`);
    }
  }
  console.error("Missing required settings:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  if (failures.length > 0) {
    console.error("\nAdd this TOML:");
    console.error(`\n[plugins."${pluginId}"]\nenabled = true`);
    for (const tool of tools) {
      console.error(`\n[plugins."${pluginId}".mcp_servers.${mcpServer}.tools.${tool}]\napproval_mode = "approve"`);
    }
  }
  process.exit(1);
}

console.log(`Codex Agent Link approval config OK in ${configPath}; ${tools.length} MCP tools approved.`);

function hasSetting(sectionName, key, expectedValue) {
  const sectionStart = lines.findIndex((line) => line.trim() === `[${sectionName}]`);
  if (sectionStart === -1) {
    return false;
  }

  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return false;
    }
    if (trimmed === `${key} = ${expectedValue}`) {
      return true;
    }
  }
  return false;
}

function validatePluginEnvelope(root) {
  const manifestPaths = [
    ".codex-plugin/plugin.json",
    ".plugin/plugin.json"
  ];
  const problems = [];

  for (const manifestRel of manifestPaths) {
    const manifestPath = path.join(root, manifestRel);
    if (!fs.existsSync(manifestPath)) {
      problems.push(`${manifestRel} is missing`);
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      problems.push(`${manifestRel} is not valid JSON: ${error.message}`);
      continue;
    }

    if (typeof manifest.mcpServers !== "string" || manifest.mcpServers.length === 0) {
      problems.push(`${manifestRel} must declare mcpServers as a relative path`);
      continue;
    }

    const mcpPath = path.resolve(root, manifest.mcpServers);
    if (!mcpPath.startsWith(`${root}${path.sep}`)) {
      problems.push(`${manifestRel} mcpServers escapes plugin root: ${manifest.mcpServers}`);
      continue;
    }
    if (!fs.existsSync(mcpPath)) {
      problems.push(`${manifestRel} points to missing MCP config: ${path.relative(root, mcpPath)}`);
      continue;
    }

    let mcpConfig;
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    } catch (error) {
      problems.push(`${path.relative(root, mcpPath)} is not valid JSON: ${error.message}`);
      continue;
    }

    const server = mcpConfig.mcpServers?.[mcpServer];
    if (!server) {
      problems.push(`${path.relative(root, mcpPath)} does not define mcpServers.${mcpServer}`);
      continue;
    }
    if (server.command !== "node") {
      problems.push(`${path.relative(root, mcpPath)} mcpServers.${mcpServer}.command must be node`);
    }
    if (!Array.isArray(server.args) || server.args[0] !== "./scripts/start-server.js") {
      problems.push(`${path.relative(root, mcpPath)} mcpServers.${mcpServer}.args must start with ./scripts/start-server.js`);
    }
  }

  return problems;
}
