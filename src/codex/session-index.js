import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferArchiveState, normalizeArchiveScope, scoreThreadMatch } from "./thread-utils.js";

const MAX_PREVIEW_CHARS = 500;

export async function listLocalThreads(options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const archiveScope = normalizeArchiveScope(options);
  const roots = rootsForArchiveScope(codexHome, archiveScope);
  const sessionIndex = await readSessionIndex(codexHome);

  const files = [];
  for (const root of roots) {
    files.push(...await collectJsonlFiles(root));
  }

  const withStats = await Promise.all(files.map(async (file) => {
    const stat = await fs.stat(file);
    return { file, mtimeMs: stat.mtimeMs, size: stat.size };
  }));

  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const limit = clampNumber(options.limit ?? 20, 1, 2000);
  const searchTerm = options.searchTerm?.toLowerCase() || null;
  const cwdFilter = normalizeCwdFilter(options.cwd);
  const results = [];

  for (const entry of withStats) {
    const summary = await readLocalThreadSummary(entry.file, entry, sessionIndex);
    if (!summary) {
      continue;
    }
    if (cwdFilter && !cwdFilter.has(summary.cwd)) {
      continue;
    }
    if (searchTerm && !threadMatches(summary, searchTerm)) {
      continue;
    }
    results.push(summary);
    if (results.length >= limit) {
      break;
    }
  }

  return {
    data: results,
    source: "local-jsonl",
    archiveScope,
    codexHome,
    scannedFiles: withStats.length
  };
}

export async function readLocalThread(threadId, options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const roots = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  const sessionIndex = await readSessionIndex(codexHome);
  for (const root of roots) {
    const files = await collectJsonlFiles(root);
    for (const file of files) {
      const summary = await readLocalThreadSummary(file, { file }, sessionIndex);
      if (summary?.id === threadId) {
        if (!options.includeTurns) {
          return { thread: summary, source: "local-jsonl" };
        }
        const transcript = await readRecentTranscriptItems(file, options.recentItems ?? 20);
        return {
          thread: {
            ...summary,
            recentItems: transcript
          },
          source: "local-jsonl"
        };
      }
    }
  }
  throw new Error(`Thread ${threadId} was not found under ${codexHome}`);
}

export async function archiveLocalThread(threadId, options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const located = await findLocalThread(threadId, { codexHome });
  const activeRoot = path.join(codexHome, "sessions");
  const archivedRoot = path.join(codexHome, "archived_sessions");
  const before = located.thread.archiveState ?? inferArchiveState(located.path);

  if (before.scope === "archived") {
    return {
      ok: true,
      threadId,
      alreadyArchived: true,
      from: located.path,
      to: located.path,
      thread: located.thread,
      archiveStateBefore: before,
      archiveStateAfter: before,
      codexHome
    };
  }

  const relative = path.relative(activeRoot, located.path);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Thread ${threadId} is not under ${activeRoot}; refusing to archive ${located.path}`);
  }

  const destination = path.join(archivedRoot, relative);
  try {
    await fs.access(destination);
    throw new Error(`Archive destination already exists for thread ${threadId}: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await moveFileAcrossDevices(located.path, destination);
  const afterThread = {
    ...located.thread,
    path: destination,
    archiveState: inferArchiveState(destination)
  };

  return {
    ok: true,
    threadId,
    alreadyArchived: false,
    from: located.path,
    to: destination,
    thread: afterThread,
    archiveStateBefore: before,
    archiveStateAfter: afterThread.archiveState,
    codexHome
  };
}

async function moveFileAcrossDevices(source, destination) {
  try {
    await fs.rename(source, destination);
    return;
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
  }
  // archived_sessions may live on another volume (symlinked offload). Stage the
  // copy under a non-.jsonl name so discovery never sees a partial file, promote
  // with a same-volume atomic rename, and keep mtime — thread ordering uses it.
  const sourceStat = await fs.stat(source);
  const staging = `${destination}.exdev-tmp-${process.pid}`;
  try {
    await fs.copyFile(source, staging);
    await fs.utimes(staging, sourceStat.atime, sourceStat.mtime);
    await fs.rename(staging, destination);
  } catch (error) {
    await fs.rm(staging, { force: true });
    throw error;
  }
  await fs.unlink(source);
}

async function findLocalThread(threadId, options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const found = await readLocalThread(threadId, { codexHome });
  return {
    thread: found.thread,
    path: found.thread.path,
    codexHome
  };
}

async function collectJsonlFiles(root) {
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const out = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...await collectJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(fullPath);
    }
  }
  return out;
}

async function readSessionIndex(codexHome) {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  let raw;
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch {
    return new Map();
  }

  const index = new Map();
  for (const line of raw.trimEnd().split("\n")) {
    if (!line) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.id && record.thread_name) {
      index.set(record.id, {
        name: record.thread_name,
        updatedAt: record.updated_at ?? null
      });
    }
  }
  return index;
}

