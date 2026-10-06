import { promises as fs } from "node:fs";
import path from "node:path";
import { rankThreadSummaries } from "./thread-utils.js";

export const PROJECT_ORCHESTRATOR_BINDING_PATH = path.join(".codex", "project-orchestrator.json");
const DEFAULT_POLICY_VERSION = "v0";
const ALLOWED_RETURN_STATUSES = new Set(["done", "done_with_concerns", "blocked"]);

export async function resolveProjectOrchestrator(args = {}, deps = {}) {
  const projectRoot = cleanString(args.projectRoot || args.cwd);
  const explicitThreadId = cleanString(args.orchestratorThreadId || args.threadId);
  const limit = clamp(args.limit ?? 5, 1, 20);

  if (explicitThreadId) {
    const verification = await verifyThreadReadable(explicitThreadId, deps);
    return {
      ok: true,
      source: "explicit",
      threadId: explicitThreadId,
      projectRoot: projectRoot || null,
      projectId: cleanString(args.projectId) || null,
      binding: null,
      verification,
      selection: {
        bestId: explicitThreadId,
        ambiguous: false,
        strategy: "explicit orchestrator thread id"
      },
      candidates: []
    };
  }

  const binding = projectRoot ? await readProjectOrchestratorBinding(projectRoot) : null;
  const bindingVerification = binding ? await verifyThreadReadable(binding.orchestratorThreadId, deps) : null;
  if (binding) {
    const verification = bindingVerification;
    if (verification.readable) {
      return {
        ok: true,
        source: "binding",
        threadId: binding.orchestratorThreadId,
        projectRoot: binding.projectRoot,
        projectId: binding.projectId,
        binding,
        verification,
        selection: {
          bestId: binding.orchestratorThreadId,
          ambiguous: false,
          strategy: "source-owned .codex/project-orchestrator.json binding"
        },
        candidates: verification.thread ? [verification.thread] : []
      };
    }
  }

  const query = buildFallbackQuery({ ...args, projectRoot, binding });
  if (!query) {
    const error = new Error("projectRoot, query, projectId, or orchestratorThreadId is required to resolve a project orchestrator");
    error.details = { projectRoot: projectRoot || null, binding };
    throw error;
  }

  const listed = await deps.listThreads({
    archiveScope: args.archiveScope ?? "all",
    limit: 100,
    searchTerm: query,
    cwd: cleanString(args.cwd) || projectRoot || null,
    useLocalFallback: args.useLocalFallback
  });
  const candidates = rankThreadSummaries(listed.data ?? [], query, limit);
  if (candidates.length === 0) {
    const error = new Error(`No project orchestrator thread matched ${JSON.stringify(query)}`);
    error.details = {
      source: listed.source ?? null,
      query,
      projectRoot: projectRoot || null,
      binding
    };
    throw error;
  }

  const selection = buildSelection(candidates);
  if (selection.ambiguous) {
    const error = new Error("Project orchestrator resolution is ambiguous; supply orchestratorThreadId or fix .codex/project-orchestrator.json");
    error.details = {
      query,
      selection,
      candidates
    };
    throw error;
  }

  const best = candidates[0];
  const verification = await verifyThreadReadable(best.id, deps);
  return {
    ok: true,
    source: binding ? "binding-unreadable-search" : "search",
    threadId: best.id,
    projectRoot: projectRoot || best.cwd || null,
    projectId: cleanString(args.projectId) || binding?.projectId || null,
    binding,
    bindingVerification,
    verification,
    query,
    selection,
    candidates,
    listSource: listed.source ?? null,
    appServer: listed.appServer ?? null,
    appServerError: listed.appServerError ?? null
  };
}

export async function messageProjectOrchestrator(args = {}, deps = {}, toolContext = {}) {
  const message = requiredString(args.message, "message").trim();
  const resolution = await resolveProjectOrchestrator(args, deps);
  const result = await deps.messageThread({
    ...forwardMessageOptions(args),
    threadId: resolution.threadId,
    message,
    receipt: args.receipt ?? defaultReceipt("project_orchestrator_message", resolution)
  }, toolContext);
  return {
    ok: result.ok !== false,
    source: "project-orchestrator",
    action: "message_project_orchestrator",
    resolution,
    messageResult: result
  };
}

