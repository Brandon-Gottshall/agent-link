import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { summarizeRuntimeCallerContext } from "./caller-context.js";

const RECEIPT_VERSION = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;
const MAX_TEXT = 700;

export function receiptLogPath(options = {}) {
  const codexHome = options.codexHome
    || process.env.CODEX_HOME
    || path.join(os.homedir(), ".codex");
  return options.path
    || process.env.CODEX_AGENT_LINK_RECEIPT_LOG
    || path.join(codexHome, "agent-link-receipts.jsonl");
}

export function receiptIndexSummary(options = {}) {
  return {
    path: receiptLogPath(options),
    format: "jsonl",
    version: RECEIPT_VERSION,
    note: "Agent Link writes local action receipts for launch, message, and archive operations so later agents can query provenance by target or origin thread. Origin fields come from caller-supplied receipt data, MCP runtime caller context, or environment fallback."
  };
}

export function normalizeReceiptInput(value = {}, options = {}) {
  if (isNormalizedReceiptInput(value)) {
    return value;
  }
  const input = isPlainObject(value) ? value : {};
  const runtimeCallerContext = summarizeRuntimeCallerContext(options.runtimeCallerContext);
  const callerOriginThreadId = cleanText(input.originThreadId, 160);
  const callerOriginTurnId = cleanText(input.originTurnId, 160);
  const callerOriginToolCallId = cleanText(input.originToolCallId, 160);
  const runtimeOriginThreadId = cleanText(runtimeCallerContext.threadId, 160);
  const runtimeOriginTurnId = cleanText(runtimeCallerContext.turnId, 160);
  const runtimeOriginToolCallId = cleanText(runtimeCallerContext.toolCallId, 160);
  const canInferOrigin = process.env.CODEX_AGENT_LINK_INFER_RECEIPT_ORIGIN !== "0";
  const inferredOriginThreadId = canInferOrigin ? cleanText(process.env.CODEX_THREAD_ID, 160) : null;
  const inferredOriginTurnId = canInferOrigin ? cleanText(process.env.CODEX_TURN_ID, 160) : null;
  const originThread = firstOriginValue([
    ["caller_supplied", callerOriginThreadId],
    ["runtime_context", runtimeOriginThreadId],
    ["environment", inferredOriginThreadId]
  ]);
  const originTurn = firstOriginValue([
    ["caller_supplied", callerOriginTurnId],
    ["runtime_context", runtimeOriginTurnId],
    ["environment", inferredOriginTurnId]
  ]);
  const originToolCall = firstOriginValue([
    ["caller_supplied", callerOriginToolCallId],
    ["runtime_context", runtimeOriginToolCallId]
  ]);
  const originSources = {
    threadId: originThread.source,
    turnId: originTurn.source,
    toolCallId: originToolCall.source
  };

  return {
    record: input.record !== false,
    purpose: cleanText(input.purpose, 160),
    originThreadId: originThread.value,
    originTurnId: originTurn.value,
    originToolCallId: originToolCall.value,
    originSource: summarizeOriginSource(originSources),
    originSources,
    runtimeCallerContext,
    cleanupRecommendation: normalizeCleanupRecommendation(input.cleanupRecommendation),
    note: cleanText(input.note, MAX_TEXT),
    tags: cleanTags(input.tags)
  };
}

