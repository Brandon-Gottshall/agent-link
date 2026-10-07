#!/usr/bin/env node
// Runs the offline test suite with `node --test` and an explicit file list
// (Node 20's --test takes no globs). Nothing here launches Codex.app, a real
// app-server, or a GUI; live checks are scripts/*.live.js and need
// AGENT_LINK_LIVE=1.
//
//   node scripts/run-offline-tests.js [group...] [-- node --test flags]
//
// Groups: manifest, claude, codex, server, mcp, all (default). Example:
//   node scripts/run-offline-tests.js codex -- --test-concurrency=1
//
// New offline test files must be added to a group below. Any file matching
// node's default test-name patterns that no group lists is reported on stderr.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticEnv } from "../tests/helpers/env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const groups = {
  claude: [
    "tests/claude/channel-bridge.test.js",
    "tests/claude/channel-wait-race.test.js",
    "tests/claude/desktop-registry.test.js",
    "tests/claude/mailbox.test.js",
    "tests/claude/notify-hook.test.js",
    "tests/claude/peer-envelope-inbound.test.js",
    "tests/claude/read-inbox.test.js",
    "tests/claude/reply.test.js",
    "tests/claude/reply-model.test.js",
    "tests/claude/resolution-race.test.js",
    "tests/claude/role-handover.test.js",
    "tests/claude/send.test.js",
    "tests/claude/session-index.test.js",
    "tests/claude/session-resolver.test.js",
    "tests/claude/wait.test.js",
    "tests/shared/cross-host-receipt.test.js",
    "tests/shared/host-detect.test.js",
    "tests/shared/identity.test.js",
    "tests/shared/runtime-context.test.js",
    "tests/shared/args.test.js",
    "tests/shared/env.test.js",
    "tests/shared/envelope.test.js",
    "tests/shared/errors.test.js",
    "tests/shared/jsonl.test.js",
    "tests/shared/legacy-state.test.js",
    "tests/shared/log.test.js",
    "tests/shared/override-policy.test.js",
    "tests/shared/paths.test.js",
    "tests/shared/process-handlers.test.js",
    "tests/shared/role-lock-stress.test.js",
    "tests/shared/role-policy.test.js",
    "tests/shared/roles-store.test.js",
    "tests/shared/state-dir.test.js",
    "tests/shared/text.test.js"
  ],
  codex: [
    "tests/codex/app-server-client.test.js",
    "tests/codex/app-server-connection.test.js",
    "tests/codex/orchestrator-role.test.js",
    "tests/codex/app-server-lifecycle.test.js",
    "tests/codex/app-server-logging.test.js",
    "tests/codex/chat-style-close.test.js",
    "tests/codex/codex-delivery.test.js",
    "tests/codex/codex-receive.test.js",
    "tests/codex/codex-binary.test.js",
    "tests/codex/dependency-handoff-matching.test.js",
    "tests/codex/fork.test.js",
    "tests/codex/golden-replay.test.js",
    "tests/codex/peer-envelope.test.js",
    "tests/codex/reminder-turns.test.js",
    "tests/codex/server-idle-churn.test.js",
    "tests/codex/server-tools.test.js",
    "tests/codex/thread-modules.test.js",
    "tests/codex/session-index.test.js",
    "scripts/archive-exdev-regression-test.js",
    "scripts/dependency-handoff-regression-test.js",
    "scripts/feedback-regression-test.js",
    "scripts/project-orchestrator-regression-test.js",
    "scripts/sidebar-state-smoke-test.js"
  ],
  mcp: [
    "scripts/mcp-smoke-test.js"
  ],
  server: [
    "tests/server/guard-imports.test.js",
    "tests/server/registry.test.js",
    "tests/server/removed-arguments.test.js",
    "tests/server/roles-e2e.test.js",
    "tests/server/server-modules.test.js",
    "tests/server/session-registry.test.js",
    "tests/server/tools-contract.test.js"
  ],
  manifest: [
    "tests/approval-config-check.test.js",
    "tests/manifest.test.js"
  ]
};
groups.all = [...groups.manifest, ...groups.claude, ...groups.codex, ...groups.server, ...groups.mcp];

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

// Every test process gets a throwaway HOME (and CODEX_HOME under it) with no
// inherited CODEX_*, CLAUDE_* or AGENT_LINK_* settings, so a test that forgets
// to pass an explicit path can never read or write the real ~/.agent-link,
// ~/.claude or ~/.codex.
// CLAUDE_CONFIG_DIR and the Agent Link state paths are pinned under that HOME
// too, and tests/helpers/guard.js (preloaded into every test process) refuses
// to run unless they all point into the temp directory.
const env = hermeticEnv();
env.CLAUDE_CONFIG_DIR = path.join(env.HOME, ".claude");
env.AGENT_LINK_STATE_DIR = path.join(env.HOME, ".agent-link");
env.AGENT_LINK_MAILBOX_PATH = path.join(env.AGENT_LINK_STATE_DIR, "mailbox.jsonl");
const guard = path.join(root, "tests", "helpers", "guard.js");
const result = spawnSync(process.execPath, ["--import", guard, "--test", ...passthrough, ...files], { cwd: root, stdio: "inherit", env });
if (unlisted.length) {
  process.stderr.write(`run-offline-tests: WARNING unlisted test files were not run: ${unlisted.join(", ")}\n`);
}
process.exit(result.status ?? 1);