export async function launchProjectWorker(args = {}, deps = {}, toolContext = {}) {
  // `name` titles the new worker thread; it must not steer which orchestrator
  // is resolved.
  const { name: _workerName, ...resolveArgs } = args;
  const resolution = await resolveProjectOrchestrator(resolveArgs, deps);
  const projectRoot = cleanString(args.projectRoot || args.cwd) || resolution.projectRoot || null;
  const workerRole = cleanString(args.workerRole || args.role) || "project worker";
  const task = requiredString(args.task || args.message, "task").trim();
  const name = cleanString(args.name) || `Project worker: ${workerRole}`;
  const message = buildWorkerPrompt({
    ...args,
    projectRoot,
    workerRole,
    task,
    orchestratorThreadId: resolution.threadId,
    projectId: resolution.projectId,
    policyVersion: resolution.binding?.policyVersion
  });
  const result = await deps.launchThread({
    ...forwardLaunchOptions(args),
    name,
    cwd: projectRoot ?? undefined,
    message,
    ephemeral: args.ephemeral === true,
    openInGui: false,
    receipt: args.receipt ?? defaultReceipt("project_worker_launch", resolution)
  }, toolContext);
  return {
    ok: result.ok !== false,
    source: "project-orchestrator",
    action: "launch_project_worker",
    resolution,
    workerPrompt: message,
    launchResult: result
  };
}

export async function returnProjectWorkResult(args = {}, deps = {}, toolContext = {}) {
  const status = normalizeReturnStatus(args.status);
  const resolution = await resolveProjectOrchestrator(args, deps);
  const message = buildProjectWorkResultMessage({
    status,
    workerThreadId: cleanString(args.workerThreadId),
    summary: requiredString(args.summary || args.result, "summary").trim(),
    changedPaths: normalizeStringList(args.changedPaths),
    testsRun: normalizeStringList(args.testsRun),
    blockers: normalizeStringList(args.blockers),
    nextSteps: normalizeStringList(args.nextSteps),
    details: args.details ?? null,
    projectRoot: cleanString(args.projectRoot || args.cwd) || resolution.projectRoot || null,
    projectId: resolution.projectId,
    now: deps.now
  });
  const result = await deps.messageThread({
    ...forwardMessageOptions(args),
    threadId: resolution.threadId,
    message,
    receipt: args.receipt ?? defaultReceipt("project_work_result", resolution)
  }, toolContext);
  return {
    ok: result.ok !== false,
    source: "project-orchestrator",
    action: "return_project_work_result",
    resolution,
    message,
    messageResult: result
  };
}

export async function readProjectOrchestratorBinding(projectRoot) {
  const bindingPath = path.join(requiredString(projectRoot, "projectRoot"), PROJECT_ORCHESTRATOR_BINDING_PATH);
  let raw;
  try {
    raw = await fs.readFile(bindingPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const corrupt = new Error(`Project-orchestrator binding is corrupt: ${bindingPath}`);
    corrupt.details = { bindingPath, error: error.message };
    throw corrupt;
  }

  return validateBinding(parsed, { bindingPath, requestedProjectRoot: projectRoot });
}

// Caller- or binding-supplied identifiers are rendered as one inert line in
// the worker prompt: no newlines or control characters (which could start new
// prompt sections), no backticks, bounded length. Values like owner/repo stay
// readable.
export function promptSafeIdentifier(value, fallback) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 128);
  return text || fallback;
}

export function buildWorkerPrompt(args = {}) {
  const lines = [
    `You are ${args.workerRole || "a project worker"} for project ${promptSafeIdentifier(args.projectId, "unknown-project")}.`,
    "",
    "Return path:",
    `- Orchestrator thread ID: ${args.orchestratorThreadId}`,
    "- When your work is complete or blocked, call Agent Link `return_project_work_result` with your status, summary, changed paths, tests run, blockers, and next steps.",
    "- Do not route or open Codex Desktop GUI as part of this handoff.",
    "",
    "Project context:",
    `- Project root: ${args.projectRoot || "not supplied"}`,
    `- Policy version: ${promptSafeIdentifier(args.policyVersion, DEFAULT_POLICY_VERSION)}`,
    "",
    "Task:",
    args.task
  ];
  if (args.instructions) {
    lines.push("", "Additional instructions:", String(args.instructions).trim());
  }
  return lines.join("\n");
}

export function buildProjectWorkResultMessage(args = {}) {
  const payload = {
    status: args.status,
    workerThreadId: args.workerThreadId || null,
    projectId: args.projectId || null,
    projectRoot: args.projectRoot || null,
    summary: args.summary,
    changedPaths: args.changedPaths,
    testsRun: args.testsRun,
    blockers: args.blockers,
    nextSteps: args.nextSteps,
    details: args.details,
    returnedAt: typeof args.now === "function" ? args.now() : new Date().toISOString()
  };
  return `Project worker result\n\n${JSON.stringify(payload, null, 2)}`;
}

