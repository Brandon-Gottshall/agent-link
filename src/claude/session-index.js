import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { parseSidecar } from "./desktop-registry.js";
import { currentClaudeSessionId } from "../shared/host-detect.js";

export const DEFAULT_DESKTOP_ROOT = path.join(homedir(), "Library/Application Support/Claude/local-agent-mode-sessions");
export const DEFAULT_CODE_ROOT = path.join(homedir(), "Library/Application Support/Claude/claude-code-sessions");
export const DEFAULT_PROJECTS_ROOT = path.join(homedir(), ".claude/projects");

// Transcripts routinely reach tens of MB, but the summary below only needs the
// opening records. Read a bounded prefix instead of the whole file, growing it
// only when the prefix holds no parseable line at all (e.g. one very large
// opening record).
const TRANSCRIPT_PREFIX_BYTES = 64 * 1024;
const TRANSCRIPT_PREFIX_MAX_BYTES = 4 * 1024 * 1024;

// Session listing runs on a 1s poll, so re-parsing every transcript each tick
// dominates CPU. Transcript prefixes are immutable in practice, so key the
// summary on (mtime, size) and re-read only what actually changed.
const transcriptSummaryCache = new Map();

// Same story for sidecars: a few MB of JSON (one session file reaches ~1 MB)
// re-parsed on every tick. Key on (mtime, size) as above.
const sidecarCache = new Map();

export function listClaudeSessions({
  desktopRoot = DEFAULT_DESKTOP_ROOT,
  codeRoot = DEFAULT_CODE_ROOT,
  projectsRoot = DEFAULT_PROJECTS_ROOT,
  psOutput,
  surface = "all",
  includeArchived = false
} = {}) {
  // Only `claude ... --resume <id>` lines can mark a session loaded; filter
  // once here instead of regex-scanning every ps line for every session
  // (595 sessions x ~1.5k lines was ~220 ms per call).
  const ps = resumeCandidateLines(psOutput ?? safePs());
  const sessions = [
    ...listSidecarSessions(desktopRoot, "desktop"),
    ...listSidecarSessions(codeRoot, "code"),
    ...listTranscriptSessions(projectsRoot)
  ];
  const deduped = dedupeSessions(sessions);
  return deduped
    .map((session) => ({
      ...session,
      loaded: isLoaded(ps, session.cliSessionId)
    }))
    .filter((session) => surface === "all" || session.surface === surface)
    .filter((session) => includeArchived || !session.isArchived)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

export function resolveCurrentClaudeSession({
  sessionId = currentClaudeSessionId(),
  desktopRoot,
  codeRoot,
  projectsRoot,
  psOutput
} = {}) {
  if (!sessionId) return null;
  const sessions = listClaudeSessions({ desktopRoot, codeRoot, projectsRoot, psOutput, includeArchived: true });
  return sessions.find((s) => s.sessionId === sessionId || s.cliSessionId === sessionId) ?? null;
}

// Resolve a transcript-only session (e.g. Claude Code running inside Claude
// Desktop) by its cliSessionId. These sessions have no sidecar, so findSidecar
// misses them and the notify hook would never fire. Kept cheap for the
// per-prompt notify hook: prefer the hook payload's transcript_path (O(1)),
// otherwise probe one file per project dir with existsSync — never parse
// transcript contents.
export function findTranscriptSessionByCliId(cliSessionId, { transcriptPath, projectsRoot = DEFAULT_PROJECTS_ROOT } = {}) {
  if (!cliSessionId) return null;
  let file = null;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    file = transcriptPath;
  } else {
    file = findTranscriptFileByCliId(cliSessionId, projectsRoot);
  }
  if (!file) return null;
  return {
    sessionId: cliSessionId.startsWith("local_") ? cliSessionId : `local_${cliSessionId}`,
    cliSessionId,
    surface: "code",
    source: "transcript",
    transcriptPath: file,
    loaded: false,
    supportsChannel: true,
    supportsHookInbox: true
  };
}

function findTranscriptFileByCliId(cliSessionId, projectsRoot) {
  if (!projectsRoot || !fs.existsSync(projectsRoot)) return null;
  let entries;
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const target = `${cliSessionId}.jsonl`;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsRoot, entry.name, target);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore unreadable project dirs
    }
  }
  return null;
}

function listSidecarSessions(root, surface) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  walk(root, (file) => {
    if (!path.basename(file).match(/^local_[0-9a-zA-Z-]+\.json$/)) return;
    try {
      const parsed = parseSidecarCached(file);
      out.push(normalizeSidecar(parsed, surface));
    } catch {
      // malformed sidecars are ignored like the older Desktop registry reader
    }
  });
  return out;
}

