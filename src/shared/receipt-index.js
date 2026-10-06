import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { summarizeRuntimeCallerContext } from "./caller-context.js";
import { clampInt as clamp } from "./args.js";
import { env, envFlag } from "./env.js";
import { appendJsonl, parseJsonlLines } from "./jsonl.js";
import { legacyReceiptPaths, receiptLogPath, stateDir } from "./paths.js";
import { ensureStateDir } from "./state.js";
import { canonicalAddress, codexAddress, parseAddress } from "./identity.js";

/**
 * How receipts are read in addresses (design doc R1.6, R1.7). The server
 * injects the session-index-aware resolver (src/registry/addresses.js) at
 * startup; the default only derives addresses from the stored fields.
 * @typedef {object} ReceiptAddressResolver
 * @property {(target: Record<string, any> | null | undefined) => string | null} targetAddress
 *   the current address of a stored receipt target
 * @property {(address: string) => string | null} canonical
 *   an address as the current address of the session it names
 * @property {(address: string) => string[]} aliases
 *   every stored id or address that names the same session
 */

/** @type {ReceiptAddressResolver} */
const DEFAULT_ADDRESS_RESOLVER = {
  targetAddress(target) {
    if (!target || typeof target !== "object") return null;
    if (typeof target.address === "string" && target.address) return parseAddress(target.address) ? target.address : null;
    if (typeof target.threadId === "string" && target.threadId && target.kind !== "claude") return codexAddress(target.threadId);
    if (typeof target.sessionId === "string" && target.sessionId) {
      const address = canonicalAddress(target.sessionId, target.kind === "codex" ? "codex" : "claude");
      return address.includes(":") ? address : null;
    }
    return null;
  },
  canonical: (address) => (parseAddress(address) ? address : null),
  aliases: (address) => [address]
};

let addressResolver = DEFAULT_ADDRESS_RESOLVER;

/**
 * Installs the resolver receipts are read with; null restores the default.
 * @param {ReceiptAddressResolver | null} resolver
 */
export function setReceiptAddressResolver(resolver) {
  addressResolver = resolver ?? DEFAULT_ADDRESS_RESOLVER;
}

const RECEIPT_VERSION = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;
const MAX_TEXT = 700;

// The file receipts are appended to: options.path, else AGENT_LINK_RECEIPT_LOG
// (or a legacy alias), else <state>/receipts.jsonl (src/shared/paths.js).
export function receiptWritePath(options = {}) {
  return options.path || receiptLogPath();
}

// Every file listReceipts reads: with no override, the 0.4.x log at
// $CODEX_HOME/agent-link-receipts.jsonl first, then the current log (R4.5).
// The legacy log is never written.
export function receiptReadPaths(options = {}) {
  const writePath = receiptWritePath(options);
  if (options.path) return [writePath];
  return [...legacyReceiptPaths(), writePath];
}

// Health must still answer when a path setting is misconfigured, so a
// PathConfigError is reported as `error` instead of thrown.
export function receiptIndexSummary(options = {}) {
  let paths;
  try {
    paths = { path: receiptWritePath(options), readPaths: receiptReadPaths(options) };
  } catch (error) {
    paths = { path: null, readPaths: [], error: error.message };
  }
  return {
    ...paths,
    format: "jsonl",
    version: RECEIPT_VERSION,
    note: "Agent Link writes local action receipts for launch, message, and archive operations so later agents can query provenance by target or origin thread. Origin fields come from caller-supplied receipt data, MCP runtime caller context, or environment fallback. Reads also merge the legacy log listed in readPaths; writes go only to path."
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
  const canInferOrigin = envFlag("AGENT_LINK_INFER_RECEIPT_ORIGIN", true);
  const inferredOriginThreadId = canInferOrigin ? cleanText(env("CODEX_THREAD_ID").value, 160) : null;
  const inferredOriginTurnId = canInferOrigin ? cleanText(env("CODEX_TURN_ID").value, 160) : null;
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
      // The canonical address (design doc section 1.3); the legacy id
      // fields below stay.
      address: cleanText(target?.address, 200) ?? addressResolver.targetAddress(target),
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
  const logPath = receiptWritePath(options);
  // Directories this creates are 0700 and the log file 0600. An existing log
  // file this user owns is tightened to 0600, and so is the state dir when
  // the log lives there. Other existing directories are left alone.
  if (path.resolve(path.dirname(logPath)) === path.resolve(stateDir())) ensureStateDir();
  await appendJsonl(logPath, receipt);
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
      path: safeWritePath(options),
      error: error.message,
      receipt: receiptSummary(receipt)
    };
  }
}

