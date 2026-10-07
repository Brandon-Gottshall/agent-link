// Preloaded into every offline test process (scripts/run-offline-tests.js
// passes `--import ./tests/helpers/guard.js`). Refuses to run unless every
// state root a test could touch points into the temp directory, so a test
// can never read or write the real ~/.agent-link, ~/.claude or ~/.codex.
// src/shared/paths.js assertTestSafeWrite is the second line of defence for
// a bare `node --test <file>` run without this preload.
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REQUIRED = ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "AGENT_LINK_STATE_DIR"];

// The real path of value, or of its nearest existing ancestor plus the rest
// (macOS /var is /private/var, and a state dir may not exist yet).
/** @param {string} value */
function real(value) {
  let current = path.resolve(value);
  const rest = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The names whose value is missing or outside the temp directory.
 * @param {Record<string, string | undefined>} env
 * @param {string} [tmpdir]
 */
export function unsafeStateRoots(env, tmpdir = os.tmpdir(), realHome = realHomeDir()) {
  const tmp = real(tmpdir);
  const home = realHome ? real(realHome) : null;
  const within = (/** @type {string} */ p, /** @type {string} */ root) => p === root || p.startsWith(`${root}${path.sep}`);
  // The real home's state roots are never allowed, even when the temp
  // directory itself is inside the home.
  const realRoots = home ? [".agent-link", ".claude", ".codex"].map((name) => path.join(home, name)) : [];
  return REQUIRED.filter((name) => {
    const value = env[name];
    if (!value || !path.isAbsolute(value)) return true;
    const resolved = real(value);
    if (home && (resolved === home || realRoots.some((root) => within(resolved, root)))) return true;
    return !within(resolved, tmp);
  });
}

function realHomeDir() {
  try {
    return os.userInfo().homedir || null;
  } catch {
    return null;
  }
}

const unsafe = unsafeStateRoots(process.env);
if (unsafe.length) {
  throw new Error(`tests/helpers/guard.js: ${unsafe.join(", ")} must point into ${os.tmpdir()} for a test run. Use npm test (scripts/run-offline-tests.js), which sets them.`);
}
