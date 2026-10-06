import { AgentLinkError } from "../shared/errors.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { rankThreadSummaries } from "./thread-utils.js";
import { cleanString, clampInt as clamp, normalizeStringList, requiredString } from "../shared/args.js";
import { assertPeerBodyWithinLimit } from "../shared/envelope.js";

export const PROJECT_ORCHESTRATOR_BINDING_PATH = path.join(".codex", "project-orchestrator.json");
const DEFAULT_POLICY_VERSION = "v0";
const ALLOWED_RETURN_STATUSES = new Set(["done", "done_with_concerns", "blocked"]);

export async function resolveProjectOrchestrator(args = {}, deps = {}) {
  const projectRoot = cleanString(args.projectRoot || args.cwd);
  const explicitThreadId = cleanString(args.orchestratorThreadId || args.threadId);
  const limit = clamp(args.limit ?? 10, 1, 50);

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
    throw new AgentLinkError("invalid_arguments", "projectRoot, query, projectId, or orchestratorThreadId is required to resolve a project orchestrator.", {
      details: {
        errors: [{ path: "projectRoot", rule: "required", expected: "projectRoot, query, projectId, or orchestratorThreadId" }],
        projectRoot: projectRoot || null,
        binding
      }
    });
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
    throw new AgentLinkError("not_found", `No project orchestrator thread matched ${JSON.stringify(query)}.`, {
      details: {
        query,
        candidates: [],
        source: listed.source ?? null,
        projectRoot: projectRoot || null,
        binding
      },
      hint: "Pass orchestratorThreadId, or add .codex/project-orchestrator.json to the project."
    });
  }

  const selection = buildSelection(candidates);
  if (selection.ambiguous) {
    throw new AgentLinkError("ambiguous", "Project orchestrator resolution is ambiguous.", {
      details: {
        query,
        selection,
        candidates: candidates.slice(0, 5)
      },
      hint: "Supply orchestratorThreadId or fix .codex/project-orchestrator.json."
    });
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

// Room left for fields that resolution fills into a composed message
// (orchestrator thread id, projectId and policyVersion of up to 128
// characters each, a project root path up to PATH_MAX). The size check runs
// before resolution, so it reserves this much (design section 2.3 step 1).
export const RESOLVED_FIELDS_RESERVE_BYTES = 2048;

export async function messageProjectOrchestrator(args = {}, deps = {}, toolContext = {}) {
  const message = requiredString(args.message, "message").trim();
  // Before any app-server request.
  assertPeerBodyWithinLimit(message);
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
  const workerRole = cleanString(args.workerRole || args.role) || "project worker";
  const task = requiredString(args.task || args.message, "task").trim();
  const supplied = [task, args.instructions ?? "", workerRole].join("");
  // Size check before any app-server request: the prompt without resolved
  // fields, plus room for them.
  assertPeerBodyWithinLimit(buildWorkerPrompt({ ...args, workerRole, task, projectRoot: "", orchestratorThreadId: "", projectId: "", policyVersion: "" }), {
    supplied,
    reserveBytes: RESOLVED_FIELDS_RESERVE_BYTES,
    what: "worker prompt"
  });
  const resolution = await resolveProjectOrchestrator(resolveArgs, deps);
  const projectRoot = cleanString(args.projectRoot || args.cwd) || resolution.projectRoot || null;
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
  assertPeerBodyWithinLimit(message, { supplied, what: "worker prompt" });
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
  const fields = {
    status,
    workerThreadId: cleanString(args.workerThreadId),
    summary: requiredString(args.summary || args.result, "summary").trim(),
    changedPaths: normalizeStringList(args.changedPaths),
    testsRun: normalizeStringList(args.testsRun),
    blockers: normalizeStringList(args.blockers),
    nextSteps: normalizeStringList(args.nextSteps),
    details: args.details ?? null,
    now: deps.now
  };
  const supplied = JSON.stringify([fields.summary, fields.changedPaths, fields.testsRun, fields.blockers, fields.nextSteps, fields.details]);
  // Size check before any app-server request: the report without resolved
  // fields, plus room for them.
  assertPeerBodyWithinLimit(buildProjectWorkResultMessage({ ...fields, projectRoot: null, projectId: null }), {
    supplied,
    reserveBytes: RESOLVED_FIELDS_RESERVE_BYTES,
    what: "work result message"
  });
  const resolution = await resolveProjectOrchestrator(args, deps);
  const message = buildProjectWorkResultMessage({
    ...fields,
    projectRoot: cleanString(args.projectRoot || args.cwd) || resolution.projectRoot || null,
    projectId: resolution.projectId
  });
  assertPeerBodyWithinLimit(message, { supplied, what: "work result message" });
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
    throw new AgentLinkError("invalid_arguments", "resultStatus must be one of done, done_with_concerns, or blocked.", {
      details: { errors: [{ path: "resultStatus", rule: "enum", expected: "one of \"done\", \"done_with_concerns\", \"blocked\"" }] }
    });
  }
  return status;
}

