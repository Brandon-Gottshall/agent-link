import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { parseSidecar } from "./desktop-registry.js";
import { claudeProjectsRoot, currentClaudeSessionId } from "../shared/host-detect.js";

export const DEFAULT_DESKTOP_ROOT = path.join(homedir(), "Library/Application Support/Claude/local-agent-mode-sessions");
export const DEFAULT_CODE_ROOT = path.join(homedir(), "Library/Application Support/Claude/claude-code-sessions");

// Resolved per call so CLAUDE_CONFIG_DIR is honored (see claudeConfigDir()).
export function defaultProjectsRoot() {
  return claudeProjectsRoot();
}

// Transcripts routinely reach tens of MB, but the summary below only needs the
// opening records. Read a bounded prefix instead of the whole file, growing it
// only when the prefix holds no parseable line at all (e.g. one very large
// opening record).
const TRANSCRIPT_PREFIX_BYTES = 64 * 1024;
const TRANSCRIPT_PREFIX_MAX_BYTES = 4 * 1024 * 1024;

// `ps` output for every process on a busy machine can exceed Node's default
// 1 MiB buffer, which used to fail silently and report every session as not
// loaded.
const PS_MAX_BUFFER = 16 * 1024 * 1024;

// Session listing runs on a 1s poll, so re-parsing every transcript each tick
// dominates CPU. Transcript prefixes are immutable in practice, so key the
// summary on (mtime, size) and re-read only what actually changed.
const transcriptSummaryCache = new Map();

// Same story for sidecars: a few MB of JSON (one session file reaches ~1 MB)
// re-parsed on every tick. Key on (mtime, size) as above. Failed parses are
// cached too (as `parsed: null`), so a malformed sidecar costs one stat per
// listing instead of a full read and parse.
const sidecarCache = new Map();

