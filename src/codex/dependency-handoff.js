const THREAD_ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const DEPENDENCY_PHRASES = [
  /\bwhen (?:it|that|this|the .{0,40}) (?:is )?(?:ready|shipped|implemented|callable|available|done|complete|lands?)\b/i,
  /\bif (?:it|that|this|the .{0,40}) (?:is )?(?:ready|shipped|implemented|callable|available|done|complete|lands?)\b/i,
  /\bblocked on\b/i,
  /\bdepends on\b/i,
  /\bwaiting on\b/i,
  /\bnot (?:ready|shipped|implemented|callable|available) yet\b/i,
  /\banother (?:thread|agent|workstream)\b/i,
  /\bowner thread\b/i,
  /\bcallback\b/i,
  /\breturn path\b/i,
  /\bhandoff\b/i
];

export async function registerDependencyHandoff(args = {}, deps = {}, toolContext = {}) {
  const dependencyName = requiredString(args.dependencyName || args.dependency, "dependencyName").trim();
  const readinessContract = requiredString(args.readinessContract, "readinessContract").trim();
  // The caller's own thread, as seen by the runtime, is the callback target.
  // A different caller-supplied callbackThreadId cannot redirect the
  // dependency owner's reply to some other thread; it is recorded as a
  // mismatch instead.
  const callerThreadId = cleanString(toolContext.callerContext?.threadId);
  const suppliedCallbackThreadId = cleanString(args.callbackThreadId || args.originThreadId);
  const callbackThreadId = callerThreadId || suppliedCallbackThreadId;
  if (!callbackThreadId) {
    const error = new Error("callbackThreadId is required when caller thread context is unavailable");
    error.details = { callerContext: toolContext.callerContext ?? null };
    throw error;
  }
  const callbackMismatch = callerThreadId && suppliedCallbackThreadId && suppliedCallbackThreadId !== callerThreadId
    ? { supplied: suppliedCallbackThreadId, used: callerThreadId, reason: "caller context thread id takes precedence over callbackThreadId" }
    : null;

  const target = await resolveDependencyTarget(args, deps);
  const message = buildDependencyHandoffMessage({
    dependencyName,
    readinessContract,
    callbackThreadId,
    deadline: cleanString(args.deadline),
    evidenceRequirements: normalizeStringList(args.evidenceRequirements),
    context: cleanString(args.context),
    sourceThreadId: callerThreadId,
    callbackMismatch
  });
  const tags = [
    "dependency-handoff",
    `dependency:${slug(dependencyName)}`,
    `callback:${callbackThreadId}`
  ];
  const messageResult = await deps.messageThread({
    threadId: target.threadId,
    message,
    mode: args.mode,
    resumeIfNeeded: args.resumeIfNeeded,
    expectedTurnId: args.expectedTurnId,
    model: args.model,
    effort: args.effort,
    allowParallelTurn: args.allowParallelTurn,
    allowTargetOverride: args.allowTargetOverride,
    waitForReply: args.waitForReply,
    timeoutMs: args.timeoutMs,
    pollIntervalMs: args.pollIntervalMs,
    recentItems: args.recentItems,
    receipt: mergeReceipt(args.receipt, {
      purpose: `Dependency handoff: ${dependencyName}`,
      cleanupRecommendation: "keep_as_evidence",
      tags
    })
  }, toolContext);

  return {
    ok: messageResult.ok !== false,
    source: "dependency-handoff",
    action: "register_dependency_handoff",
    dependency: {
      name: dependencyName,
      readinessContract,
      callbackThreadId,
      callbackMismatch,
      deadline: cleanString(args.deadline) || null,
      evidenceRequirements: normalizeStringList(args.evidenceRequirements)
    },
    target,
    message,
    messageResult,
    callbackExpectation: {
      threadId: callbackThreadId,
      requiredStatusValues: ["ready", "blocked"],
      requiredPayload: [
        "readiness status",
        "exact command/API/spec fields needed by the origin",
        "suppression or safety requirements when relevant",
        "verification evidence or blocker"
      ]
    }
  };
}

export async function checkCoordinationObligations(args = {}, deps = {}, toolContext = {}) {
  const text = requiredString(args.text || args.finalText || args.currentText, "text");
  const analysis = analyzeCoordinationText(text);
  const originThreadId = cleanString(args.originThreadId || args.threadId || toolContext.callerContext?.threadId);

  if (!analysis.hasObligation) {
    return {
      ok: true,
      source: "dependency-handoff",
      action: "check_coordination_obligations",
      status: "not_applicable",
      analysis,
      originThreadId: originThreadId || null,
      receipts: null
    };
  }

  if (!originThreadId) {
    return {
      ok: false,
      source: "dependency-handoff",
      action: "check_coordination_obligations",
      status: "blocked",
      blocker: "caller thread context is unavailable and originThreadId was not supplied",
      analysis,
      originThreadId: null,
      receipts: null
    };
  }

  const receipts = await deps.listReceipts({
    originThreadId,
    action: "message_thread",
    searchTerm: "dependency-handoff",
    limit: args.receiptLimit ?? 20
  });
  const matchingReceipts = (receipts.data ?? []).filter((receipt) => receiptSatisfiesAnalysis(receipt, analysis));
  const status = matchingReceipts.length > 0 ? "satisfied" : "needs_handoff";

  return {
    ok: status === "satisfied",
    source: "dependency-handoff",
    action: "check_coordination_obligations",
    status,
    analysis,
    originThreadId,
    receipts: {
      path: receipts.path ?? null,
      scannedReceipts: receipts.scannedReceipts ?? null,
      candidateCount: receipts.data?.length ?? 0,
      matchingCount: matchingReceipts.length,
      matching: matchingReceipts
    },
    nextRequiredAction: status === "needs_handoff"
      ? "Call register_dependency_handoff or report callback not wired with a specific blocker before closing."
      : null
  };
}

