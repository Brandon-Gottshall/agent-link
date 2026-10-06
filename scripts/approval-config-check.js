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
// Derive the tool list from the server itself so it cannot drift from what Codex exposes.
const tools = await listCodexHostTools(pluginRoot);

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
    if (!Array.isArray(server.args) || server.args[0] !== SERVER_ENTRY) {
      problems.push(`${path.relative(root, mcpPath)} mcpServers.${mcpServer}.args must start with ${SERVER_ENTRY}`);
    }
  }

  return problems;
}

// Start the bundled server as a Codex host would (CODEX_HOME set, no Claude env,
// no managed app-server) and return the names from its tools/list. Uses raw
// JSON-RPC over stdio so the check runs in an installed plugin without node_modules.
async function listCodexHostTools(root) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-approval-check-"));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CLAUDE_") || key.startsWith("CODEX_")) continue;
    env[key] = value;
  }
  Object.assign(env, {
    CODEX_HOME: scratch,
    CODEX_AGENT_LINK_AUTOSTART: "0",
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
              resolve(message.result.tools.map((tool) => tool.name).sort());
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