export function buildReceipt({
  action,
  receipt,
  target,
  message,
  finalResponse,
  delivery,
  replyConfirmation,
  evidence,
  runtimeCallerContext,
  appServer,
  host
}) {
  const input = normalizeReceiptInput(receipt, { runtimeCallerContext });
  const createdAt = new Date().toISOString();
  return {
    version: RECEIPT_VERSION,
    id: `agent-link-receipt-${createdAt.replace(/[:.]/g, "-")}-${randomUUID()}`,
    createdAt,
    action,
    host: cleanText(host, 40),
    purpose: input.purpose,
    cleanupRecommendation: input.cleanupRecommendation,
    tags: input.tags,
    origin: {
      threadId: input.originThreadId,
      turnId: input.originTurnId,
      toolCallId: input.originToolCallId,
      note: input.note,
      source: input.originSource,
      sources: input.originSources,
      runtime: input.runtimeCallerContext
    },
    target: {
      threadId: cleanText(target?.threadId, 160),
      turnId: cleanText(target?.turnId, 160),
      name: cleanText(target?.name, 200),
      cwd: cleanText(target?.cwd, 1000),
      archiveState: target?.archiveState ?? null,
      status: target?.status ?? null,
      deepLink: cleanText(target?.deepLink, 300),
      sessionId: cleanText(target?.sessionId, 160),
      loaded: typeof target?.loaded === "boolean" ? target.loaded : null,
      kind: cleanText(target?.kind, 40)
    },
    messagePreview: cleanText(message, MAX_TEXT),
    finalResponse: cleanText(finalResponse, MAX_TEXT),
    delivery: delivery ?? null,
    evidence: summarizeEvidence(evidence),
    replyConfirmation: summarizeReplyConfirmation(replyConfirmation),
    appServer: summarizeAppServer(appServer)
  };
}

async function tightenFileMode(target, mode) {
  try {
    const stat = await fs.stat(target);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && stat.uid !== uid) return;
    if ((stat.mode & 0o777 & ~mode) !== 0) await fs.chmod(target, mode);
  } catch {
    // missing or not ours: leave it alone
  }
}

export async function appendReceipt(receipt, options = {}) {
  const logPath = receiptLogPath(options);
  // Directories this creates are 0700 and the log file 0600. An existing log
  // file this user owns is tightened to 0600. Existing directories (such as
  // $CODEX_HOME) are left alone.
  await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  await fs.appendFile(logPath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
  await tightenFileMode(logPath, 0o600);
  return {
    ok: true,
    id: receipt.id,
    path: logPath,
    receipt: receiptSummary(receipt)
  };
}

export async function safeAppendReceipt(receipt, options = {}) {
  try {
    return await appendReceipt(receipt, options);
  } catch (error) {
    return {
      ok: false,
      id: receipt.id,
      path: receiptLogPath(options),
      error: error.message,
      receipt: receiptSummary(receipt)
    };
  }
}

export async function listReceipts(options = {}) {
  const logPath = receiptLogPath(options);
  const limit = clamp(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const filters = {
    targetThreadId: cleanText(options.targetThreadId, 160),
    originThreadId: cleanText(options.originThreadId, 160),
    action: cleanText(options.action, 80),
    targetKind: cleanText(options.targetKind, 40),
    host: cleanText(options.host, 40),
    targetSessionId: cleanText(options.targetSessionId, 160),
    searchTerm: normalizeSearch(options.searchTerm)
  };

  let raw;
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ok: true,
        path: logPath,
        data: [],
        scannedReceipts: 0,
        filters
      };
    }
    throw error;
  }

  const receipts = [];
  for (const line of raw.trimEnd().split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      receipts.push(JSON.parse(line));
    } catch {
      continue;
    }
  }

  const data = receipts
    .filter((receipt) => receiptMatches(receipt, filters))
    .sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0))
    .slice(0, limit)
    .map(receiptSummary);

  return {
    ok: true,
    path: logPath,
    data,
    scannedReceipts: receipts.length,
    filters
  };
}

export function receiptSummary(receipt) {
  return {
    id: receipt.id,
    createdAt: receipt.createdAt,
    action: receipt.action,
    host: receipt.host ?? null,
    purpose: receipt.purpose ?? null,
    cleanupRecommendation: receipt.cleanupRecommendation ?? "unspecified",
    origin: receipt.origin ?? null,
    target: receipt.target ?? null,
    messagePreview: receipt.messagePreview ?? null,
    finalResponse: receipt.finalResponse ?? null,
    delivery: receipt.delivery ?? null,
    evidence: receipt.evidence ?? null,
    replyConfirmation: receipt.replyConfirmation ?? null
  };
}