export function analyzeCoordinationText(text) {
  const source = String(text ?? "");
  const referencedThreadIds = [...new Set(source.match(THREAD_ID_RE)?.map((id) => id.toLowerCase()) ?? [])];
  const matchedPhrases = DEPENDENCY_PHRASES
    .filter((pattern) => pattern.test(source))
    .map((pattern) => pattern.source);
  return {
    hasObligation: matchedPhrases.length > 0 || referencedThreadIds.length > 0,
    referencedThreadIds,
    matchedPhraseCount: matchedPhrases.length,
    matchedPhrases: matchedPhrases.slice(0, 10),
    note: "Dependency language or referenced thread ids require a dependency-handoff receipt before passive readiness language is used in a final status."
  };
}

function receiptSatisfiesAnalysis(receipt, analysis) {
  if (!receipt?.id) {
    return false;
  }
  if (analysis.referencedThreadIds.length === 0) {
    return true;
  }
  const targetThreadId = cleanString(receipt.target?.threadId).toLowerCase();
  const text = [
    receipt.messagePreview,
    receipt.finalResponse,
    receipt.purpose,
    receipt.target?.name
  ].filter(Boolean).join("\n").toLowerCase();
  return analysis.referencedThreadIds.some((id) => targetThreadId === id || text.includes(id));
}

async function resolveDependencyTarget(args, deps) {
  const directThreadId = cleanString(args.targetThreadId || (
    hasProjectResolutionArgs(args) ? "" : args.threadId
  ));
  if (directThreadId) {
    const read = await deps.readThread(directThreadId);
    return {
      kind: "thread",
      threadId: directThreadId,
      source: read.source ?? null,
      thread: read.thread ?? null,
      resolution: null
    };
  }

  if (hasProjectResolutionArgs(args)) {
    const resolution = await deps.resolveProjectOrchestrator({
      projectRoot: args.projectRoot,
      projectId: args.projectId,
      orchestratorThreadId: args.orchestratorThreadId,
      threadId: args.orchestratorThreadId || args.threadId,
      query: args.projectQuery || args.query,
      cwd: args.cwd,
      limit: args.limit,
      archiveScope: args.archiveScope,
      useLocalFallback: args.useLocalFallback
    });
    return {
      kind: "project_orchestrator",
      threadId: resolution.threadId,
      source: resolution.source,
      thread: resolution.verification?.thread ?? null,
      resolution
    };
  }

  const targetQuery = cleanString(args.targetQuery || args.query);
  if (targetQuery) {
    const resolution = await deps.resolveThread({
      query: targetQuery,
      cwd: args.targetCwd || args.cwd,
      limit: args.limit,
      archiveScope: args.archiveScope,
      useLocalFallback: args.useLocalFallback
    });
    if (resolution.selection?.ambiguous) {
      const error = new Error("Dependency target resolution is ambiguous; supply targetThreadId.");
      error.details = { resolution };
      throw error;
    }
    if (!resolution.best?.id) {
      const error = new Error(`No dependency target thread matched ${JSON.stringify(targetQuery)}`);
      error.details = { resolution };
      throw error;
    }
    return {
      kind: "thread_search",
      threadId: resolution.best.id,
      source: resolution.source,
      thread: resolution.best,
      resolution
    };
  }

  throw new Error("targetThreadId, targetQuery, projectRoot, projectId, or orchestratorThreadId is required");
}

function buildDependencyHandoffMessage(args) {
  const lines = [
    `Dependency callback request from thread \`${args.callbackThreadId}\`.`,
    "",
    `Dependency: ${args.dependencyName}`,
    "",
    "Readiness contract:",
    args.readinessContract,
    "",
    "When this dependency is ready or blocked, use Agent Link to message the callback thread with:",
    "- readiness status: `ready` or `blocked`",
    "- exact command/API/spec fields the origin should use",
    "- safety, suppression, or compatibility requirements the origin must honor",
    "- verification evidence, artifact paths, or the remaining blocker",
    "",
    "Do not broaden or take over the origin task. This is a dependency callback handoff."
  ];
  if (args.deadline) {
    lines.splice(4, 0, `Deadline: ${args.deadline}`, "");
  }
  if (args.evidenceRequirements.length > 0) {
    lines.push("", "Evidence requirements:", ...args.evidenceRequirements.map((item) => `- ${item}`));
  }
  if (args.context) {
    lines.push("", "Context:", args.context);
  }
  if (args.callbackMismatch) {
    lines.push("", `Note: the request named callback thread \`${args.callbackMismatch.supplied}\`, but the caller's runtime context is thread \`${args.callbackMismatch.used}\`; reply to \`${args.callbackMismatch.used}\` only.`);
  } else if (args.sourceThreadId && args.sourceThreadId !== args.callbackThreadId) {
    lines.push("", `Source thread observed by caller context: \`${args.sourceThreadId}\`.`);
  }
  return lines.join("\n");
}

function hasProjectResolutionArgs(args) {
  return Boolean(cleanString(args.projectRoot || args.projectId || args.orchestratorThreadId));
}

function mergeReceipt(receipt, defaults) {
  const input = isPlainObject(receipt) ? receipt : {};
  return {
    ...input,
    purpose: cleanString(input.purpose) || defaults.purpose,
    cleanupRecommendation: cleanString(input.cleanupRecommendation) || defaults.cleanupRecommendation,
    tags: [...new Set([...(Array.isArray(input.tags) ? input.tags : []), ...defaults.tags].filter(Boolean))]
  };
}

function normalizeStringList(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean);
  }
  const text = cleanString(value);
  return text ? [text] : [];
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function slug(value) {
  const out = cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return out || "dependency";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