async function readLocalThreadSummary(file, fileInfo = {}, sessionIndex = new Map()) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }

  const lines = raw.trimEnd().split("\n");
  let meta = null;
  let firstUserMessage = null;
  let lastEventType = null;
  let lastTimestamp = null;
  let lastAgentMessage = null;
  let threadName = null;

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    lastTimestamp = record.timestamp ?? lastTimestamp;

    if (record.type === "session_meta") {
      meta ??= record.payload;
      continue;
    }

    if (record.type === "event_msg" && record.payload?.type) {
      lastEventType = record.payload.type;
      if (record.payload.type === "user_message" && !firstUserMessage) {
        firstUserMessage = record.payload.message;
      }
      if (record.payload.type === "agent_message") {
        lastAgentMessage = record.payload.message;
      }
      if (record.payload.type === "thread_name_updated" && record.payload.thread_name) {
        threadName = record.payload.thread_name;
      }
      continue;
    }

    if (record.type === "response_item" && record.payload?.type === "message") {
      const role = record.payload.role;
      const text = contentText(record.payload.content);
      if (role === "user" && !firstUserMessage) {
        firstUserMessage = text;
      }
      if (role === "assistant") {
        lastAgentMessage = text;
      }
    }
  }

  if (!meta?.id) {
    return null;
  }

  const indexed = sessionIndex.get(meta.id) ?? null;
  const updatedAt = Math.max(
    parseDateSeconds(lastTimestamp) ?? 0,
    parseDateSeconds(indexed?.updatedAt) ?? 0,
    Math.floor((fileInfo.mtimeMs ?? Date.now()) / 1000)
  );
  return {
    id: meta.id,
    name: threadName ?? indexed?.name ?? null,
    preview: truncate(firstUserMessage || "", MAX_PREVIEW_CHARS),
    cwd: meta.cwd ?? null,
    createdAt: Math.floor(Date.parse(meta.timestamp) / 1000),
    updatedAt,
    status: localStatus(lastEventType),
    path: file,
    archiveState: inferArchiveState(file),
    source: meta.source ?? null,
    originator: meta.originator ?? null,
    cliVersion: meta.cli_version ?? null,
    modelProvider: meta.model_provider ?? null,
    agentNickname: null,
    agentRole: null,
    localOnly: true,
    lastEventType,
    lastAgentMessage: truncate(lastAgentMessage || "", MAX_PREVIEW_CHARS),
    size: fileInfo.size ?? null
  };
}

async function readRecentTranscriptItems(file, limit) {
  const raw = await fs.readFile(file, "utf8");
  const items = [];

  for (const line of raw.trimEnd().split("\n")) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const item = summarizeRecord(record);
    if (item) {
      items.push(item);
    }
  }

  return items.slice(-clampNumber(limit, 1, 100));
}

function summarizeRecord(record) {
  if (record.type === "event_msg") {
    const type = record.payload?.type;
    if (type === "user_message") {
      return {
        timestamp: record.timestamp,
        type: "userMessage",
        text: truncate(record.payload.message || "", MAX_PREVIEW_CHARS)
      };
    }
    if (type === "agent_message") {
      return {
        timestamp: record.timestamp,
        type: "agentMessage",
        text: truncate(record.payload.message || "", MAX_PREVIEW_CHARS)
      };
    }
    if (type?.includes("exec") || type?.includes("tool") || type?.includes("turn") || type?.includes("task")) {
      return {
        timestamp: record.timestamp,
        type
      };
    }
  }

  if (record.type === "response_item" && record.payload?.type === "message") {
    return {
      timestamp: record.timestamp,
      type: `${record.payload.role}Message`,
      text: truncate(contentText(record.payload.content), MAX_PREVIEW_CHARS)
    };
  }

  return null;
}

function localStatus(lastEventType) {
  if (!lastEventType) {
    return { type: "unknown", source: "local-jsonl" };
  }
  if (["task_completed", "turn_completed", "agent_message", "thread_name_updated"].includes(lastEventType)) {
    return { type: "idle", source: "local-jsonl", lastEventType };
  }
  if (["task_started", "turn_started"].includes(lastEventType)) {
    return { type: "possiblyActive", source: "local-jsonl", lastEventType };
  }
  return { type: "unknown", source: "local-jsonl", lastEventType };
}

function contentText(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => item?.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function parseDateSeconds(value) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function threadMatches(thread, searchTerm) {
  return scoreThreadMatch(thread, searchTerm).score > 0;
}

function rootsForArchiveScope(codexHome, archiveScope) {
  if (archiveScope === "archived") {
    return [path.join(codexHome, "archived_sessions")];
  }
  if (archiveScope === "all") {
    return [
      path.join(codexHome, "sessions"),
      path.join(codexHome, "archived_sessions")
    ];
  }
  return [path.join(codexHome, "sessions")];
}

function normalizeCwdFilter(cwd) {
  if (!cwd) {
    return null;
  }
  if (Array.isArray(cwd)) {
    return new Set(cwd);
  }
  return new Set([cwd]);
}

function truncate(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(number)));
}
