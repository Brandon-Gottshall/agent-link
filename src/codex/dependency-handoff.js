import { AgentLinkError } from "../shared/errors.js";
import { forwardMessageOptions, orchestratorSendContext } from "./project-orchestrator.js";
import { assertPeerBodyWithinLimit } from "../shared/envelope.js";

const THREAD_ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Weighted phrase table for check_coordination_obligations (P3-16).
//
// Each pattern belongs to one category. A text's score is the sum, over
// categories, of the highest weight matched in that category, plus
// THREAD_ID_WEIGHT when it names a thread id other than the origin's own. An
// obligation needs score >= OBLIGATION_THRESHOLD, so no single weak signal
// ("when the DOM is ready", "waiting for the tests", "another thread from the
// pool") is enough on its own: it takes a strong phrase ("blocked on",
// "depends on another workstream", "register a callback with the owner
// thread") or a wait/readiness phrase plus a reference to another thread,
// agent, workstream, or orchestrator. The bare words "callback", "handoff",
// and "return path" are not patterns at all.
//
// Every regex is linear: no nested unbounded quantifiers; word runs are
// written as `(?:WORD\s+){0,N}` with WORD excluding whitespace, so each
// position can be consumed only one way.
export const OBLIGATION_THRESHOLD = 1;
const THREAD_ID_WEIGHT = 0.5;
const WORD = String.raw`[\w'’/#-]{1,40}`;
const ACTOR = String.raw`(?:threads?|agents?|workstreams?|orchestrators?)`;
// Concurrency and tooling senses of "thread"/"agent" that are not a peer.
const NOT_A_PEER = String.raw`(?:main|ui|worker|background|render|rendering|io|gpu|audio|daemon|user|current|same|this|calling|parent-process|pool)`;
const READY_WORD = String.raw`(?:ready|ships|shipped|lands|landed|merged|available|callable|implemented|deployed|released|published|publishes|done|complete|finished|live|exposes|exposed|delivers|delivered)`;