// Malformed sidecars are deliberately not cached: parseSidecar throws for them
// and the caller skips, exactly as before.
function parseSidecarCached(file) {
  const stat = fs.statSync(file);
  const cached = sidecarCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { ...cached.parsed };
  }
  const parsed = parseSidecar(file);
  sidecarCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  return { ...parsed };
}

function normalizeSidecar(session, surface) {
  return {
    ...session,
    surface,
    source: surface === "desktop" ? "sidecar:desktop" : "sidecar:code",
    loaded: false,
    supportsChannel: surface === "code",
    supportsHookInbox: true
  };
}

function listTranscriptSessions(projectsRoot) {
  if (!projectsRoot || !fs.existsSync(projectsRoot)) return [];
  const out = [];
  walk(projectsRoot, (file) => {
    if (!file.endsWith(".jsonl")) return;
    const session = parseTranscriptSummary(file, projectsRoot);
    if (session) out.push(session);
  });
  return out;
}

function parseTranscriptSummary(file, projectsRoot) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = transcriptSummaryCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { ...cached.summary };
  }
  const summary = buildTranscriptSummary(file, projectsRoot, stat);
  if (summary) {
    transcriptSummaryCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
  }
  return summary;
}

// Read the prefix as complete lines. The trailing element is a partial line
// unless we reached EOF, and dropping it also discards any UTF-8 sequence the
// byte-boundary split in half.
function readPrefixLines(fd, size, limit) {
  const length = Math.min(limit, size);
  const buf = Buffer.allocUnsafe(length);
  if (length) fs.readSync(fd, buf, 0, length, 0);
  const lines = buf.toString("utf8").split("\n");
  const atEof = length >= size;
  if (!atEof) lines.pop();
  return { lines, atEof };
}

function buildTranscriptSummary(file, projectsRoot, stat) {
  let firstRecord = null;
  let lastTimestamp = 0;
  try {
    const fd = fs.openSync(file, "r");
    try {
      for (let limit = TRANSCRIPT_PREFIX_BYTES; ; limit *= 2) {
        const { lines, atEof } = readPrefixLines(fd, stat.size, limit);
        for (const line of lines) {
          if (!line.trim()) continue;
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          firstRecord ??= record;
          const ts = Date.parse(record.timestamp ?? record.createdAt ?? 0);
          if (Number.isFinite(ts)) lastTimestamp = Math.max(lastTimestamp, ts);
          if (firstRecord && lastTimestamp) break;
        }
        if (firstRecord || atEof || limit >= TRANSCRIPT_PREFIX_MAX_BYTES) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const cliSessionId = firstRecord?.sessionId ?? firstRecord?.session_id ?? path.basename(file, ".jsonl");
  if (!cliSessionId) return null;
  const cwd = firstRecord?.cwd ?? inferCwdFromProjectPath(file, projectsRoot);
  return {
    sessionId: cliSessionId.startsWith("local_") ? cliSessionId : `local_${cliSessionId}`,
    cliSessionId,
    processName: path.basename(path.dirname(file)),
    cwd,
    model: firstRecord?.model ?? "unknown",
    title: firstRecord?.title ?? firstRecord?.content?.title ?? path.basename(path.dirname(file)),
    isArchived: false,
    lastActivityAt: lastTimestamp || stat.mtimeMs,
    sourceSidecar: null,
    transcriptPath: file,
    surface: "code",
    source: "transcript",
    loaded: false,
    supportsChannel: true,
    supportsHookInbox: true
  };
}

function inferCwdFromProjectPath(file, projectsRoot) {
  const rel = path.relative(projectsRoot, path.dirname(file));
  if (!rel || rel.startsWith("..")) return "";
  return rel.replace(/-/g, "/");
}

function dedupeSessions(sessions) {
  const byKey = new Map();
  for (const session of sessions) {
    const key = session.sessionId || session.cliSessionId;
    const existing = byKey.get(key);
    if (!existing || sourceRank(session.source) > sourceRank(existing.source)) {
      byKey.set(key, session);
    }
  }
  return [...byKey.values()];
}

function sourceRank(source) {
  if (source === "sidecar:desktop" || source === "sidecar:code") return 2;
  return 1;
}

function safePs() {
  try {
    return execSync("ps -Awwo command", { encoding: "utf8" });
  } catch {
    return "";
  }
}

function resumeCandidateLines(psOutput) {
  return String(psOutput ?? "")
    .split("\n")
    .filter((line) => line.includes("--resume") && line.includes("claude"));
}

function isLoaded(psLines, cliSessionId) {
  if (!cliSessionId || psLines.length === 0) return false;
  const escaped = String(cliSessionId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|/)claude\\s(\\S+\\s)*--resume\\s+${escaped}(\\s|$)`);
  return psLines.some((line) => re.test(line));
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fp, visit);
    else if (entry.isFile()) visit(fp);
  }
}