function validateBinding(value, { bindingPath, requestedProjectRoot }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throwBindingError("Binding must be a JSON object", { bindingPath });
  }
  const required = [
    "projectRoot",
    "projectId",
    "orchestratorThreadId",
    "role",
    "policyVersion",
    "createdAt",
    "lastVerifiedAt"
  ];
  for (const field of required) {
    if (!cleanString(value[field])) {
      throwBindingError(`Binding field ${field} is required`, { bindingPath, field });
    }
  }
  const resolvedBindingRoot = path.resolve(value.projectRoot);
  const resolvedRequestedRoot = path.resolve(requestedProjectRoot);
  if (resolvedBindingRoot !== resolvedRequestedRoot) {
    throwBindingError("Binding projectRoot does not match the source root that contains it", {
      bindingPath,
      projectRoot: value.projectRoot,
      requestedProjectRoot
    });
  }
  for (const field of ["createdAt", "lastVerifiedAt"]) {
    if (!Number.isFinite(Date.parse(value[field]))) {
      throwBindingError(`Binding field ${field} must be an ISO timestamp`, { bindingPath, field });
    }
  }
  if (value.role !== "project_orchestrator") {
    throwBindingError("Binding field role must be project_orchestrator", {
      bindingPath,
      role: value.role
    });
  }
  return {
    projectRoot: value.projectRoot,
    projectId: value.projectId,
    orchestratorThreadId: value.orchestratorThreadId,
    role: value.role,
    policyVersion: value.policyVersion,
    createdAt: value.createdAt,
    lastVerifiedAt: value.lastVerifiedAt,
    path: bindingPath
  };
}

function throwBindingError(message, details) {
  const error = new Error(`Project-orchestrator binding is corrupt: ${message}`);
  error.details = details;
  throw error;
}

async function verifyThreadReadable(threadId, deps) {
  if (typeof deps.readThread !== "function") {
    return {
      checked: false,
      readable: null,
      threadId,
      reason: "No readThread dependency was supplied."
    };
  }
  try {
    const result = await deps.readThread(threadId);
    return {
      checked: true,
      readable: true,
      threadId,
      thread: result.thread ?? result,
      source: result.source ?? null
    };
  } catch (error) {
    return {
      checked: true,
      readable: false,
      threadId,
      error: error.message,
      details: error.details ?? null
    };
  }
}

function buildFallbackQuery(args) {
  const explicitQuery = cleanString(args.query || args.projectName);
  if (explicitQuery) {
    return explicitQuery;
  }
  if (args.binding?.projectId) {
    return `Project Orchestrator ${args.binding.projectId}`;
  }
  const projectId = cleanString(args.projectId);
  if (projectId) {
    return `Project Orchestrator ${projectId}`;
  }
  if (args.projectRoot) {
    return `${path.basename(args.projectRoot)} Project Orchestrator`;
  }
  return "";
}

function buildSelection(candidates) {
  const topScore = candidates[0]?.match?.score ?? 0;
  const tied = candidates.filter((candidate) => candidate.match?.score === topScore);
  return {
    bestId: candidates[0]?.id ?? null,
    topScore,
    strategy: "highest match score; ties are ambiguous",
    ambiguous: tied.length > 1,
    tiedCandidateCount: tied.length,
    tiedCandidateIds: tied.map((candidate) => candidate.id)
  };
}

// Options the wrapper tools (message_project_orchestrator,
// return_project_work_result, register_dependency_handoff) pass through to
// message_codex_thread. cwd is deliberately absent: on these tools it filters
// the orchestrator or dependency-owner search; it is never the target turn's
// working directory (W2B-03).
export const FORWARDED_MESSAGE_OPTION_KEYS = Object.freeze([
  "mode",
  "resumeIfNeeded",
  "expectedTurnId",
  "model",
  "effort",
  "allowParallelTurn",
  "allowTargetOverride",
  "waitForReply",
  "timeoutMs",
  "pollIntervalMs",
  "recentItems"
]);

export function forwardMessageOptions(args) {
  const out = {};
  for (const key of FORWARDED_MESSAGE_OPTION_KEYS) {
    if (args[key] !== undefined) {
      out[key] = args[key];
    }
  }
  return out;
}

function forwardLaunchOptions(args) {
  const out = {};
  for (const key of ["model", "modelProvider", "serviceTier", "effort"]) {
    if (args[key] !== undefined) {
      out[key] = args[key];
    }
  }
  return out;
}

function defaultReceipt(purpose, resolution) {
  return {
    purpose,
    cleanupRecommendation: "review_before_archive",
    tags: ["project-orchestrator", resolution.projectId].filter(Boolean)
  };
}

function normalizeReturnStatus(value) {
  const status = cleanString(value).toLowerCase();
  if (!ALLOWED_RETURN_STATUSES.has(status)) {
    throw new Error("status must be one of done, done_with_concerns, or blocked");
  }
  return status;
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

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(n)));
}
