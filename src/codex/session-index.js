import { promises as fs } from "node:fs";
import path from "node:path";
import { inferArchiveState, normalizeArchiveScope, scoreThreadMatch } from "./thread-utils.js";
import { clampInt as clampNumber } from "../shared/args.js";
import { parseJsonlLines } from "../shared/jsonl.js";
import { truncate } from "../shared/text.js";
import { codexHome as defaultCodexHome } from "../shared/paths.js";

const MAX_PREVIEW_CHARS = 500;
// Transcripts are read in bounded windows from the head (session_meta, first
// user message) and the tail (latest lifecycle event, last agent message), so
// file size never matters: a whole-file read of a transcript over ~512 MB used
// to throw "Invalid string length" and the thread silently disappeared.
const HEAD_WINDOW_BYTES = 64 * 1024;
const MAX_HEAD_BYTES = 4 * 1024 * 1024;
const TAIL_WINDOW_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
// Budget for reading recent transcript items backwards from the end.
const MAX_RECENT_ITEMS_BYTES = 32 * 1024 * 1024;
const SUMMARY_CACHE_LIMIT = 5000;

// Codex transcript event_msg types that move a thread between idle and
// running. Status is derived from the LAST of these, never from whatever event
// happened to be written last (token counts, item updates, renames).
export const LOCAL_LIFECYCLE_EVENTS = Object.freeze({
  task_started: "possiblyActive",
  turn_started: "possiblyActive",
  task_complete: "idle",
  turn_aborted: "idle",
  // Older transcript spellings.
  task_completed: "idle",
  turn_complete: "idle",
  turn_completed: "idle"
});

const summaryCache = new Map();

export function clearLocalThreadSummaryCache() {
  summaryCache.clear();
}

export function localThreadSummaryCacheStats() {
  return { entries: summaryCache.size, limit: SUMMARY_CACHE_LIMIT };
}

function resolveCodexHome(options = {}) {
  return options.codexHome || defaultCodexHome();
}

