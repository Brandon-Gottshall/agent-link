// src/tools/codex-actions.js
//
// Codex thread actions: launch_codex_thread, archive_codex_thread,
// message_codex_thread. Definitions only; handlers are passed in.

import {
  EFFORT_VALUES,
  bool,
  commonOut,
  enumOf,
  out,
  outAny,
  receiptInput,
  str,
  turnOptions
} from "../server/schemas.js";

/** @typedef {import("../server/registry.js").ToolDefinition} ToolDefinition */
/** @typedef {import("../server/registry.js").ToolEntry} ToolEntry */
/** @typedef {import("../server/registry.js").ToolHandler} ToolHandler */

const WRITE = { readOnlyHint: false, destructiveHint: false };

/**
 * Output keys of message_codex_thread; the project-orchestrator and
 * dependency-handoff wrappers nest this object as messageResult.
 */
export const messageThreadOut = {
  messageId: out("string", "Id of the message sent (the envelope id)."),
  delivery: out("object", "Delivery state: {state, action, turnId, ...}."),
  deliveredVia: enumOf(["turn/start", "turn/steer"], "The app-server request that carried the message."),
  target: out("object", "{threadId} of the target thread."),
  turn: out("object", "The turn that carries the message: the new turn for turn/start, {id} for turn/steer."),
  wait: out("object", "With waitForReply: {outcome: turn_completed|timeout|unavailable, waitedMs, target, turn?, reply?, recentItems?, recentItemsEnvelope?, error?} (section 3.4)."),
  receipt: commonOut.receipt,
  source: commonOut.source,
  action: out("string", "What was done, e.g. started_turn, resumed+started_turn, steered_active_turn."),
  previousStatus: outAny("The thread status before sending."),
  threadId: out("string", "Target thread id."),
  turnId: out("string", "Turn id (turn/steer)."),
  peerMessage: commonOut.peerMessage,
  runtimeState: out("object", "Runtime state contract for the target."),
  archiveState: out("object", "Archive state contract for the target."),
  desktopVisibility: out("object", "Whether Codex Desktop shows the change."),
  replyConfirmation: out("object", "Deprecated duplicate of wait in the 0.4 shape; removed in 0.6.0."),
  appServer: commonOut.appServer
};

/** @type {ToolDefinition[]} */
export const codexActionTools = [
  {
    name: "launch_codex_thread",
    description: "Create a new Codex thread through the app-server, optionally send an initial message (wrapped in the peer-message envelope), and optionally route Codex Desktop to that exact thread.",
    inputSchema: {
      type: "object",
      properties: {
        message: str("Optional first message to send after creating the thread (at most 64 KiB). Omit to create an empty thread."),
        name: str("Optional name/title for the new thread. Empty non-ephemeral threads are named to make them durable without opening the GUI."),
        cwd: str("Optional working directory for the new thread."),
        model: str("Optional model for the new thread."),
        modelProvider: str("Optional model provider for the new thread."),
        serviceTier: str("Optional service tier for the new thread."),
        effort: enumOf(EFFORT_VALUES, "Optional reasoning effort for the initial turn when message is supplied."),
        ephemeral: bool("When true, create the thread as ephemeral if supported by the app-server. Ephemeral threads may not support includeTurns-based reply confirmation."),
        openInGui: bool("Route Codex Desktop to the created thread via codex://threads/<id>. Defaults to false to avoid stealing focus or changing the active GUI thread."),
        receipt: receiptInput
      },
      additionalProperties: false
    },
    output: {
      source: commonOut.source,
      action: out("string", "started_thread, plus +named_thread and +started_turn when they happened."),
      thread: out("object", "Summary of the new thread."),
      nameUpdate: out(["object", "null"], "The name set on the thread, and why."),
      turn: out(["object", "null"], "The first turn, when message was supplied."),
      peerMessage: commonOut.peerMessage,
      gui: out("object", "{opened, attempted, deepLink, warnings, ...}: whether Codex Desktop was routed to the thread."),
      appServer: commonOut.appServer,
      receipt: commonOut.receipt
    },
    annotations: WRITE
  },
  {
    name: "archive_codex_thread",
    description: "Archive a Codex thread through the app-server when available, falling back to a guarded local sessions move. status is archived or already_archived. The app-server archive works on loaded threads too; only the local fallback refuses a thread the app-server reports as loaded (active_turn_conflict) unless forceLoaded is true.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: str("Codex thread ID to archive. Defaults to the current caller thread when Codex supplies runtime context."),
        reason: str("Short human-readable cleanup reason."),
        forceLoaded: bool("Allow the local JSONL fallback even if the app-server reports the thread as currently loaded. Native app-server archive does not require this. Defaults to false."),
        useLocalFallback: bool("Allow local JSONL archive when the app-server loaded-state check is unavailable. Defaults to true."),
        receipt: receiptInput
      },
      additionalProperties: false
    },
    output: {
      status: enumOf(["archived", "already_archived"], "Verdict."),
      source: commonOut.source,
      action: out("string", "app_server_archive, local_archive_moved, or already_archived."),
      threadId: out("string", "The archived thread."),
      reason: out(["string", "null"], "The reason given."),
      loadedCheck: out("object", "The loaded-thread guard result."),
      archive: out("object", "What moved where."),
      stateSemantics: commonOut.stateSemantics,
      appServer: commonOut.appServer,
      receipt: commonOut.receipt
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  {
    name: "message_codex_thread",
    description: "Send a direct text message to a Codex thread, wrapped in the peer-message envelope. Resumes not-loaded threads through the app-server before starting a new turn when needed, or steers an active turn. Starting a second turn on a busy thread fails with active_turn_conflict unless allowParallelTurn is true; changing the thread's cwd/model/effort fails with permission_denied unless allowTargetOverride is true.",
    inputSchema: {
      type: "object",
      required: ["threadId", "message"],
      properties: {
        threadId: str("Target Codex thread ID."),
        message: str("Text to send to the target thread (at most 64 KiB)."),
        cwd: str("Optional cwd for the target turn. Without allowTargetOverride it must match the thread's own cwd (compared by real path); a different cwd is rejected."),
        ...turnOptions,
        receipt: receiptInput
      },
      additionalProperties: false
    },
    output: messageThreadOut,
    annotations: WRITE
  }
];

/**
 * @param {Record<string, ToolHandler>} handlers  keyed by tool name
 * @returns {ToolEntry[]}
 */
export function codexActionEntries(handlers) {
  return codexActionTools.map((definition) => ({ definition, handler: handlers[definition.name] }));
}
