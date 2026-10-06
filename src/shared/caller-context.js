const MAX_TEXT = 300;
const MAX_META_KEYS = 50;
const MAX_DEPTH = 6;

export function callerContextContract() {
  return {
    purpose: "Automatically attach caller thread/turn/tool-call provenance to Agent Link receipts when Codex supplies it in MCP runtime metadata.",
    precedence: [
      "receipt.originThreadId / originTurnId / originToolCallId",
      "MCP tools/call runtime metadata from request.params._meta or handler extra._meta",
      "CODEX_THREAD_ID / CODEX_TURN_ID process environment",
      "not_supplied"
    ],
    runtimeMetadataShape: {
      accepted: [
        "threadId, thread_id, codexThreadId, callerThreadId, originThreadId",
        "turnId, turn_id, codexTurnId, callerTurnId, originTurnId",
        "toolCallId, tool_call_id, callerToolCallId, originToolCallId",
        "nested objects such as { caller: { thread: { id }, turn: { id } } }"
      ],
      sources: [
        "request.params._meta",
        "handler extra._meta"
      ]
    }
  };
}

export function extractRuntimeCallerContext(request = {}, extra = {}) {
  const requestMeta = request?.params?._meta;
  const extraMeta = extra?._meta;
  const matches = {
    threadId: [],
    turnId: [],
    toolCallId: []
  };

  collectMatches(requestMeta, "request.params._meta", [], matches);
  collectMatches(extraMeta, "handler.extra._meta", [], matches);

  const threadId = firstMatch(matches.threadId);
  const turnId = firstMatch(matches.turnId);
  const toolCallId = firstMatch(matches.toolCallId);

  return {
    available: Boolean(threadId || turnId || toolCallId),
    threadId: threadId?.value ?? null,
    turnId: turnId?.value ?? null,
    toolCallId: toolCallId?.value ?? null,
    source: threadId?.source ?? turnId?.source ?? toolCallId?.source ?? "not_supplied",
    sources: {
      threadId: summarizeMatch(threadId),
      turnId: summarizeMatch(turnId),
      toolCallId: summarizeMatch(toolCallId)
    },
    requestId: cleanText(extra?.requestId, MAX_TEXT),
    sessionId: cleanText(extra?.sessionId, MAX_TEXT),
    metaKeys: {
      requestParams: topLevelKeys(requestMeta),
      extra: topLevelKeys(extraMeta)
    }
  };
}

export function summarizeRuntimeCallerContext(context) {
  const ctx = context ?? {};
  return {
    available: Boolean(ctx.available),
    threadId: cleanText(ctx.threadId, MAX_TEXT),
    turnId: cleanText(ctx.turnId, MAX_TEXT),
    toolCallId: cleanText(ctx.toolCallId, MAX_TEXT),
    source: ctx.source ?? "not_supplied",
    sources: ctx.sources ?? {},
    requestId: cleanText(ctx.requestId, MAX_TEXT),
    sessionId: cleanText(ctx.sessionId, MAX_TEXT),
    metaKeys: {
      requestParams: Array.isArray(ctx.metaKeys?.requestParams) ? ctx.metaKeys.requestParams.slice(0, MAX_META_KEYS) : [],
      extra: Array.isArray(ctx.metaKeys?.extra) ? ctx.metaKeys.extra.slice(0, MAX_META_KEYS) : []
    }
  };
}

function collectMatches(value, source, path, matches, depth = 0) {
  if (!value || depth > MAX_DEPTH) {
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 20); index += 1) {
      collectMatches(value[index], source, [...path, String(index)], matches, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (typeof child === "string" || typeof child === "number") {
      const field = classifyPath(childPath);
      if (field) {
        matches[field].push({
          value: cleanText(child, MAX_TEXT),
          source,
          path: childPath.join(".")
        });
      }
      continue;
    }
    collectMatches(child, source, childPath, matches, depth + 1);
  }
}

function classifyPath(path) {
  const normalized = normalizeKey(path.join("."));
  const leaf = normalizeKey(path[path.length - 1] ?? "");

  if (hasIdSuffix(normalized) && (
    normalized.includes("toolcall")
      || normalized.includes("tool_call")
      || (normalized.includes("tool") && normalized.includes("call"))
  )) {
    return "toolCallId";
  }

  if (hasIdSuffix(normalized) && (
    normalized.includes("thread")
      || normalized.includes("conversation")
      || normalized.includes("originthread")
      || normalized.includes("callerthread")
      || normalized.includes("sourcethread")
      || (leaf === "id" && path.some((part) => normalizeKey(part).includes("thread")))
  )) {
    return "threadId";
  }

  if (hasIdSuffix(normalized) && (
    normalized.includes("turn")
      || normalized.includes("originturn")
      || normalized.includes("callerturn")
      || (leaf === "id" && path.some((part) => normalizeKey(part).includes("turn")))
  )) {
    return "turnId";
  }

  return null;
}

function hasIdSuffix(value) {
  return value.endsWith("id") || value.endsWith("_id");
}

function firstMatch(matches) {
  return matches.find((match) => Boolean(match.value)) ?? null;
}

function summarizeMatch(match) {
  if (!match) {
    return null;
  }
  return {
    source: match.source,
    path: match.path
  };
}

function topLevelKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value).slice(0, MAX_META_KEYS);
}

function normalizeKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "");
}

function cleanText(value, max) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}
