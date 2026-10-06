// Hermetic environment for spawning the MCP server (or any child) in tests.
//
// hermeticEnv() copies the current environment minus every inherited
// CODEX_*, CLAUDE_* and AGENT_LINK_* variable, so a test behaves the same on a
// developer machine inside a Codex thread or Claude session as it does on a
// bare CI runner. HOME defaults to a fresh temp directory (removed at process
// exit) so nothing can read or write the real ~/.claude or ~/.codex.
//
//   hermeticEnv()                                   temp HOME, CODEX_HOME=<HOME>/.codex
//   hermeticEnv({ home: dir })                      caller-owned HOME
//   hermeticEnv({ codexHome: dir })                 explicit CODEX_HOME
//   hermeticEnv({ overrides: { FOO: "1", BAR: undefined } })
//                                                   set FOO, delete BAR (applied last)
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const INHERITED_PREFIXES = /^(CODEX_|CLAUDE_|AGENT_LINK_)/;
const tempHomes = [];
let cleanupRegistered = false;

export function makeTempHome(prefix = "agent-link-home-") {
  const home = mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  tempHomes.push(home);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", () => {
      for (const dir of tempHomes) rmSync(dir, { recursive: true, force: true });
    });
  }
  return home;
}

export function hermeticEnv({ home, codexHome, overrides = {}, base = process.env } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || INHERITED_PREFIXES.test(key)) continue;
    env[key] = value;
  }
  // Children that run `#!/usr/bin/env node` (the stub app-server) must use the
  // same Node as the test runner, not whatever a version-manager shim picks.
  const nodeDir = path.dirname(process.execPath);
  env.PATH = [nodeDir, ...(env.PATH || "").split(path.delimiter).filter((dir) => dir && dir !== nodeDir)].join(path.delimiter);
  env.HOME = home ?? makeTempHome();
  env.CODEX_HOME = codexHome ?? path.join(env.HOME, ".codex");
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = String(value);
  }
  return env;
}
