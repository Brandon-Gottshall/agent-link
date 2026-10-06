#!/usr/bin/env node
// Runs the offline test suite with `node --test` and an explicit file list
// (Node 20's --test takes no globs). Nothing here launches Codex.app, a real
// app-server, or a GUI; live checks are scripts/*.live.js and need
// AGENT_LINK_LIVE=1.
//
//   node scripts/run-offline-tests.js [group...] [-- node --test flags]
//
// Groups: claude, codex, all (default). Example:
//   node scripts/run-offline-tests.js codex -- --test-concurrency=1
//
// New offline test files must be added to a group below. Any file matching
// node's default test-name patterns that no group lists is reported on stderr.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const groups = {
  claude: [
    "tests/claude/channel-bridge.test.js",
    "tests/claude/channel-wait-race.test.js",
    "tests/claude/desktop-registry.test.js",
    "tests/claude/mailbox.test.js",
    "tests/claude/notify-hook.test.js",
    "tests/claude/read-inbox.test.js",
    "tests/claude/reply.test.js",
    "tests/claude/send.test.js",
    "tests/claude/session-index.test.js",
    "tests/claude/session-resolver.test.js",
    "tests/claude/wait.test.js",
    "tests/shared/cross-host-receipt.test.js",
    "tests/shared/host-detect.test.js",
    "tests/shared/runtime-context.test.js"
  ],
  codex: [
    "tests/codex/app-server-client.test.js",
    "tests/codex/app-server-lifecycle.test.js",
    "tests/codex/chat-style-close.test.js",
    "tests/codex/codex-binary.test.js",
    "tests/codex/server-idle-churn.test.js",
    "tests/codex/server-tools.test.js",
    "tests/codex/session-index.test.js",
    "scripts/archive-exdev-regression-test.js",
    "scripts/dependency-handoff-regression-test.js",
    "scripts/feedback-regression-test.js",
    "scripts/project-orchestrator-regression-test.js",
    "scripts/sidebar-state-smoke-test.js"
  ],
  mcp: [
    "scripts/mcp-smoke-test.js"
  ]
};
groups.all = [...groups.claude, ...groups.codex, ...groups.mcp];

// Mirrors node --test's default discovery patterns closely enough to catch an
// offline test nobody wired in.
const DEFAULT_PATTERN = /(^test\.[cm]?js$)|(^test-.+\.[cm]?js$)|([.\-_]test\.[cm]?js$)/;
const SKIP_DIRS = new Set(["node_modules", ".git", "fixtures", "wf-runs", "dist", "build"]);

function discoverable(dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) discoverable(path.join(dir, entry.name), out);
    } else if (DEFAULT_PATTERN.test(entry.name)) {
      out.push(path.relative(root, path.join(dir, entry.name)));
    }
  }
  return out;
}

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const names = (dash >= 0 ? argv.slice(0, dash) : argv);
const passthrough = dash >= 0 ? argv.slice(dash + 1) : [];
const selected = names.length ? names : ["all"];
const files = [];
for (const name of selected) {
  if (!groups[name]) {
    process.stderr.write(`run-offline-tests: unknown group "${name}" (known: ${Object.keys(groups).join(", ")})\n`);
    process.exit(2);
  }
  for (const file of groups[name]) if (!files.includes(file)) files.push(file);
}

const missing = files.filter((file) => !existsSync(path.join(root, file)));
if (missing.length) {
  process.stderr.write(`run-offline-tests: listed test files do not exist:\n  ${missing.join("\n  ")}\n`);
  process.exit(2);
}
const unlisted = discoverable().filter((file) => !groups.all.includes(file));
if (unlisted.length) {
  process.stderr.write(`run-offline-tests: WARNING these files match node --test's default patterns but no group lists them:\n  ${unlisted.join("\n  ")}\n`);
}

const result = spawnSync(process.execPath, ["--test", ...passthrough, ...files], { cwd: root, stdio: "inherit" });
if (unlisted.length) {
  process.stderr.write(`run-offline-tests: WARNING unlisted test files were not run: ${unlisted.join(", ")}\n`);
}
process.exit(result.status ?? 1);
