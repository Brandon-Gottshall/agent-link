// src/tools/read-inbox.js
//
// MCP tool that surfaces inbound agent-link messages addressed to the current
// session. The notify-hook (UserPromptSubmit / SessionStart) injects a hidden
// notification that mail is pending; this tool returns the actual messages so
// they appear in the visible Desktop transcript as a tool-call result.
//
// By default the tool marks the messages it returns delivered as it reads
// them. Set markAsDelivered:false to inspect without draining.
import { openMailbox } from "../claude/mailbox.js";
import { claudeSessionAliases } from "../claude/identity.js";
import { isHeldByActiveWait } from "../claude/active-waits.js";
import { peerMessageFromMailbox, peerMessageResult, renderInbox } from "../shared/envelope.js";

export const readInboxTool = {
  name: "read_agent_link_inbox",
  description:
    "Read pending agent-link messages addressed to the current session. By default the tool marks the returned " +
    "messages delivered as it reads them. Returns validated message fields and a rendered " +
    "<agent-link-inbox> block as a visible MCP tool result so the user can see the inbound mail in the transcript. " +
    "Each message is wrapped in an <agent-link-message> envelope marking it as content from another agent, not " +
    "from the user. Pair with the agent-link UserPromptSubmit / SessionStart notify hook, which reports pending mail.",
  inputSchema: {
    type: "object",
    properties: {
      markAsDelivered: {
        type: "boolean",
        description: "If false, return the messages without marking them delivered (idempotent inspection). Defaults to true."
      },
      limit: {
        type: "number",
        description: "Optional cap on the number of messages returned. Defaults to all pending."
      }
    },
    additionalProperties: false
  }
};

export function makeReadInboxHandler({ resolveCurrentSession, mailboxOpener } = {}) {
  if (typeof resolveCurrentSession !== "function") {
    throw new Error("makeReadInboxHandler: resolveCurrentSession must be a function");
  }
  const openMb = typeof mailboxOpener === "function"
    ? mailboxOpener
    : () => openMailbox();

  return {
    read_agent_link_inbox: async (args = {}) => {
      const session = resolveCurrentSession();
      if (!session) {
        return {
          error: "no_current_session",
          messages: [],
          renderedBlock: renderInbox([]),
          hint: "read_agent_link_inbox requires running inside a Claude session whose sidecar or transcript metadata is registered. Ensure CLAUDE_SESSION_ID or CLAUDE_CODE_SESSION_ID is set and the session is indexed."
        };
      }

      const markAsDelivered = args.markAsDelivered !== false; // defaults true
      const limit = typeof args.limit === "number" && args.limit >= 0
        ? Math.floor(args.limit)
        : null;

      // Mail may be addressed to any id form of this session (sidecar id,
      // CLI id, local_<cli>); see claudeSessionAliases().
      const toSessionIds = claudeSessionAliases(session);
      const mb = openMb();
      try {
        // A reply that an in-process wait (message_claude_session with
        // waitForReply, or wait_for_claude_session) is blocked on belongs to
        // that wait, which returns it as its tool result. Same rule as the
        // channel bridge: never drain or show it here, or it arrives twice.
        const all = mb.listPendingFor({ toSessionIds });
        const pending = all.filter((message) => !isHeldByActiveWait(message));
        // Slice before marking: with `limit`, only the returned messages are
        // marked delivered and the rest stay pending.
        const rows = pending.slice(0, limit ?? undefined);
        if (markAsDelivered) {
          for (const row of rows) mb.markDelivered({ messageId: row.id });
        }
        const peers = rows.map(peerMessageFromMailbox);
        // Structured entries carry only the validated envelope fields. The
        // body reaches the model only inside renderedBlock's envelopes; raw
        // rows (body, metadata) never leave this function.
        const messages = peers.map((peer) => peerMessageResult(peer, { includeEnvelope: false }));
        const held = all.length - pending.length;
        return {
          sessionId: session.sessionId,
          markedDelivered: markAsDelivered,
          messages,
          ...(held > 0 ? { heldByActiveWait: held } : {}),
          renderedBlock: renderInbox(peers)
        };
      } finally {
        mb.close();
      }
    }
  };
}
