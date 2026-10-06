import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const DEFAULT_SIDECAR_ROOTS = [
  path.join(homedir(), "Library/Application Support/Claude/local-agent-mode-sessions"),
  path.join(homedir(), "Library/Application Support/Claude/claude-code-sessions")
];

// Field set re-derived from a survey of current Claude Desktop sidecars
// (claude-code-sessions, 2026-10). `sessionId` is the only field every
// sidecar has that Agent Link cannot do without. Notably:
//   - `processName` is absent from every current sidecar (requiring it
//     rejected all of them, dropping titles and archive state);
//   - `cliSessionId` is absent until the session's CLI first starts;
//   - `title` is absent until the first title is generated.
// Everything else is optional and copied through when present.
const REQUIRED = ["sessionId"];
const OPTIONAL = [
  "cliSessionId",
  "priorCliSessionIds",
  "processName",
  "cwd",
  "originCwd",
  "model",
  "title",
  "userSelectedFolders",
  "isArchived",
  "createdAt",
  "lastActivityAt",
  "enabledMcpTools",
  "slashCommands"
];

export function parseSidecar(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`sidecar ${filePath} is not a JSON object`);
  }
  const out = { sourceSidecar: filePath };
  for (const k of REQUIRED) {
    if (typeof raw[k] !== "string" || !raw[k]) throw new Error(`sidecar ${filePath} missing required field ${k}`);
    out[k] = raw[k];
  }
  for (const k of OPTIONAL) if (raw[k] !== undefined) out[k] = raw[k];
  out.title = typeof out.title === "string" ? out.title : null;
  out.cwd = typeof out.cwd === "string" ? out.cwd : "";
  out.model = typeof out.model === "string" ? out.model : "unknown";
  return out;
}