function summarizeEvidence(evidence) {
  if (!evidence) {
    return null;
  }
  return evidence;
}

function summarizeReplyConfirmation(replyConfirmation) {
  if (!replyConfirmation) {
    return null;
  }
  return {
    waited: replyConfirmation.waited ?? null,
    ok: replyConfirmation.ok ?? null,
    timedOut: replyConfirmation.timedOut ?? null,
    turnStatus: replyConfirmation.turnStatus ?? null,
    finalResponse: cleanText(replyConfirmation.finalResponse, MAX_TEXT),
    finalResponseItem: replyConfirmation.finalResponseItem ?? null,
    error: cleanText(replyConfirmation.error, MAX_TEXT),
    unsupported: replyConfirmation.unsupported ?? null,
    hint: cleanText(replyConfirmation.hint, MAX_TEXT)
  };
}

function receiptMatches(receipt, filters) {
  if (filters.targetThreadId && receipt.target?.threadId !== filters.targetThreadId) {
    return false;
  }
  if (filters.originThreadId && receipt.origin?.threadId !== filters.originThreadId) {
    return false;
  }
  if (filters.action && receipt.action !== filters.action) {
    return false;
  }
  if (filters.targetKind && receipt.target?.kind !== filters.targetKind) {
    return false;
  }
  if (filters.host && receipt.host !== filters.host) {
    return false;
  }
  if (filters.targetSessionId && receipt.target?.sessionId !== filters.targetSessionId) {
    return false;
  }
  if (filters.searchTerm && !receiptSearchText(receipt).includes(filters.searchTerm)) {
    return false;
  }
  return true;
}

function receiptSearchText(receipt) {
  return normalizeSearch([
    receipt.id,
    receipt.action,
    receipt.purpose,
    receipt.cleanupRecommendation,
    receipt.messagePreview,
    receipt.finalResponse,
    receipt.evidence?.primaryStatus,
    receipt.evidence?.interpretation,
    receipt.evidence?.loadedThreadGuard?.status,
    receipt.evidence?.loadedThreadGuard?.source,
    receipt.evidence?.loadedThreadGuard?.note,
    receipt.replyConfirmation?.finalResponse,
    receipt.replyConfirmation?.error,
    receipt.replyConfirmation?.hint,
    receipt.origin?.source,
    receipt.origin?.threadId,
    receipt.origin?.turnId,
    receipt.origin?.toolCallId,
    receipt.origin?.note,
    receipt.origin?.runtime?.requestId,
    receipt.origin?.runtime?.sessionId,
    receipt.origin?.runtime?.source,
    receipt.target?.threadId,
    receipt.target?.turnId,
    receipt.target?.name,
    receipt.target?.cwd,
    ...(receipt.tags ?? [])
  ].filter(Boolean).join("\n"));
}

function summarizeAppServer(appServer = {}) {
  return {
    kind: appServer.kind ?? null,
    managed: appServer.managed ?? null,
    connected: appServer.connected ?? null,
    codexHome: appServer.codexHome ?? null,
    platformOs: appServer.platformOs ?? null
  };
}

function normalizeCleanupRecommendation(value) {
  const text = cleanText(value, 80);
  return text || "unspecified";
}

function firstOriginValue(candidates) {
  for (const [source, value] of candidates) {
    if (value) {
      return { source, value };
    }
  }
  return { source: null, value: null };
}

function summarizeOriginSource(sources) {
  const present = new Set(Object.values(sources).filter(Boolean));
  if (present.size === 0) {
    return "not_supplied";
  }
  if (present.size === 1) {
    return [...present][0];
  }
  return "mixed";
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags
    .map((tag) => cleanText(tag, 80))
    .filter(Boolean)
    .slice(0, 20);
}

function cleanText(value, max) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

function normalizeSearch(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNormalizedReceiptInput(value) {
  return isPlainObject(value)
    && "originSource" in value
    && isPlainObject(value.originSources)
    && isPlainObject(value.runtimeCallerContext);
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(number)));
}
