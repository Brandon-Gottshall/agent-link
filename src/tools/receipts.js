// src/tools/receipts.js
//
// list_agent_link_receipts: the local receipt index.

import { listReceipts } from "../shared/receipt-index.js";
import { LIMITS, RECEIPT_ACTIONS, RECEIPT_KINDS, enumOf, limit, out, str } from "../server/schemas.js";

/** @type {import("../server/registry.js").ToolDefinition} */
export const listReceiptsTool = {
  name: "list_agent_link_receipts",
  description: "List local Agent Link launch/message/archive/fork/Claude-session/reply receipts, newest first, by target address, target thread, target session, origin thread, action, receipt kind, host, target kind, or search query.",
  inputSchema: {
    type: "object",
    properties: {
      target: str("Only receipts whose target is this address (claude:<id> or codex:<id>). Receipts written before addresses existed are matched by their canonicalized target id."),
      targetThreadId: str("Only receipts whose target.threadId matches this thread. A codex:<id> address is matched as target."),
      originThreadId: str("Only receipts whose origin.threadId matches this thread."),
      action: enumOf(RECEIPT_ACTIONS, "Only receipts for this action."),
      kind: enumOf(RECEIPT_KINDS, "Only section 9 receipts of this kind: fork and reconcile (fork_codex_thread), model-switch, effort-change, cwd-change. They link original and fork both ways (original, fork, forkJobId) and record token usage."),
      targetKind: enumOf(["claude", "codex"], "Only receipts whose target.kind matches."),
      host: enumOf(["claude", "codex"], "Only receipts written by this host. Useful for auditing which side initiated a cross-host action."),
      targetSessionId: str("Only receipts for this Claude target session id (e.g. local_<uuid>). A claude:<id> address is matched as target."),
      query: str("Optional substring search across receipt id, purpose, note, tags, message preview, final response, origin, and target fields."),
      limit: limit("receipts", "receipts")
    },
    additionalProperties: false
  },
  removedArguments: [{ name: "searchTerm", replacement: "query" }],
  output: {
    path: out("string", "The receipt log new receipts are written to."),
    data: out("array", "Receipt summaries; each target carries its address (claude:<id> or codex:<id>, or null)."),
    scannedReceipts: out("integer", "Receipts read, across the current and legacy logs."),
    filters: out("object", "The filters applied.")
  },
  annotations: { readOnlyHint: true }
};

/**
 * @param {Record<string, any>} args
 */
export async function listAgentLinkReceipts(args) {
  return await listReceipts({
    target: args.target,
    targetThreadId: args.targetThreadId,
    originThreadId: args.originThreadId,
    action: args.action,
    kind: args.kind,
    targetKind: args.targetKind,
    host: args.host,
    targetSessionId: args.targetSessionId,
    searchTerm: args.query,
    limit: args.limit ?? LIMITS.receipts.def
  });
}

/** @returns {import("../server/registry.js").ToolEntry[]} */
export function receiptEntries() {
  return [{ definition: listReceiptsTool, handler: listAgentLinkReceipts }];
}
