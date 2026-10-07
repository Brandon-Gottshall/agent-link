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
  messageId: out("string", "Id of the message: its mailbox record and envelope id. The recipient answers it with reply_agent_link_message."),
  delivery: enumOf(["delivered", "queued"], "delivered: pushed to the thread as a turn. queued: in the mailbox only (the thread is held by the Codex desktop app, or the push failed; see warnings); the thread reads it with read_agent_link_inbox."),
  deliveredVia: out(["string", "null"], "codex-turn when the message was pushed as a turn (turn/start or turn/steer), else null."),
  deliveryState: out("object", "{state: accepted_by_app_server | queued_in_mailbox, action, turnId}."),
  target: out("object", "{threadId, address} of the target thread."),
  turn: out(["object", "null"], "The turn that carries the message: the new turn for turn/start, {id} for turn/steer; null when queued."),
  anticipation: enumOf(["reply", "action", "fyi"], "The message's anticipation label."),
  replyBy: out(["string", "null"], "The message's deadline (ISO 8601), or null."),
  messageStatus: out(["string", "null"], "pending for a reply/action message (or its status when a wait ended), null for fyi."),
  resolved: out("object", "With replyToMessageId: {messageId, kind: reply|done, late} when this send resolved the message it answers."),
  wait: out("object", "With waitForReply: {outcome: reply|declined|done|unresolved|expired|timeout, messageStatus, waitedMs, target, reply?, turn?: {turnId}} (sections 3.4, 7.6). Ends only on an explicit resolution by the thread (reply_agent_link_message), never on its turn completing; reply is the explicit reply, decline reason, or done note, enveloped. Read the turn itself with get_codex_thread."),
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
  appServer: commonOut.appServer,
  via: out("string", "role:<name> when the target was addressed by role; the message went to the role's current holder."),
  roleProcedure: out(["object", "null"], "With a role target: {name, version, textIncluded} of the role's procedure, or null when the role has none. textIncluded is true on the first delivery of that version to the holder."),
  switches: out("array", "In-place changes applied to the thread, one per setting: {setting, previous, current, grantedBy: launcher|policy|allowTargetOverride, policy?, persists: true, expectedCost: {uncachedInputTokens, basis}}. expectedCost is the last turn's input tokens (basis last-turn-input, or null with basis unknown) for a model or effort change, which re-reads the thread uncached, and 0 (basis cache-neutral) for a cwd change. A change persists; Agent Link never sends a revert."),
  switchReceipts: out("array", "Receipt write results for the model-switch, effort-change, and cwd-change receipts, one per entry in switches.")
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
        anticipation: enumOf(["reply", "action", "fyi"], "Label of the first message: reply (a reply is expected), action (do it and mark it done), or fyi (default). Needs message."),
        replyBy: str("Optional deadline for a reply or action first message, ISO 8601 with a time zone, at least 30 s ahead. Not allowed with fyi."),
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
      messageId: out("string", "With message: the first message's mailbox id (the thread answers it with reply_agent_link_message)."),
      delivery: enumOf(["delivered", "queued"], "With message: delivered when it started the first turn, queued when the push failed (see warnings)."),
      deliveredVia: out(["string", "null"], "With message: codex-turn when delivered, else null."),
      anticipation: enumOf(["reply", "action", "fyi"], "With message: its anticipation label."),
      replyBy: out(["string", "null"], "With message: its deadline (ISO 8601), or null."),
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
    description: "Send a message to a Codex thread. It is written to the Agent Link mailbox first (messageId), then pushed to the thread as a turn wrapped in the peer-message envelope: a new turn on an idle thread, or steering an active turn (delivery delivered). A thread not loaded in Agent Link's Codex app-server is treated as held by the Codex desktop app and gets the message by inbox only (delivery queued, warning codex_desktop_push_disabled); a failed push also leaves it queued. Label it with anticipation (reply, action, fyi) and replyBy; the thread resolves reply/action messages with reply_agent_link_message, and waitForReply waits for that explicit resolution, never for the turn to complete. Starting a second turn on a busy thread fails with active_turn_conflict unless allowParallelTurn is true; an existing thread keeps its cwd, model, and effort: a different value fails with permission_denied unless the thread's launcher changes effort, the target's override policy (set by the user) allows the change, or the deprecated allowTargetOverride is set (until 0.7.0); an allowed change persists. threadId also accepts role:<name>, which reaches the Codex thread holding that role.",
    inputSchema: {
      type: "object",
      required: ["threadId", "message"],
      properties: {
        threadId: str("Target Codex thread ID, codex:<id> address, or role:<name> (the Codex thread currently holding the role)."),
        message: str("Text to send to the target thread (at most 64 KiB)."),
        cwd: str("Optional absolute cwd for the target turn. It must match the thread's own cwd (compared by real path) unless the target's override policy (or the deprecated allowTargetOverride) allows you to change it; a change must stay inside the thread's workspace (git top level of its cwd, symlinks resolved) and persists."),
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
