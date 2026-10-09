#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Public marketplace id by default; set CODEX_AGENT_LINK_PLUGIN_ID for a local marketplace.
const pluginId = process.env.CODEX_AGENT_LINK_PLUGIN_ID || "codex-agent-link@agent-link";
const mcpServer = "codex-agent-link";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = "./dist/server.mjs";
// Which Codex config to check. The user's real config (under CODEX_HOME or
// ~/.codex) is read only when asked for explicitly, so agents and test runs
// never read it by accident:
//   --config <path> or CODEX_CONFIG=<path>        check that file
//   --real-config or AGENT_LINK_CHECK_REAL_CONFIG=1  check the real config
// By default only the read-only tools (MCP annotation readOnlyHint) must be
// auto-approved; side-effecting tools are reported, not required, matching the
// README's split. --all requires every tool.
const configPath = resolveConfigPath(process.argv.slice(2), process.env);
const requireAll = process.argv.includes("--all");

// Derive the tool list from the server itself so it cannot drift from what Codex exposes.
const allTools = await listCodexHostTools(pluginRoot);
const readOnlyTools = allTools.filter((tool) => tool.readOnly).map((tool) => tool.name);
const sideEffectTools = allTools.filter((tool) => !tool.readOnly).map((tool) => tool.name);
const tools = requireAll ? allTools.map((tool) => tool.name) : readOnlyTools;

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
      if (failures.includes(`[plugins."${pluginId}".mcp_servers.${mcpServer}.tools.${tool}] approval_mode = "approve"`)) {
        console.error(`\n[plugins."${pluginId}".mcp_servers.${mcpServer}.tools.${tool}]\napproval_mode = "approve"`);
      }
    }
  }
  process.exit(1);
}

const autoApproved = sideEffectTools.filter((tool) =>
  hasSetting(`plugins."${pluginId}".mcp_servers.${mcpServer}.tools.${tool}`, "approval_mode", "\"approve\""));
console.log(`Codex Agent Link approval config OK in ${configPath}; ${tools.length} ${requireAll ? "" : "read-only "}MCP tools approved.`);
if (!requireAll) {
  console.log(`Side-effecting tools auto-approved (they act without asking): ${autoApproved.length} of ${sideEffectTools.length}${autoApproved.length ? ` (${autoApproved.join(", ")})` : ""}.`);
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function resolveConfigPath(argv, env) {
  const flag = argv.indexOf("--config");
  if (flag >= 0) {
    const value = argv[flag + 1];
    if (!value || value.startsWith("--")) refuse("--config needs a path.");
    return path.resolve(value);
  }
  if (env.CODEX_CONFIG) return path.resolve(env.CODEX_CONFIG);
  if (argv.includes("--real-config") || env.AGENT_LINK_CHECK_REAL_CONFIG === "1") {
    return path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  }
  refuse("No config named. This check does not read your real Codex config unless asked.");
  return "";
}

/** @param {string} reason */
function refuse(reason) {
  console.error(`${reason}\nPass --config <path> (or CODEX_CONFIG=<path>) to check a specific file, or --real-config (or AGENT_LINK_CHECK_REAL_CONFIG=1) to check your real Codex config (npm run check:approval-config:real).`);
  process.exit(2);
}

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
    ".codex-plugin/plugin.json"
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
    if (!Array.isArray(server.args) || server.args[0] !== SERVER_ENTRY) {
      problems.push(`${path.relative(root, mcpPath)} mcpServers.${mcpServer}.args must start with ${SERVER_ENTRY}`);
    }
    // The Codex host declares itself so the server never has to guess.
    if (server.env?.AGENT_LINK_HOST !== "codex") {
      problems.push(`${path.relative(root, mcpPath)} mcpServers.${mcpServer}.env.AGENT_LINK_HOST must be "codex"`);
    }
  }

  return problems;
}

// Start the bundled server as a Codex host would (CODEX_HOME set, no Claude env,
// no managed app-server) and return each tool's name and whether its
// annotations mark it read-only. Uses raw
// JSON-RPC over stdio so the check runs in an installed plugin without node_modules.
async function listCodexHostTools(root) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-approval-check-"));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CLAUDE_") || key.startsWith("CODEX_") || key.startsWith("AGENT_LINK_")) continue;
    env[key] = value;
  }
  // All state under the scratch dir: the check never reads or writes the
  // user's ~/.agent-link (or reaps its managed app-servers).
  Object.assign(env, {
    HOME: scratch,
    CODEX_HOME: scratch,
    AGENT_LINK_HOST: "codex",
    AGENT_LINK_STATE_DIR: path.join(scratch, "agent-link-state"),
    AGENT_LINK_CODEX_AUTOSTART: "0",
    AGENT_LINK_DISABLE_CHANNEL: "1",
    AGENT_LINK_MAILBOX_PATH: path.join(scratch, "mailbox.jsonl")
  });

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for tools/list")), 15000);
      let buffer = "";
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited (${code}) before tools/list${stderr ? `: ${stderr.trim()}` : ""}`));
      });
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.id === 1) {
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          } else if (message.id === 2) {
            clearTimeout(timer);
            if (message.error) {
              reject(new Error(`tools/list failed: ${message.error.message}`));
            } else {
              resolve(message.result.tools
                .map((tool) => ({ name: tool.name, readOnly: tool.annotations?.readOnlyHint === true }))
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
            }
          }
        }
      });
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "agent-link-approval-config-check", version: "0" }
        }
      });
    });
  } catch (error) {
    console.error(`Could not read tools from ${SERVER_ENTRY}: ${error.message}`);
    process.exit(1);
  } finally {
    child.removeAllListeners("exit");
    child.stdin.end();
    child.kill("SIGTERM");
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