export function listClaudeSessions({
  desktopRoot = DEFAULT_DESKTOP_ROOT,
  codeRoot = DEFAULT_CODE_ROOT,
  projectsRoot = defaultProjectsRoot(),
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

// Fast lookup of one session by any of its ids (sidecar `local_<uuid>`,
// CLI session id, or `local_<cliSessionId>`). Never runs `ps` and never
// summarizes every transcript:
//   - a `local_` id is first tried as a sidecar file name (direct lookup);
//   - a CLI id is matched against sidecars' cliSessionId (cached parses,
//     short-circuits on the first match), then against the one transcript
//     file it names.
// The returned session has `loaded: false`; callers that know better (the
// current session is by definition running) override it.
export function findClaudeSessionById(id, {
  desktopRoot = DEFAULT_DESKTOP_ROOT,
  codeRoot = DEFAULT_CODE_ROOT,
  projectsRoot = defaultProjectsRoot(),
  transcriptPath
} = {}) {
  const value = typeof id === "string" ? id.trim() : "";
  if (!value) return null;
  const roots = [[desktopRoot, "desktop"], [codeRoot, "code"]];
  if (value.startsWith("local_")) {
    for (const [root, surface] of roots) {
      const file = findSidecarFileById(root, value);
      const parsed = file ? parseSidecarCached(file) : null;
      if (parsed) return withTranscript(normalizeSidecar(parsed, surface), projectsRoot);
    }
  }
  const cliId = value.startsWith("local_") ? value.slice("local_".length) : value;
  for (const [root, surface] of roots) {
    const parsed = findSidecar(root, (s) => s.cliSessionId === cliId || s.sessionId === value);
    if (parsed) return withTranscript(normalizeSidecar(parsed, surface), projectsRoot);
  }
  // A CLI id the session used before (`priorCliSessionIds`) still belongs to
  // that sidecar, matching claudeSessionAliases(). If more than one sidecar
  // claims the prior id, none is picked.
  const priorMatches = [];
  for (const [root, surface] of roots) {
    for (const parsed of filterSidecars(root, (s) => Array.isArray(s.priorCliSessionIds) && s.priorCliSessionIds.includes(cliId))) {
      priorMatches.push(normalizeSidecar(parsed, surface));
    }
  }
  if (priorMatches.length === 1) return withTranscript(priorMatches[0], projectsRoot);
  return findTranscriptSessionByCliId(cliId, { transcriptPath, projectsRoot });
}

export function resolveCurrentClaudeSession({
  sessionId = currentClaudeSessionId(),
  desktopRoot,
  codeRoot,
  projectsRoot,
  transcriptPath
} = {}) {
  if (!sessionId) return null;
  const session = findClaudeSessionById(sessionId, { desktopRoot, codeRoot, projectsRoot, transcriptPath });
  // This process runs inside the session, so it is loaded by definition.
  return session ? { ...session, loaded: true } : null;
}

// Is the `claude --resume <cliSessionId>` process for one session running?
// One `ps` call and one regex, for wait loops that only care about a single
// session (instead of re-listing every session).
export function isClaudeSessionLoaded(cliSessionId, { psOutput } = {}) {
  if (!cliSessionId) return false;
  return isLoaded(resumeCandidateLines(psOutput ?? safePs()), cliSessionId);
}

// Resolve a transcript-only session (e.g. Claude Code running inside Claude
// Desktop) by its cliSessionId. Kept cheap for the per-prompt notify hook:
// prefer the hook payload's transcript_path (O(1)), otherwise probe one file
// per project dir with existsSync — never parse transcript contents.
export function findTranscriptSessionByCliId(cliSessionId, { transcriptPath, projectsRoot = defaultProjectsRoot() } = {}) {
  if (!cliSessionId) return null;
  let file = null;
  if (transcriptPath && path.basename(transcriptPath, ".jsonl") === cliSessionId && fs.existsSync(transcriptPath)) {
    file = transcriptPath;
  } else {
    file = findTranscriptFileByCliId(cliSessionId, projectsRoot);
  }
  if (!file) return null;
  let lastActivityAt = null;
  try {
    lastActivityAt = fs.statSync(file).mtimeMs;
  } catch {
    // keep null
  }
  return {
    sessionId: cliSessionId.startsWith("local_") ? cliSessionId : `local_${cliSessionId}`,
    cliSessionId,
    title: null,
    cwd: "",
    model: "unknown",
    isArchived: false,
    lastActivityAt,
    sourceSidecar: null,
    transcriptPath: file,
    surface: "code",
    source: "transcript",
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

function withTranscript(session, projectsRoot) {
  if (!session.cliSessionId || session.transcriptPath) return session;
  const file = findTranscriptFileByCliId(session.cliSessionId, projectsRoot);
  return file ? { ...session, transcriptPath: file } : session;
}

// Direct sidecar lookup by sidecar id only (no walk over every sidecar, no
// transcript scan). Returns null for ids that are not `local_<uuid>` files.
export function findSidecarSessionById(sessionId, {
  desktopRoot = DEFAULT_DESKTOP_ROOT,
  codeRoot = DEFAULT_CODE_ROOT
} = {}) {
  for (const [root, surface] of [[desktopRoot, "desktop"], [codeRoot, "code"]]) {
    const file = findSidecarFileById(root, sessionId);
    const parsed = file ? parseSidecarCached(file) : null;
    if (parsed) return normalizeSidecar(parsed, surface);
  }
  return null;
}

// Sidecars live at <root>/<account>/<org>/<sessionId>.json. Look the file up
// by name instead of parsing every sidecar.
export function findSidecarFileById(root, sessionId, { maxDepth = 3 } = {}) {
  if (!root || !sessionId || !/^local_[0-9A-Za-z-]+$/.test(sessionId)) return null;
  const name = `${sessionId}.json`;
  const visit = (dir, depth) => {
    const direct = path.join(dir, name);
    try {
      if (fs.statSync(direct).isFile()) return direct;
    } catch {
      // not here
    }
    if (depth >= maxDepth) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = visit(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(root, 0);
}

function findSidecar(root, predicate) {
  if (!root || !fs.existsSync(root)) return null;
  let found = null;
  walk(root, (file) => {
    if (found || !isSidecarFile(file)) return;
    const parsed = parseSidecarCached(file);
    if (parsed && predicate(parsed)) found = parsed;
  }, () => Boolean(found));
  return found;
}

function filterSidecars(root, predicate) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  walk(root, (file) => {
    if (!isSidecarFile(file)) return;
    const parsed = parseSidecarCached(file);
    if (parsed && predicate(parsed)) out.push(parsed);
  });
  return out;
}

function isSidecarFile(file) {
  return /^local_[0-9a-zA-Z-]+\.json$/.test(path.basename(file));
}

function listSidecarSessions(root, surface) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  walk(root, (file) => {
    if (!isSidecarFile(file)) return;
    const parsed = parseSidecarCached(file);
    if (parsed) out.push(normalizeSidecar(parsed, surface));
  });
  return out;
}

function parseSidecarCached(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = sidecarCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.parsed ? { ...cached.parsed } : null;
  }
  let parsed = null;
  try {
    parsed = parseSidecar(file);
  } catch {
    parsed = null;
  }
  sidecarCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  return parsed ? { ...parsed } : null;
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

// Only top-level transcripts, `<projectsRoot>/<project>/<cliSessionId>.jsonl`,
// are sessions. Deeper files (`<cliSessionId>/subagents/agent-*.jsonl`) belong
// to subagents and used to replace their parent session in the index.
function listTranscriptSessions(projectsRoot) {
  if (!projectsRoot || !fs.existsSync(projectsRoot)) return [];
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsRoot, project.name);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const session = parseTranscriptSummary(path.join(dir, entry.name), projectsRoot);
      if (session) out.push(session);
    }
  }
  return out;
}

// The listing entry for one transcript file (title, cwd, timestamps) without
// listing every session: an exact-id lookup that found a transcript-only
// session uses this to fill in what findTranscriptSessionByCliId leaves out.
export function summarizeTranscriptSession(file, { projectsRoot = defaultProjectsRoot() } = {}) {
  return file ? parseTranscriptSummary(file, projectsRoot) : null;
}

function parseTranscriptSummary(file, projectsRoot) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = transcriptSummaryCache.get(file);
  let summary;
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    summary = { ...cached.summary };
  } else {
    summary = buildTranscriptSummary(file, projectsRoot, stat);
    if (!summary) return null;
    transcriptSummaryCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
    summary = { ...summary };
  }
  // Activity is when the transcript was last written, not when its first
  // record was.
  summary.lastActivityAt = stat.mtimeMs;
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
  try {
    const fd = fs.openSync(file, "r");
    try {
      for (let limit = TRANSCRIPT_PREFIX_BYTES; ; limit *= 2) {
        const { lines, atEof } = readPrefixLines(fd, stat.size, limit);
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            firstRecord = JSON.parse(line);
            break;
          } catch {
            continue;
          }
        }
        if (firstRecord || atEof || limit >= TRANSCRIPT_PREFIX_MAX_BYTES) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  // The file name is the id `claude --resume` and CLAUDE_CODE_SESSION_ID use;
  // the first record can carry an older id after a resume or fork.
  const cliSessionId = path.basename(file, ".jsonl");
  if (!cliSessionId) return null;
  const cwd = firstRecord?.cwd ?? inferCwdFromProjectPath(file, projectsRoot);
  const createdAt = Date.parse(firstRecord?.timestamp ?? firstRecord?.createdAt ?? "");
  return {
    sessionId: cliSessionId.startsWith("local_") ? cliSessionId : `local_${cliSessionId}`,
    cliSessionId,
    processName: path.basename(path.dirname(file)),
    cwd,
    model: firstRecord?.model ?? "unknown",
    title: firstRecord?.title ?? firstRecord?.content?.title ?? path.basename(path.dirname(file)),
    isArchived: false,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    lastActivityAt: stat.mtimeMs,
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

// One entry per logical session. A sidecar and the transcript it points at
// (by cliSessionId, or an earlier cliSessionId) are the same session; the
// sidecar wins and inherits the transcript path. Sidecars that have no
// cliSessionId yet are keyed by their own sessionId.
function dedupeSessions(sessions) {
  const byKey = new Map();
  const aliasToKey = new Map();
  const keyFor = (session) => {
    const cli = session.cliSessionId;
    if (cli && aliasToKey.has(cli)) return aliasToKey.get(cli);
    return cli ? `cli:${cli}` : `id:${session.sessionId}`;
  };
  const ordered = [...sessions].sort((a, b) => sourceRank(b.source) - sourceRank(a.source));
  // A prior CLI id claimed by more than one sidecar is ambiguous: it merges
  // into neither.
  const priorClaims = new Map();
  for (const session of ordered) {
    for (const prior of new Set(Array.isArray(session.priorCliSessionIds) ? session.priorCliSessionIds : [])) {
      priorClaims.set(prior, (priorClaims.get(prior) ?? 0) + 1);
    }
  }
  for (const session of ordered) {
    const key = keyFor(session);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, session);
      for (const prior of Array.isArray(session.priorCliSessionIds) ? session.priorCliSessionIds : []) {
        if (typeof prior === "string" && prior && priorClaims.get(prior) === 1 && !aliasToKey.has(prior)) aliasToKey.set(prior, key);
      }
      if (session.cliSessionId && !aliasToKey.has(session.cliSessionId)) aliasToKey.set(session.cliSessionId, key);
      continue;
    }
    if (session.source === "transcript" && !existing.transcriptPath && session.cliSessionId === existing.cliSessionId) {
      byKey.set(key, { ...existing, transcriptPath: session.transcriptPath });
    }
  }
  return [...byKey.values()];
}

function sourceRank(source) {
  if (source === "sidecar:desktop" || source === "sidecar:code") return 2;
  return 1;
}

let psErrorReported = false;

export function safePs({ spawn = spawnSync } = {}) {
  let result;
  try {
    result = spawn("ps", ["-Awwo", "command"], { encoding: "utf8", maxBuffer: PS_MAX_BUFFER });
  } catch (error) {
    reportPsError(error?.message ?? String(error));
    return "";
  }
  if (result?.error || result?.status !== 0) {
    reportPsError(result?.error?.message ?? `ps exited with status ${result?.status}`);
    return "";
  }
  return String(result.stdout ?? "");
}

function reportPsError(message) {
  if (psErrorReported) return;
  psErrorReported = true;
  // stdout is the MCP channel; diagnostics go to stderr only.
  process.stderr.write(`agent-link: ps failed, Claude sessions will report loaded=false: ${message}\n`);
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

function walk(dir, visit, stop = () => false) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (stop()) return;
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fp, visit, stop);
    else if (entry.isFile()) visit(fp);
  }
}
