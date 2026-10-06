#!/usr/bin/env node
// MCP entrypoint. Marketplace installs are plain git checkouts without
// node_modules, so install runtime dependencies on first launch, then start
// the server from the plugin root. stdout stays reserved for MCP stdio.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDeps = ["@modelcontextprotocol/sdk", "ws"];

const missing = runtimeDeps.filter((name) => !existsSync(join(root, "node_modules", name, "package.json")));
if (missing.length > 0) {
  process.stderr.write(`agent-link: installing runtime dependencies (${missing.join(", ")} missing)\n`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: ["ignore", 2, 2],
  });
  if (result.status !== 0) {
    const reason = result.error ? result.error.message : `exit code ${result.status}`;
    process.stderr.write(`agent-link: npm ci failed (${reason}). Run \`npm ci --omit=dev\` in ${root} and restart.\n`);
    process.exit(1);
  }
}

process.chdir(root);
await import(pathToFileURL(join(root, "src", "server.js")).href);
