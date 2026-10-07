// src/tools/fork.js
//
// fork_codex_thread (design doc section 9.3, PR B7b). Definition only; the
// handler is src/codex/fork.js.

import {
  EFFORT_VALUES,
  bool,
  commonOut,
  enumOf,
  out,
  receiptInput,
  str,
  timeoutMs
} from "../server/schemas.js";
import { COMPACT_FORK_MODES } from "../codex/fork.js";

/** @type {import("../server/registry.js").ToolDefinition} */
export const forkCodexThreadTool = {
  name: "fork_codex_thread",
  description: "Run a task on a fork of an existing Codex thread, then send the fork's final response back to the original thread as a new Agent Link message (a reconcile message with a <fork> element). Use it to run another model, effort, or cwd on a thread's context: an existing thread keeps its model and warm prompt cache, because the cache is per model and a switch re-reads the whole thread uncached. The fork takes the original's completed turns only; the original gets no turn with model, effort, or cwd and is never compacted. Exactly one reconcile message is sent for every outcome (completed, failed, interrupted), even if this server restarts; a completed fork is archived. Claude sessions cannot be forked (unsupported).",
  inputSchema: {
    type: "object",
    required: ["message"],
    properties: {
      threadId: str("The original: a codex:<id> address or Codex thread id."),
      query: str("Fuzzy search for the original when threadId is omitted; ambiguous matches fail."),
      message: str("The task for the fork (at most 64 KiB), wrapped in the peer-message envelope."),
      model: str("Model for the fork. Any caller may choose it."),
      modelProvider: str("Model provider for the fork."),
      serviceTier: str("Service tier for the fork."),
      effort: enumOf(EFFORT_VALUES, "Reasoning effort for the fork's task turn."),
      cwd: str("Absolute working directory for the fork. It must stay inside the original's workspace (git top level of its cwd, symlinks resolved); otherwise permission_denied (cwd_outside_workspace)."),
      lastTurnId: str("Fork through this completed turn of the original. Defaults to the latest completed turn."),
      compactFork: enumOf(COMPACT_FORK_MODES, "Compact the fork before the task: auto (default) when the original's last turn used more than a set fraction of the context window, always, or never. Compaction is itself a full read on the fork."),
      reconcile: {
        type: "object",
        description: "Labels of the reconcile message the original receives.",
        properties: {
          anticipation: enumOf(["fyi", "action", "reply"], "fyi (default): for information; action: the original should act on the result and mark it done; reply: the original should answer you."),
          replyBy: str("Optional deadline for action or reply, ISO 8601 with a time zone, at least 30 s ahead.")
        },
        additionalProperties: false
      },
      archiveFork: bool("Archive the fork after a completed reconcile. Defaults to true. A failed or interrupted fork is always kept."),
      waitForResult: bool("Wait for the reconcile, up to timeoutMs. On timeout status is running and the job continues. When you fork your own thread and wait, the fork's output comes back here (output) instead of as a pushed message."),
      timeoutMs: timeoutMs("Maximum wait when waitForResult is true, in milliseconds."),
      receipt: receiptInput
    },
    additionalProperties: false
  },
  output: {
    forkJobId: out("string", "The fork job id; it is also the task turn's clientUserMessageId."),
    status: enumOf(["running", "completed", "failed", "interrupted", "aborted"], "The task turn's outcome, or running."),
    original: out("object", "{address, threadId} of the original thread."),
    fork: out("object", "{threadId, address, forkedFromId, model, effort, cwd} of the fork."),
    lastTurnId: out("string", "The original's turn the fork was taken through."),
    turn: out("object", "{id} of the fork's task turn, or {id: null} if it could not start."),
    compaction: out("object", "{mode, compact, compacted, reason, threshold, inputTokens, modelContextWindow, windowBasis, tokenUsage}: the R9.11 decision."),
    reconcile: out(["object", "null"], "When finished: {messageId, delivery: queued|delivered, deliveredVia?, anticipation} of the reconcile message in the original's mailbox."),
    output: out("object", "Only when you forked your own thread and waited: the fork's output as a peer message (envelope plus header fields)."),
    tokenUsage: out("object", "When finished: {compaction?, task}: the `last` token breakdown plus modelContextWindow of each turn, or null when no notification arrived (token_usage_unavailable)."),
    archived: out("boolean", "Whether the fork was archived."),
    receipt: commonOut.receipt,
    reconcileReceipt: out("object", "The reconcile receipt write result.")
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
};

/**
 * @param {import("../server/registry.js").ToolHandler} handler
 * @returns {import("../server/registry.js").ToolEntry[]}
 */
export function forkEntries(handler) {
  return [{ definition: forkCodexThreadTool, handler }];
}