export async function listLocalThreads(options = {}) {
  const codexHome = resolveCodexHome(options);
  const archiveScope = normalizeArchiveScope(options);
  const roots = rootsForArchiveScope(codexHome, archiveScope);
  const sessionIndex = await readSessionIndex(codexHome);

  const files = [];
  for (const root of roots) {
    files.push(...await collectJsonlFiles(root));
  }

  const withStats = (await Promise.all(files.map(async (file) => {
    try {
      const stat = await fs.stat(file);
      return { file, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  }))).filter(Boolean);

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

// Thread ids for every transcript, from filenames only (no file reads).
// Used for "did you mean" suggestions, which only need ids to rank.
export async function listLocalThreadIds(options = {}) {
  const codexHome = resolveCodexHome(options);
  const out = [];
  for (const root of [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")]) {
    for (const file of await collectJsonlFiles(root)) {
      const id = threadIdFromFilename(path.basename(file));
      if (id) {
        out.push({ id, path: file });
      }
    }
  }
  return out;
}

export async function readLocalThread(threadId, options = {}) {
  const codexHome = resolveCodexHome(options);
  const located = await findLocalThreadFile(threadId, { codexHome });
  if (!located) {
    throw new Error(`Thread ${threadId} was not found under ${codexHome}`);
  }
  const sessionIndex = await readSessionIndex(codexHome);
  const summary = await readLocalThreadSummary(located.file, located.stat, sessionIndex);
  if (!summary) {
    throw new Error(`Thread ${threadId} transcript is unreadable: ${located.file}`);
  }
  const thread = { ...summary, lookup: located.lookup };
  if (!options.includeTurns) {
    return { thread, source: "local-jsonl" };
  }
  return {
    thread: {
      ...thread,
      recentItems: await readRecentTranscriptItems(located.file, options.recentItems ?? 20)
    },
    source: "local-jsonl"
  };
}

// Find a transcript by thread id. Codex names transcripts
// rollout-<timestamp>-<threadId>.jsonl, so match by filename (newest date
// directories first) and confirm with the first session_meta line. Only when
// no filename matches is every transcript's first line read.
export async function findLocalThreadFile(threadId, options = {}) {
  const codexHome = resolveCodexHome(options);
  const id = typeof threadId === "string" ? threadId.trim() : "";
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    return null;
  }
  const roots = options.roots ?? [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  const suffix = `-${id}.jsonl`;

  for (const root of roots) {
    const file = await findNewestFirst(root, (name) => name.endsWith(suffix) || name === `${id}.jsonl`, async (candidate) => {
      const meta = await readSessionMeta(candidate);
      return meta?.id === id;
    });
    if (file) {
      return { file, root, lookup: "filename", stat: await statInfo(file) };
    }
  }

  for (const root of roots) {
    for (const file of await collectJsonlFiles(root)) {
      const meta = await readSessionMeta(file);
      if (meta?.id === id) {
        return { file, root, lookup: "scan", stat: await statInfo(file) };
      }
    }
  }
  return null;
}

export async function archiveLocalThread(threadId, options = {}) {
  const codexHome = resolveCodexHome(options);
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
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await moveFileWithoutOverwrite(located.path, destination, threadId);
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

// Never replace an existing archive file. The destination name is reserved
// with an exclusive create (O_EXCL), so a file that appears between a check
// and the rename cannot be silently overwritten; the move then renames over
// our own empty placeholder. An empty .jsonl has no session_meta and is
// ignored by discovery while it exists.
async function moveFileWithoutOverwrite(source, destination, threadId) {
  let placeholder;
  try {
    placeholder = await fs.open(destination, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Archive destination already exists for thread ${threadId}: ${destination}`);
    }
    throw error;
  }
  await placeholder.close();
  try {
    await moveFileAcrossDevices(source, destination);
  } catch (error) {
    await fs.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
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
  const codexHome = resolveCodexHome(options);
  const found = await readLocalThread(threadId, { codexHome });
  return {
    thread: found.thread,
    path: found.thread.path,
    codexHome
  };
}

// Depth-first over date directories, newest name first, so the most recent
// transcripts are checked before old ones and the walk stops at the first hit.
async function findNewestFirst(root, nameMatches, confirm) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl") && nameMatches(entry.name)) {
      const full = path.join(root, entry.name);
      if (await confirm(full)) {
        return full;
      }
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findNewestFirst(path.join(root, entry.name), nameMatches, confirm);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

async function statInfo(file) {
  try {
    const stat = await fs.stat(file);
    return { file, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { file };
  }
}

const THREAD_ID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function threadIdFromFilename(name) {
  return THREAD_ID_IN_NAME.exec(name)?.[1] ?? null;
}

async function collectJsonlFiles(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
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
  for (const record of parseJsonlLines(raw)) {
    if (record.id && record.thread_name) {
      index.set(record.id, {
        name: record.thread_name,
        updatedAt: record.updated_at ?? null
      });
    }
  }
  return index;
}

// --- bounded reads --------------------------------------------------------

async function readRange(handle, start, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

// Complete lines in a buffer. When the buffer does not start at the file start
// the first (partial) line is dropped; when it does not reach the end of the
// file the last (partial) line is dropped. Splitting on the 0x0A byte is safe
// for UTF-8: it never occurs inside a multi-byte sequence.
function completeLines(buffer, { atStart, atEnd }) {
  const lines = [];
  let begin = 0;
  if (!atStart) {
    const first = buffer.indexOf(0x0a);
    if (first < 0) {
      return lines;
    }
    begin = first + 1;
  }
  while (begin < buffer.length) {
    const next = buffer.indexOf(0x0a, begin);
    if (next < 0) {
      if (atEnd) {
        lines.push(buffer.toString("utf8", begin));
      }
      break;
    }
    lines.push(buffer.toString("utf8", begin, next));
    begin = next + 1;
  }
  return lines;
}

function parseLine(line) {
  if (!line) {
    return null;
  }
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Read the first line only (growing the window until it is complete).
async function readSessionMeta(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    let window = Math.min(HEAD_WINDOW_BYTES, size);
    while (window > 0) {
      const buffer = await readRange(handle, 0, window);
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0 || window >= size) {
        const record = parseLine(buffer.toString("utf8", 0, newline >= 0 ? newline : buffer.length));
        return record?.type === "session_meta" ? record.payload ?? null : null;
      }
      if (window >= MAX_HEAD_BYTES) {
        return null;
      }
      window = Math.min(window * 4, MAX_HEAD_BYTES, size);
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function readHeadRecords(handle, size) {
  let window = Math.min(HEAD_WINDOW_BYTES, size);
  while (true) {
    const buffer = await readRange(handle, 0, window);
    const lines = completeLines(buffer, { atStart: true, atEnd: window >= size });
    const records = lines.map(parseLine).filter(Boolean);
    const hasMeta = records.some((record) => record.type === "session_meta");
    const hasUser = records.some((record) => userTextFromRecord(record) !== null);
    if ((hasMeta && hasUser) || window >= size || window >= MAX_HEAD_BYTES) {
      // Only whole lines count as covered: a record straddling the window
      // edge belongs to the tail read, which starts right after the last
      // newline the head saw.
      const coveredBytes = window >= size ? size : buffer.lastIndexOf(0x0a) + 1;
      return { records, coveredBytes };
    }
    window = Math.min(window * 4, MAX_HEAD_BYTES, size);
  }
}

async function readTailRecords(handle, size, skipBefore) {
  let window = Math.min(TAIL_WINDOW_BYTES, size - skipBefore);
  while (window > 0) {
    const start = size - window;
    const buffer = await readRange(handle, start, window);
    const lines = completeLines(buffer, { atStart: start <= skipBefore, atEnd: true });
    const records = lines.map(parseLine).filter(Boolean);
    const hasLifecycle = records.some((record) => lifecycleEventType(record));
    if (hasLifecycle || start <= skipBefore || window >= MAX_TAIL_BYTES) {
      return records;
    }
    window = Math.min(window * 4, MAX_TAIL_BYTES, size - skipBefore);
  }
  return [];
}

function cachedSummary(file, size, mtimeMs) {
  const cached = summaryCache.get(file);
  if (!cached || cached.size !== size || cached.mtimeMs !== mtimeMs) {
    return null;
  }
  summaryCache.delete(file);
  summaryCache.set(file, cached);
  return cached;
}

// Summaries are cached by (path, size, mtimeMs): an unchanged transcript is
// never reopened, and any append or rewrite invalidates its entry.
async function readLocalThreadSummary(file, fileInfo = {}, sessionIndex = new Map()) {
  if (Number.isFinite(fileInfo.size) && Number.isFinite(fileInfo.mtimeMs)) {
    const hit = cachedSummary(file, fileInfo.size, fileInfo.mtimeMs);
    if (hit) {
      return finalizeSummary(hit.parsed, file, fileInfo, sessionIndex);
    }
  }
  let handle;
  try {
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    const cacheKey = file;
    const cached = cachedSummary(file, stat.size, stat.mtimeMs);
    if (cached) {
      return finalizeSummary(cached.parsed, file, { size: stat.size, mtimeMs: stat.mtimeMs }, sessionIndex);
    }

    const head = await readHeadRecords(handle, stat.size);
    const tail = head.coveredBytes >= stat.size ? [] : await readTailRecords(handle, stat.size, head.coveredBytes);
    const parsed = summarizeRecords([...head.records, ...tail]);
    summaryCache.set(cacheKey, { size: stat.size, mtimeMs: stat.mtimeMs, parsed });
    if (summaryCache.size > SUMMARY_CACHE_LIMIT) {
      summaryCache.delete(summaryCache.keys().next().value);
    }
    return finalizeSummary(parsed, file, { size: stat.size, mtimeMs: stat.mtimeMs }, sessionIndex);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function summarizeRecords(records) {
  let meta = null;
  let firstUserMessage = null;
  let lastEventType = null;
  let lastLifecycleEvent = null;
  let lastTimestamp = null;
  let lastAgentMessage = null;
  let threadName = null;

  for (const record of records) {
    lastTimestamp = record.timestamp ?? lastTimestamp;

    if (record.type === "session_meta") {
      meta ??= record.payload;
      continue;
    }

    const userText = userTextFromRecord(record);
    if (userText !== null && firstUserMessage === null) {
      firstUserMessage = userText;
    }
    const agentText = agentTextFromRecord(record);
    if (agentText !== null) {
      lastAgentMessage = agentText;
    }

    if (record.type === "event_msg" && record.payload?.type) {
      lastEventType = record.payload.type;
      const lifecycle = lifecycleEventType(record);
      if (lifecycle) {
        lastLifecycleEvent = lifecycle;
      }
      if (record.payload.type === "thread_name_updated" && record.payload.thread_name) {
        threadName = record.payload.thread_name;
      }
    }
  }

  return { meta, firstUserMessage, lastEventType, lastLifecycleEvent, lastTimestamp, lastAgentMessage, threadName };
}

function finalizeSummary(parsed, file, fileInfo, sessionIndex) {
  const { meta } = parsed;
  if (!meta?.id) {
    return null;
  }
  const indexed = sessionIndex.get(meta.id) ?? null;
  const updatedAt = Math.floor(Math.max(
    parseDateSeconds(parsed.lastTimestamp) ?? 0,
    parseDateSeconds(indexed?.updatedAt) ?? 0,
    (fileInfo.mtimeMs ?? Date.now()) / 1000
  ));
  const createdSeconds = parseDateSeconds(meta.timestamp);
  return {
    id: meta.id,
    name: parsed.threadName ?? indexed?.name ?? null,
    preview: truncate(parsed.firstUserMessage || "", MAX_PREVIEW_CHARS),
    cwd: meta.cwd ?? null,
    createdAt: createdSeconds === null ? null : Math.floor(createdSeconds),
    updatedAt,
    status: localStatus(parsed.lastLifecycleEvent, parsed.lastEventType),
    path: file,
    archiveState: inferArchiveState(file),
    source: meta.source ?? null,
    originator: meta.originator ?? null,
    cliVersion: meta.cli_version ?? null,
    modelProvider: meta.model_provider ?? null,
    agentNickname: null,
    agentRole: null,
    localOnly: true,
    lastEventType: parsed.lastEventType,
    lastAgentMessage: truncate(parsed.lastAgentMessage || "", MAX_PREVIEW_CHARS),
    size: fileInfo.size ?? null
  };
}

// The most recent `limit` summarized items, read backwards from the end of the
// file in bounded chunks.
async function readRecentTranscriptItems(file, limit) {
  const wanted = clampNumber(limit, 1, 100);
  let handle;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    let end = size;
    let carry = Buffer.alloc(0);
    let bytesRead = 0;
    const newestFirst = [];
    while (end > 0 && newestFirst.length < wanted + 1 && bytesRead < MAX_RECENT_ITEMS_BYTES) {
      const length = Math.min(TAIL_WINDOW_BYTES, end);
      const start = end - length;
      const chunk = Buffer.concat([await readRange(handle, start, length), carry]);
      bytesRead += length;
      const lines = completeLines(chunk, { atStart: start === 0, atEnd: true });
      const firstNewline = chunk.indexOf(0x0a);
      carry = start === 0 || firstNewline < 0 ? (start === 0 ? Buffer.alloc(0) : chunk) : chunk.subarray(0, firstNewline);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const item = summarizeRecord(parseLine(lines[index]));
        if (item) {
          newestFirst.push(item);
        }
      }
      end = start;
    }
    return dedupeAdjacent(newestFirst.reverse()).slice(-wanted);
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Recent Codex versions write the same message as a response_item and as an
// item_completed event; keep one.
function dedupeAdjacent(items) {
  const out = [];
  for (const item of items) {
    const previous = out.at(-1);
    if (previous && previous.text !== undefined && previous.type === item.type && previous.text === item.text) {
      continue;
    }
    out.push(item);
  }
  return out;
}

function summarizeRecord(record) {
  if (!record) {
    return null;
  }
  const userText = userTextFromRecord(record);
  if (userText !== null) {
    return { timestamp: record.timestamp, type: "userMessage", text: truncate(userText, MAX_PREVIEW_CHARS) };
  }
  const agentText = agentTextFromRecord(record);
  if (agentText !== null) {
    return { timestamp: record.timestamp, type: "agentMessage", text: truncate(agentText, MAX_PREVIEW_CHARS) };
  }

  if (record.type === "event_msg") {
    const type = record.payload?.type;
    if (type === "item_completed" && record.payload.item?.type) {
      return { timestamp: record.timestamp, type: lowerFirst(record.payload.item.type) };
    }
    if (type && LOCAL_LIFECYCLE_EVENTS[type]) {
      return { timestamp: record.timestamp, type };
    }
    if (type?.includes("exec") || type?.includes("tool")) {
      return { timestamp: record.timestamp, type };
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

function userTextFromRecord(record) {
  if (record?.type === "event_msg") {
    if (record.payload?.type === "user_message") {
      return String(record.payload.message ?? "");
    }
    if (record.payload?.type === "item_completed" && record.payload.item?.type === "UserMessage") {
      return contentText(record.payload.item.content);
    }
  }
  if (record?.type === "response_item" && record.payload?.type === "message" && record.payload.role === "user") {
    return contentText(record.payload.content);
  }
  return null;
}

function agentTextFromRecord(record) {
  if (record?.type === "event_msg") {
    if (record.payload?.type === "agent_message") {
      return String(record.payload.message ?? "");
    }
    if (record.payload?.type === "item_completed" && record.payload.item?.type === "AgentMessage") {
      return contentText(record.payload.item.content);
    }
  }
  if (record?.type === "response_item" && record.payload?.type === "message" && record.payload.role === "assistant") {
    return contentText(record.payload.content);
  }
  return null;
}

function lifecycleEventType(record) {
  const type = record?.type === "event_msg" ? record.payload?.type : null;
  return type && Object.prototype.hasOwnProperty.call(LOCAL_LIFECYCLE_EVENTS, type) ? type : null;
}

export function localStatus(lastLifecycleEvent, lastEventType = lastLifecycleEvent) {
  const mapped = lastLifecycleEvent ? LOCAL_LIFECYCLE_EVENTS[lastLifecycleEvent] : null;
  return {
    type: mapped ?? "unknown",
    source: "local-jsonl",
    lastLifecycleEvent: lastLifecycleEvent ?? null,
    lastEventType: lastEventType ?? null
  };
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

function lowerFirst(value) {
  const text = String(value);
  return text.charAt(0).toLowerCase() + text.slice(1);
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
