// src/tools/orchestration.js
//
// Project-orchestrator and dependency-handoff tools:
// resolve_project_orchestrator, message_project_orchestrator,
// launch_project_worker, return_project_work_result,
// register_dependency_handoff, check_coordination_obligations.
// Definitions only; handlers are passed in.

import {
  EFFORT_VALUES,
  LIMITS,
  archiveScope,
  bool,
  commonOut,
  enumOf,
  intRange,
  limit,
  orchestratorTarget,
  out,
  receiptInput,
  str,
  stringList,
  stringOrList,
  turnOptions,
  useLocalFallback
} from "../server/schemas.js";

/** @typedef {import("../server/registry.js").ToolDefinition} ToolDefinition */
/** @typedef {import("../server/registry.js").ToolEntry} ToolEntry */
/** @typedef {import("../server/registry.js").ToolHandler} ToolHandler */

const WRITE = { readOnlyHint: false, destructiveHint: false };

const wrapperOut = {
  source: commonOut.source,
  action: out("string", "The tool that ran."),
  resolution: out("object", "How the orchestrator thread was resolved (see resolve_project_orchestrator).")
};

/** @type {ToolDefinition[]} */
export const orchestrationTools = [
  {
    name: "resolve_project_orchestrator",
    description: "Resolve a project's orchestrator: an explicit orchestratorThreadId (a thread id or role:<name>), else the Codex thread holding the orchestrator role for this projectRoot (set_agent_role with projectRoot), else the source-owned .codex/project-orchestrator.json binding, else the orchestrator role's own holder, else ranked thread search by project cwd/name/preview. The verdict is in status (resolved, ambiguous, not_found); finding nothing is not an error.",
    inputSchema: {
      type: "object",
      properties: {
        ...orchestratorTarget,
        limit: limit("resolve", "ranked fallback candidates")
      },
      additionalProperties: false
    },
    output: {
      status: enumOf(["resolved", "ambiguous", "not_found"], "Verdict."),
      source: out("string", "explicit, role (the orchestrator role, R1.21), binding, binding-unreadable-search, or search."),
      role: out("object", "With source role: {name, via, address, scope: project|role, projectRoot} of the role holder used."),
      threadId: out(["string", "null"], "The orchestrator thread, when resolved."),
      projectRoot: out(["string", "null"], "Project root."),
      projectId: out(["string", "null"], "Project id."),
      binding: out(["object", "null"], "The .codex/project-orchestrator.json binding, when read."),
      bindingVerification: out(["object", "null"], "Readability check of the bound thread."),
      verification: out(["object", "null"], "Readability check of the chosen thread."),
      query: out(["string", "null"], "The fallback search query."),
      selection: out(["object", "null"], "How the thread was chosen."),
      candidates: out("array", "Ranked candidates."),
      listSource: out(["string", "null"], "Source of the fallback thread listing."),
      appServer: commonOut.appServer,
      appServerError: commonOut.appServerError
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "message_project_orchestrator",
    description: "Resolve or target a project orchestrator thread and send it a direct app-server message (peer-message envelope) without GUI routing. cwd only filters the search; the turn keeps the orchestrator's own working directory.",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        ...orchestratorTarget,
        message: str("Message to send to the project orchestrator (at most 64 KiB)."),
        ...turnOptions,
        receipt: receiptInput
      },
      additionalProperties: false
    },
    output: {
      ...wrapperOut,
      messageResult: out("object", "The message_codex_thread result.")
    },
    annotations: WRITE
  },
  {
    name: "launch_project_worker",
    description: "Create a non-ephemeral project worker thread by default, with return-path instructions back to the resolved orchestrator and no GUI routing. name only titles the worker; it does not affect which orchestrator is resolved.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        ...orchestratorTarget,
        name: str("Name/title for the worker thread."),
        workerRole: str("Role label injected into the worker prompt."),
        role: str("Same as workerRole."),
        task: str("Worker task to inject into the new thread prompt."),
        instructions: str("Optional extra worker instructions."),
        model: str("Optional model for the worker thread."),
        modelProvider: str("Optional model provider for the worker thread."),
        serviceTier: str("Optional service tier for the worker thread."),
        effort: enumOf(EFFORT_VALUES, "Optional reasoning effort for the worker's first turn."),
        ephemeral: bool("Defaults to false so worker threads persist unless explicitly requested otherwise."),
        receipt: receiptInput
      },
      additionalProperties: false
    },
    output: {
      ...wrapperOut,
      workerPrompt: out("string", "The prompt sent to the worker (inside the peer-message envelope)."),
      launchResult: out("object", "The launch_codex_thread result.")
    },
    annotations: WRITE
  },
  {
    name: "return_project_work_result",
    description: "Send a structured worker status/result payload back to the resolved project orchestrator thread.",
    inputSchema: {
      type: "object",
      properties: {
        ...orchestratorTarget,
        threadId: str("Same as orchestratorThreadId, when resolving the orchestrator."),
        workerThreadId: str("Thread ID of the worker returning the result."),
        resultStatus: enumOf(["done", "done_with_concerns", "blocked"], "The worker's status. Required."),
        summary: str("Concise worker result summary. Required (or result)."),
        result: str("Same as summary."),
        changedPaths: stringList("Paths the worker changed."),
        testsRun: stringList("Tests or checks the worker ran."),
        blockers: stringList("What blocks the work, if anything."),
        nextSteps: stringList("Suggested next steps."),
        // Free-form by design: the worker's own structured payload.
        details: { type: "object", additionalProperties: true, description: "Optional structured details, sent as JSON." },
        ...turnOptions,
        receipt: receiptInput
      },
      required: ["resultStatus"],
      additionalProperties: false
    },
    removedArguments: [{ name: "status", replacement: "resultStatus" }],
    output: {
      ...wrapperOut,
      message: out("string", "The result message sent (inside the peer-message envelope)."),
      messageResult: out("object", "The message_codex_thread result.")
    },
    annotations: WRITE
  },
  {
    name: "register_dependency_handoff",
    description: "Send a standardized Agent Link callback request to a thread or project orchestrator that owns a dependency for the caller. The callback thread is the caller's own thread from runtime context; a different callbackThreadId is ignored and flagged.",
    inputSchema: {
      type: "object",
      required: ["dependencyName", "readinessContract"],
      properties: {
        targetThreadId: str("Exact Codex thread ID that owns the dependency."),
        targetQuery: str("Search query for the dependency-owner thread when targetThreadId is not known."),
        targetCwd: str("Optional cwd filter for targetQuery."),
        projectRoot: orchestratorTarget.projectRoot,
        projectId: orchestratorTarget.projectId,
        orchestratorThreadId: str("Explicit project orchestrator thread ID."),
        threadId: str("Same as targetThreadId when project fields are absent, or orchestratorThreadId when they are present."),
        query: str("Same as targetQuery, or the project-orchestrator fallback query."),
        cwd: str("Optional cwd filter for target resolution. Never used as the turn's working directory."),
        dependencyName: str("Short human-readable dependency name."),
        readinessContract: str("Exact condition that makes the dependency ready or blocked."),
        callbackThreadId: str("Thread to message when ready or blocked. The caller's own thread (from runtime caller context) wins when it is available; a different value here is ignored and flagged in the handoff message. Used as given only when caller context is unavailable."),
        deadline: str("Optional deadline or timebox for the dependency callback."),
        evidenceRequirements: stringOrList("Optional verification or artifact evidence the dependency owner should return."),
        context: str("Optional concise context for why this dependency matters."),
        ...turnOptions,
        archiveScope: archiveScope("all"),
        limit: limit("resolve", "target candidates"),
        useLocalFallback,
        receipt: receiptInput
      },
      additionalProperties: false
    },
    output: {
      source: commonOut.source,
      action: out("string", "register_dependency_handoff."),
      dependency: out("object", "{name, readinessContract, callbackThreadId, callbackMismatch, deadline, evidenceRequirements}."),
      target: out("object", "How the dependency owner was resolved."),
      message: out("string", "The handoff message sent."),
      messageResult: out("object", "The message_codex_thread result."),
      callbackExpectation: out("object", "What the owner must send back.")
    },
    annotations: WRITE
  },
  {
    name: "check_coordination_obligations",
    description: "Check whether text that implies a cross-thread dependency has a dependency-handoff receipt from the origin thread. The text is scored against a weighted phrase table (analysis.score vs analysis.threshold): strong phrases such as \"blocked on\" or \"register a callback with the owner thread\" count on their own; weak ones (\"when ready\", \"waiting for\", a thread id, \"another agent\") only in combination. Bare words like \"callback\" or \"handoff\" do not count. Satisfaction: only a receipt tagged dependency-handoff whose origin is the origin thread counts. If the text names thread ids (other than the origin's own), the receipt's target must be one of them. If it names none, the receipt must carry dependency:<slug of dependencyName>, or come from the same origin turn (originTurnId, defaulting to the caller's turn), or be created at or after since; with none of these supplied, nothing satisfies. The verdict is in status: not_applicable, satisfied, needs_handoff, or blocked (origin thread unknown); all are ok:true.",
    inputSchema: {
      type: "object",
      properties: {
        text: str("Current or final response text to inspect for dependency callback obligations."),
        finalText: str("Same as text."),
        currentText: str("Same as text."),
        originThreadId: str("Origin thread whose Agent Link receipts should satisfy the obligation. Defaults to caller thread context."),
        threadId: str("Same as originThreadId."),
        receiptLimit: intRange({ min: LIMITS.receiptLimit.min, max: LIMITS.receiptLimit.max, def: 20, description: "Maximum recent dependency-handoff receipts to inspect." }),
        dependencyName: str("When the text names no thread id: the dependencyName passed to register_dependency_handoff. A receipt tagged dependency:<slug> satisfies."),
        originTurnId: str("When the text names no thread id: a receipt sent from this origin turn satisfies. Defaults to the caller's turn id from runtime context."),
        since: str("When the text names no thread id: ISO-8601 timestamp; a receipt created at or after it satisfies.")
      },
      additionalProperties: false
    },
    output: {
      status: enumOf(["not_applicable", "satisfied", "needs_handoff", "blocked"], "Verdict."),
      source: commonOut.source,
      action: out("string", "check_coordination_obligations."),
      analysis: out("object", "Phrase-table scoring of the text."),
      originThreadId: out(["string", "null"], "The origin thread checked."),
      satisfaction: out("object", "The rule used to match receipts."),
      receipts: out(["object", "null"], "Receipts scanned and matched."),
      blocker: out("string", "Why the check could not run (status blocked)."),
      nextRequiredAction: out(["string", "null"], "What to do when status is needs_handoff.")
    },
    annotations: { readOnlyHint: true }
  }
];

/**
 * @param {Record<string, ToolHandler>} handlers  keyed by tool name
 * @returns {ToolEntry[]}
 */
export function orchestrationEntries(handlers) {
  return orchestrationTools.map((definition) => ({ definition, handler: handlers[definition.name] }));
}