export const COORDINATION_PATTERNS = Object.freeze([
  // explicit-thread-reference: another thread/agent/workstream is involved.
  {
    id: "peer-actor",
    category: "explicit-thread-reference",
    weight: 0.5,
    re: new RegExp(String.raw`\b(?:another|other|separate|sibling|upstream|downstream|owner|owning|origin|peer|dependency[- ]owner)\s+(?:${WORD}\s+){0,2}?${ACTOR}\b`, "i")
  },
  {
    id: "named-actor",
    category: "explicit-thread-reference",
    weight: 0.5,
    re: new RegExp(String.raw`\b(?:the|that)\s+(?!${NOT_A_PEER}\b)[\w-]{1,30}\s+${ACTOR}\b`, "i")
  },
  {
    id: "workstream-or-orchestrator",
    category: "explicit-thread-reference",
    weight: 0.5,
    re: /\b(?:workstreams?|orchestrators?)\b/i
  },
  // readiness-wait: work resumes when something elsewhere becomes ready.
  {
    id: "when-ready",
    category: "readiness-wait",
    weight: 0.6,
    re: /\b(?:when|once|as soon as) (?:it's |it is |they're |they are )?ready\b/i
  },
  {
    id: "once-subject-ready",
    category: "readiness-wait",
    weight: 0.6,
    re: new RegExp(String.raw`\b(?:when|once|after|until|as soon as)\s+(?:${WORD}\s+){1,8}?${READY_WORD}\b`, "i")
  },
  {
    id: "not-ready-yet",
    category: "readiness-wait",
    weight: 0.6,
    re: /\b(?:not|n't|not been) (?:yet )?(?:ready|shipped|landed|merged|implemented|callable|available|deployed|released|published)(?: it)? yet\b|\bnot yet (?:ready|shipped|landed|merged|implemented|callable|available|deployed|released|published)\b|\b(?:has|have)(?:n't| not) (?:yet )?(?:shipped|landed|merged|released|published)\b/i
  },
  // blocked-on: the current work cannot finish without someone else.
  {
    id: "blocked-on",
    category: "blocked-on",
    weight: 1,
    re: /\bblocked on\b/i
  },
  {
    id: "depends-on-peer",
    category: "blocked-on",
    weight: 1,
    re: /\b(?:depends|depending|dependent|relies|relying|reliant) on (?:another|the other|an? upstream|the upstream|a sibling|the sibling|work (?:in|from))\b/i
  },
  {
    id: "cannot-until",
    category: "blocked-on",
    weight: 1,
    re: new RegExp(String.raw`\b(?:can't|can’t|cannot|can not|won't|won’t|unable to)\s+(?:${WORD}\s+){0,6}?until\s+(?:the|a|an|another|other|it|they|that|this)\b`, "i")
  },
  {
    id: "blocked-by",
    category: "blocked-on",
    weight: 0.6,
    re: /\bblocked by\b/i
  },
  {
    id: "waiting-on",
    category: "blocked-on",
    weight: 0.6,
    re: /\b(?:waiting|waits|wait) (?:on|for)\b/i
  },
  {
    id: "pending-from",
    category: "blocked-on",
    weight: 0.6,
    re: new RegExp(String.raw`\bpending\s+(?:${WORD}\s+){0,3}?from\b`, "i")
  },
  {
    id: "lands-first",
    category: "blocked-on",
    weight: 0.6,
    re: new RegExp(String.raw`\bto (?:land|ship|merge|release|publish)\s+(?:${WORD}\s+){0,4}?first\b|\bto (?:land|ship|merge|release|publish) first\b`, "i")
  },
  // will-notify: a callback or return path to this thread is being set up.
  {
    id: "register-callback",
    category: "will-notify",
    weight: 1,
    re: new RegExp(String.raw`\b(?:register(?:ed|ing|s)?|set(?:ting)? up|wire[ds]?|wiring|send(?:ing|s)?|sent|request(?:ed|ing|s)?|need(?:s|ed)?|add(?:ed|ing|s)?|open(?:ed|ing|s)?)\s+(?:a |an |the )?(?:dependency\s+)?(?:callback|handoff)\s+(?:with|to|from|for|on)\s+(?:the |this |that |another |other |an? )?(?:${WORD}\s+){0,2}?(?:${ACTOR}|owners?)\b`, "i")
  },
  {
    id: "dependency-handoff",
    category: "will-notify",
    weight: 1,
    re: /\bdependency (?:handoff|callback)s?\b/i
  },
  {
    id: "notify-this-thread",
    category: "will-notify",
    weight: 0.6,
    re: /\b(?:ping|notify|message|alert) (?:me|us|this thread|this agent|the (?:origin|caller|calling|requesting) (?:thread|agent|session))\b/i
  },
  {
    id: "report-back",
    category: "will-notify",
    weight: 0.6,
    re: /\b(?:report back|call back|get back) (?:to (?:me|us|this thread|the (?:origin|caller|calling|requesting) (?:thread|agent|session))|when|once|as soon as)\b|\breport back to (?:this|the origin) thread\b/i
  },
  {
    id: "return-path-to-origin",
    category: "will-notify",
    weight: 0.6,
    re: /\breturn path (?:to|for|back to) (?:the |this )?(?:origin|caller|calling|requesting|manager|orchestrator|owner|thread)\b/i
  },
  {
    id: "hand-off-to",
    category: "will-notify",
    weight: 0.5,
    re: /\bhand (?:this|it|that|them|the \w+) off to\b/i
  },
  // resume-after: this thread says it will pick the work back up later.
  {
    id: "will-resume",
    category: "resume-after",
    weight: 0.4,
    re: /\b(?:I'll|I’ll|I will|we'll|we’ll|we will|then I'll|then I will)\s+(?:then\s+)?(?:resume|continue|pick (?:it|this|that) (?:back )?up|integrate|wire|rebase|regenerate|finish|proceed|update|apply)\b/i
  }
]);

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
    throw new AgentLinkError("invalid_arguments", "callbackThreadId is required when caller thread context is unavailable.", {
      details: { errors: [{ path: "callbackThreadId", rule: "required", expected: "string (no caller thread context)" }] }
    });
  }
  const callbackMismatch = callerThreadId && suppliedCallbackThreadId && suppliedCallbackThreadId !== callerThreadId
    ? { supplied: suppliedCallbackThreadId, used: callerThreadId, reason: "caller context thread id takes precedence over callbackThreadId" }
    : null;

  // The message uses no resolved field, so it is composed and size-checked
  // before any app-server request (design section 2.3 step 1).
  const deadline = cleanString(args.deadline);
  const evidenceRequirements = normalizeStringList(args.evidenceRequirements);
  const context = cleanString(args.context);
  const message = buildDependencyHandoffMessage({
    dependencyName,
    readinessContract,
    callbackThreadId,
    deadline,
    evidenceRequirements,
    context,
    sourceThreadId: callerThreadId,
    callbackMismatch
  });
  assertPeerBodyWithinLimit(message, {
    supplied: [dependencyName, readinessContract, deadline, context, ...evidenceRequirements].join(""),
    what: "dependency handoff message"
  });
  const target = await resolveDependencyTarget(args, deps);
  const tags = [
    "dependency-handoff",
    `dependency:${slug(dependencyName)}`,
    `callback:${callbackThreadId}`
  ];
  // Same allowlist as the project-orchestrator wrappers. cwd/targetCwd only
  // filter target resolution and are never forwarded as a turn override.
  const messageResult = await deps.messageThread({
    ...forwardMessageOptions(args),
    threadId: target.threadId,
    message,
    receipt: mergeReceipt(args.receipt, {
      purpose: `Dependency handoff: ${dependencyName}`,
      cleanupRecommendation: "keep_as_evidence",
      tags
    })
  }, orchestratorSendContext(target.resolution, toolContext));

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
  const originThreadId = cleanString(args.originThreadId || args.threadId || toolContext.callerContext?.threadId);
  const analysis = analyzeCoordinationText(text, { originThreadId });

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
  const scope = satisfactionScope(args, analysis, originThreadId, toolContext);
  const matchingReceipts = (receipts.data ?? []).filter((receipt) => receiptSatisfiesObligation(receipt, scope));
  const status = matchingReceipts.length > 0 ? "satisfied" : "needs_handoff";

  return {
    ok: status === "satisfied",
    source: "dependency-handoff",
    action: "check_coordination_obligations",
    status,
    analysis,
    originThreadId,
    satisfaction: scope.summary,
    receipts: {
      path: receipts.path ?? null,
      scannedReceipts: receipts.scannedReceipts ?? null,
      candidateCount: receipts.data?.length ?? 0,
      matchingCount: matchingReceipts.length,
      matching: matchingReceipts
    },
    nextRequiredAction: status === "needs_handoff"
      ? (scope.summary.rule === "unscoped"
        ? "The text names no thread id and no dependencyName, turn id, or since was available to match a receipt. Pass dependencyName (or since), or call register_dependency_handoff, or report callback not wired with a specific blocker before closing."
        : "Call register_dependency_handoff or report callback not wired with a specific blocker before closing.")
      : null
  };
}

