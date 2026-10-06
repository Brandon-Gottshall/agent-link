const MAX_TEXT = 300;
const MAX_META_KEYS = 50;

// Caller provenance is read from an explicit allowlist of exact keys and
// nested paths, never by fuzzy key matching: a loose match once turned
// `{thread:{turnId}}` into the caller's threadId, which then became a
// message sender id.
//
// Each field lists its accepted specs in priority order. Every spec is tried
// at the top of `_meta` and inside each NAMESPACES object, request
// `params._meta` before handler `extra._meta`; the first non-empty
// string or number wins.
const NAMESPACES = [null, "openai/codex", "codex", "claudecode"];
const FIELD_SPECS = {
  threadId: [
    ["callerThreadId"],
    ["caller", "thread", "id"],
    ["threadId"],
    ["thread_id"],
    ["codexThreadId"],
    ["thread", "id"],
    ["originThreadId"]
  ],
  turnId: [
    ["callerTurnId"],
    ["caller", "turn", "id"],
    ["turnId"],
    ["turn_id"],
    ["codexTurnId"],
    ["turn", "id"],
    ["originTurnId"]
  ],
  toolCallId: [
    ["callerToolCallId"],
    ["caller", "toolCall", "id"],
    ["toolCallId"],
    ["tool_call_id"],
    ["claudecode/toolUseId"],
    ["toolUseId"],
    ["tool_use_id"],
    ["originToolCallId"]
  ]
};

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
        "threadId (priority order): " + FIELD_SPECS.threadId.map((spec) => spec.join(".")).join(", "),
        "turnId (priority order): " + FIELD_SPECS.turnId.map((spec) => spec.join(".")).join(", "),
        "toolCallId (priority order): " + FIELD_SPECS.toolCallId.map((spec) => spec.join(".")).join(", "),
        "each key is exact (case-sensitive) and read at the top of _meta or inside one of: " + NAMESPACES.filter(Boolean).join(", ")
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
  const metas = [
    [requestMeta, "request.params._meta"],
    [extraMeta, "handler.extra._meta"]
  ];

  const threadId = findField(metas, FIELD_SPECS.threadId);
  const turnId = findField(metas, FIELD_SPECS.turnId);
  const toolCallId = findField(metas, FIELD_SPECS.toolCallId);

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

function findField(metas, specs) {
  for (const [meta, source] of metas) {
    if (!isPlainObject(meta)) continue;
    for (const spec of specs) {
      for (const namespace of NAMESPACES) {
        const container = namespace === null ? meta : meta[namespace];
        if (!isPlainObject(container)) continue;
        const value = cleanText(readPath(container, spec), MAX_TEXT);
        if (value) {
          return {
            value,
            source,
            path: [...(namespace === null ? [] : [namespace]), ...spec].join(".")
          };
        }
      }
    }
  }
  return null;
}

function readPath(container, spec) {
  let node = container;
  for (const key of spec) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, key)) return null;
    node = node[key];
  }
  return typeof node === "string" || typeof node === "number" ? node : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
