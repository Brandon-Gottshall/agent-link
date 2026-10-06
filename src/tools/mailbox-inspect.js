import { openMailbox } from "../claude/mailbox.js";
import { resolveCallerIdentity } from "../claude/identity.js";

export const mailboxInspectTool = {
  name: "agent_link_mailbox_inspect",
  description:
    "Read-only sift over the Agent Link JSONL mailbox. Filter by from/to session, undelivered/pendingAck, replyToMessageId, since. " +
    "By default only mail sent by or addressed to the calling session is returned; pass scope='all' to inspect every session's mail.",
  inputSchema: {
    type: "object",
    properties: {
      fromSessionId: { type: "string" },
      toSessionId: { type: "string" },
      replyToMessageId: { type: "string" },
      undelivered: { type: "boolean" },
      pendingAck: { type: "boolean" },
      since: { type: "number" },
      limit: { type: "number" },
      scope: {
        type: "string",
        enum: ["caller", "all"],
        description: "'caller' (default): only mail sent by or addressed to the calling session. 'all': every session's mail."
      }
    }
  }
};

export function makeMailboxInspectHandler({ host, mailboxOpener, resolveCurrentSession = null } = {}) {
  const openMb = typeof mailboxOpener === "function" ? mailboxOpener : () => openMailbox();
  return {
    agent_link_mailbox_inspect: async (args, toolContext = {}) => {
      const { scope, ...filters } = args ?? {};
      const all = scope === "all";
      const caller = all
        ? null
        : resolveCallerIdentity({
            host,
            runtimeCallerContext: toolContext.runtimeCallerContext ?? null,
            currentSession: resolveCurrentSession
          });
      const mb = openMb();
      try {
        const messages = mb.inspect(all ? filters : { ...filters, involvingSessionIds: caller.aliases });
        return all
          ? { scope: "all", messages }
          : { scope: "caller", callerSessionId: caller.id, messages };
      } finally {
        mb.close();
      }
    }
  };
}