export function analyzeCoordinationText(text, options = {}) {
  const source = String(text ?? "");
  const originThreadId = cleanString(options.originThreadId).toLowerCase();
  const referencedThreadIds = [...new Set(source.match(THREAD_ID_RE)?.map((id) => id.toLowerCase()) ?? [])]
    .filter((id) => id !== originThreadId);
  const matches = [];
  const bestByCategory = new Map();
  for (const pattern of COORDINATION_PATTERNS) {
    const found = pattern.re.exec(source);
    if (!found) {
      continue;
    }
    matches.push({
      id: pattern.id,
      category: pattern.category,
      weight: pattern.weight,
      excerpt: found[0].slice(0, 120)
    });
    bestByCategory.set(pattern.category, Math.max(bestByCategory.get(pattern.category) ?? 0, pattern.weight));
  }
  if (referencedThreadIds.length > 0) {
    bestByCategory.set("explicit-thread-reference", Math.max(bestByCategory.get("explicit-thread-reference") ?? 0, THREAD_ID_WEIGHT));
  }
  const score = Math.round([...bestByCategory.values()].reduce((sum, weight) => sum + weight, 0) * 100) / 100;
  return {
    hasObligation: score >= OBLIGATION_THRESHOLD,
    score,
    threshold: OBLIGATION_THRESHOLD,
    categories: Object.fromEntries(bestByCategory),
    referencedThreadIds,
    matchedPhraseCount: matches.length,
    matchedPhrases: matches.slice(0, 10).map((match) => match.id),
    matches: matches.slice(0, 10),
    note: "Cross-thread dependency language (score >= threshold) requires a dependency-handoff receipt before passive readiness language is used in a final status."
  };
}