function safeWritePath(options) {
  try {
    return receiptWritePath(options);
  } catch {
    return null;
  }
}

// Reads one receipt file; a missing file is empty.
async function readReceiptFile(file) {
  try {
    return parseJsonlLines(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function listReceipts(options = {}) {
  const logPath = receiptWritePath(options);
  const readPaths = receiptReadPaths(options);
  const limit = clamp(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const filters = {
    targetThreadId: cleanText(options.targetThreadId, 160),
    originThreadId: cleanText(options.originThreadId, 160),
    action: cleanText(options.action, 80),
    targetKind: cleanText(options.targetKind, 40),
    host: cleanText(options.host, 40),
    targetSessionId: cleanText(options.targetSessionId, 160),
    targetAddress: targetAddressFilter(options),
    searchTerm: normalizeSearch(options.searchTerm)
  };

  // Legacy log first, current log second; a receipt id seen twice (a copied
  // log) is listed once.
  const seen = new Set();
  const receipts = [];
  for (const file of readPaths) {
    for (const receipt of await readReceiptFile(file)) {
      const id = typeof receipt?.id === "string" ? receipt.id : null;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      receipts.push(receipt);
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

/**
 * The address filter (R1.7: compare canonical addresses): `target` as an
 * address, or targetThreadId / targetSessionId given as an address.
 * @param {Record<string, any>} options
 * @returns {string | null}
 */
function targetAddressFilter(options) {
  for (const value of [options.target, options.targetThreadId, options.targetSessionId]) {
    const parsed = parseAddress(typeof value === "string" ? value.trim() : value);
    if (parsed) return addressResolver.canonical(parsed.address) ?? parsed.address;
  }
  return null;
}

/**
 * A stored target with its address first, derived at read time for receipts
 * written before addresses existed (R1.6).
 * @param {Record<string, any>} target
 */
/**
 * True when a stored receipt target names the session `address` names: the
 * same current address, or a stored id that is any alias of that session
 * (a prior Claude CLI id, the sidecar id, either `local_` form).
 * @param {Record<string, any> | null | undefined} target
 * @param {string} address
 */
function targetMatchesAddress(target, address) {
  if (!target) return false;
  if (addressResolver.targetAddress(target) === address) return true;
  const aliases = new Set(addressResolver.aliases(address));
  return [target.address, target.sessionId, target.threadId].some((id) => typeof id === "string" && aliases.has(id));
}

function withTargetAddress(target) {
  const { address: _stored, ...rest } = target;
  return { address: addressResolver.targetAddress(target), ...rest };
}

export function receiptSummary(receipt) {
  return {
    id: receipt.id,
    createdAt: receipt.createdAt,
    action: receipt.action,
    host: receipt.host ?? null,
    purpose: receipt.purpose ?? null,
    cleanupRecommendation: receipt.cleanupRecommendation ?? "unspecified",
    tags: Array.isArray(receipt.tags) ? receipt.tags : [],
    origin: receipt.origin ?? null,
    target: receipt.target ? withTargetAddress(receipt.target) : null,
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
  if (filters.targetAddress) {
    if (!targetMatchesAddress(receipt.target, filters.targetAddress)) return false;
  } else if (filters.targetThreadId && receipt.target?.threadId !== filters.targetThreadId) {
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
  if (!filters.targetAddress && filters.targetSessionId && receipt.target?.sessionId !== filters.targetSessionId) {
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
