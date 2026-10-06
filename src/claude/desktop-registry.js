import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

export const DEFAULT_SIDECAR_ROOTS = [
  path.join(homedir(), "Library/Application Support/Claude/local-agent-mode-sessions"),
  path.join(homedir(), "Library/Application Support/Claude/claude-code-sessions")
];

const REQUIRED = ["sessionId", "processName", "cliSessionId", "cwd", "model", "title"];
const OPTIONAL = ["userSelectedFolders", "isArchived", "createdAt", "lastActivityAt", "enabledMcpTools", "slashCommands"];

export function parseSidecar(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const out = { sourceSidecar: filePath };
  for (const k of REQUIRED) {
    if (raw[k] === undefined) throw new Error(`sidecar ${filePath} missing required field ${k}`);
    out[k] = raw[k];
  }
  for (const k of OPTIONAL) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

export function listSidecars({ rootDir, roots = DEFAULT_SIDECAR_ROOTS } = {}) {
  const targets = rootDir ? [rootDir] : roots;
  const out = [];
  for (const root of targets) {
    if (!fs.existsSync(root)) continue;
    walk(root, fp => {
      if (!path.basename(fp).match(/^local_[0-9a-f-]+\.json$/)) return;
      try { out.push(parseSidecar(fp)); }
      catch (e) { /* skip malformed */ }
    });
  }
  return out;
}

// Walk sidecars but stop at the first one matching `predicate(session)`.
// Cheaper than listSidecars() when the caller only needs one match — the
// notify hook fires on every UserPromptSubmit and only ever cares about the
// session whose cliSessionId matches the live process.
export function findSidecar(predicate, { rootDir, roots = DEFAULT_SIDECAR_ROOTS } = {}) {
  const targets = rootDir ? [rootDir] : roots;
  for (const root of targets) {
    if (!fs.existsSync(root)) continue;
    const found = walkFind(root, fp => {
      if (!path.basename(fp).match(/^local_[0-9a-f-]+\.json$/)) return null;
      try {
        const session = parseSidecar(fp);
        return predicate(session) ? session : null;
      } catch (e) { return null; /* skip malformed */ }
    });
    if (found) return found;
  }
  return null;
}

function walk(dir, visit) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, visit);
    else if (e.isFile()) visit(fp);
  }
}

function walkFind(dir, visit) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = walkFind(fp, visit);
      if (found) return found;
    } else if (e.isFile()) {
      const found = visit(fp);
      if (found) return found;
    }
  }
  return null;
}

export function enrichLoaded(sessions, { psOutput } = {}) {
  const ps = psOutput ?? execSync("ps -Awwo command", { encoding: "utf8" });
  const lines = ps.split("\n");
  return sessions.map(s => ({
    ...s,
    loaded: lines.some(line => isClaudeResume(line, s.cliSessionId))
  }));
}

function isClaudeResume(line, cliSessionId) {
  // Match `claude` as the program (path component or bare command), with
  // `--resume <uuid>` as a contiguous argv pair somewhere in its args, and
  // `<uuid>` followed by a word boundary (whitespace or end-of-line).
  const escaped = cliSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|/)claude\\s(\\S+\\s)*--resume\\s+${escaped}(\\s|$)`);
  return re.test(line);
}