// Satisfaction rule (documented in the check_coordination_obligations tool
// description). A receipt counts only if it is a dependency-handoff receipt
// (tag `dependency-handoff`) recorded by the origin thread, and:
//   - when the text names thread ids: its target is one of them;
//   - otherwise: it carries `dependency:<slug(dependencyName)>`, or was sent
//     in the same origin turn (originTurnId / caller turn id), or was created
//     at or after `since`. With none of those available nothing matches.
function satisfactionScope(args, analysis, originThreadId, toolContext) {
  const dependencyName = cleanString(args.dependencyName || args.dependency);
  const dependencyTag = dependencyName ? `dependency:${slug(dependencyName)}` : null;
  const originTurnId = cleanString(args.originTurnId || toolContext.callerContext?.turnId) || null;
  const sinceText = cleanString(args.since);
  const sinceMs = sinceText ? Date.parse(sinceText) : NaN;
  if (sinceText && Number.isNaN(sinceMs)) {
    throw new AgentLinkError("invalid_arguments", `since must be an ISO-8601 timestamp, got ${JSON.stringify(sinceText).slice(0, 80)}.`, {
      details: { errors: [{ path: "since", rule: "format", expected: "ISO 8601 timestamp" }] }
    });
  }
  const byThreadIds = analysis.referencedThreadIds.length > 0;
  const rule = byThreadIds
    ? "target_in_referenced_thread_ids"
    : (dependencyTag || originTurnId || sinceText ? "dependency_tag_or_same_turn_or_since" : "unscoped");
  return {
    originThreadId: originThreadId.toLowerCase(),
    referencedThreadIds: analysis.referencedThreadIds,
    dependencyTag,
    originTurnId,
    sinceMs: sinceText ? sinceMs : null,
    rule,
    summary: {
      rule,
      requiredTag: "dependency-handoff",
      originThreadId,
      targetThreadIds: byThreadIds ? analysis.referencedThreadIds : null,
      dependencyTag: byThreadIds ? null : dependencyTag,
      originTurnId: byThreadIds ? null : originTurnId,
      since: byThreadIds || !sinceText ? null : new Date(sinceMs).toISOString()
    }
  };
}

function receiptSatisfiesObligation(receipt, scope) {
  if (!receipt?.id) {
    return false;
  }
  const tags = Array.isArray(receipt.tags) ? receipt.tags : [];
  if (!tags.includes("dependency-handoff")) {
    return false;
  }
  if (cleanString(receipt.origin?.threadId).toLowerCase() !== scope.originThreadId) {
    return false;
  }
  if (scope.rule === "target_in_referenced_thread_ids") {
    return scope.referencedThreadIds.includes(cleanString(receipt.target?.threadId).toLowerCase());
  }
  if (scope.dependencyTag && tags.includes(scope.dependencyTag)) {
    return true;
  }
  if (scope.originTurnId && cleanString(receipt.origin?.turnId) === scope.originTurnId) {
    return true;
  }
  if (scope.sinceMs !== null && Date.parse(receipt.createdAt ?? "") >= scope.sinceMs) {
    return true;
  }
  return false;
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
      throw new AgentLinkError("ambiguous", "Dependency target resolution is ambiguous; supply targetThreadId.", {
        details: { query: targetQuery, candidates: (resolution.candidates ?? []).slice(0, 5) }
      });
    }
    if (!resolution.best?.id) {
      throw new AgentLinkError("not_found", `No dependency target thread matched ${JSON.stringify(targetQuery)}.`, {
        details: { query: targetQuery, candidates: [] }
      });
    }
    return {
      kind: "thread_search",
      threadId: resolution.best.id,
      source: resolution.source,
      thread: resolution.best,
      resolution
    };
  }

  throw new AgentLinkError("invalid_arguments", "targetThreadId, targetQuery, projectRoot, projectId, or orchestratorThreadId is required.", {
    details: { errors: [{ path: "targetThreadId", rule: "required", expected: "targetThreadId, targetQuery, projectRoot, projectId, or orchestratorThreadId" }] }
  });
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
    throw new AgentLinkError("invalid_arguments", `${name} is required`, {
      details: { errors: [{ path: name, rule: "required", expected: "non-empty string" }] }
    });
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
