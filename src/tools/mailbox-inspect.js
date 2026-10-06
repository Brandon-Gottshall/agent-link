import { openMailbox } from "../claude/mailbox.js";

export const mailboxInspectTool = {
  name: "agent_link_mailbox_inspect",
  description: "Read-only sift over the Agent Link JSONL mailbox. Filter by from/to session, undelivered/pendingAck, replyToMessageId, since.",
  inputSchema: {
    type: "object",
    properties: {
      fromSessionId: { type: "string" },
      toSessionId: { type: "string" },
      replyToMessageId: { type: "string" },
      undelivered: { type: "boolean" },
      pendingAck: { type: "boolean" },
      since: { type: "number" },
      limit: { type: "number" }
    }
  }
};

export function makeMailboxInspectHandler() {
  return {
    agent_link_mailbox_inspect: async (args) => {
      const mb = openMailbox();
      try { return { messages: mb.inspect(args ?? {}) }; }
      finally { mb.close(); }
    }
  };
}
