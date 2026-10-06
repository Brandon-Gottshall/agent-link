// src/tools/receipts.js
//
// list_agent_link_receipts: the local receipt index.

import { listReceipts } from "../shared/receipt-index.js";
import { LIMITS, RECEIPT_ACTIONS, enumOf, limit, out, str } from "../server/schemas.js";

/** @type {import("../server/registry.js").ToolDefinition} */
export const listReceiptsTool = {
  name: "list_agent_link_receipts",
  description: "List local Agent Link launch/message/archive/Claude-session/reply receipts, newest first, by target thread, target session, origin thread, action, host, target kind, or search query.",
  inputSchema: {
    type: "object",
    properties: {
      targetThreadId: str("Only receipts whose target.threadId matches this thread."),
      originThreadId: str("Only receipts whose origin.threadId matches this thread."),
      action: enumOf(RECEIPT_ACTIONS, "Only receipts for this action."),
      targetKind: enumOf(["claude", "codex"], "Only receipts whose target.kind matches."),
      host: enumOf(["claude", "codex"], "Only receipts written by this host. Useful for auditing which side initiated a cross-host action."),
      targetSessionId: str("Only receipts for this Claude target session id (e.g. local_<uuid>)."),
      query: str("Optional substring search across receipt id, purpose, note, tags, message preview, final response, origin, and target fields."),
      limit: limit("receipts", "receipts")
    },
    additionalProperties: false
  },
  aliases: [{ canonical: "query", aliases: ["searchTerm"] }],
  output: {
    path: out("string", "The receipt log new receipts are written to."),
    data: out("array", "Receipt summaries."),
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
    targetThreadId: args.targetThreadId,
    originThreadId: args.originThreadId,
    action: args.action,
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
