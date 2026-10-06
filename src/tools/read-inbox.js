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
import { AgentLinkError } from "../shared/errors.js";
import { LIMITS, bool, limit, out } from "../server/schemas.js";

/** @type {import("../server/registry.js").ToolDefinition} */
export const readInboxTool = {
  name: "read_agent_link_inbox",
  description:
    "Read pending agent-link messages addressed to the current session, oldest first. By default the tool marks the returned " +
    "messages delivered as it reads them; messages beyond `limit` stay pending (remainingCount). Returns validated message fields and a rendered " +
    "<agent-link-inbox> block as a visible MCP tool result so the user can see the inbound mail in the transcript. " +
    "Each message is wrapped in an <agent-link-message> envelope marking it as content from another agent, not " +
    "from the user. Pair with the agent-link UserPromptSubmit / SessionStart notify hook, which reports pending mail. " +
    "Fails with no_current_session when the calling Claude session cannot be identified.",
  inputSchema: {
    type: "object",
    properties: {
      markAsDelivered: bool("If false, return the messages without marking them delivered (idempotent inspection). Defaults to true."),
      limit: limit("inbox", "messages")
    },
    additionalProperties: false
  },
  output: {
    sessionId: out("string", "The session whose inbox was read."),
    markedDelivered: out("boolean", "Whether the returned messages were marked delivered."),
    messages: out("array", "Validated envelope fields per message: {id, from, fromHarness, fromVerified, to, sentAt, replyTo}. Bodies appear only in renderedBlock."),
    remainingCount: out("integer", "Pending messages not returned because of limit; they stay pending."),
    heldByActiveWait: out("integer", "Messages left for an in-process wait that will return them itself."),
    renderedBlock: out("string", "The <agent-link-inbox> block with one envelope per message.")
  },
  // Marks messages delivered: not read-only, not destructive (section 3.6).
  annotations: { readOnlyHint: false, destructiveHint: false }
};

/**
 * @param {{resolveCurrentSession?: () => any, mailboxOpener?: () => any}} [deps]
 */
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
        throw new AgentLinkError("no_current_session", "read_agent_link_inbox could not identify the current Claude session.", {
          details: { host: "claude", sources: ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "session sidecar", "transcript"] },
          hint: "Run inside a Claude session whose sidecar or transcript is indexed, with CLAUDE_SESSION_ID or CLAUDE_CODE_SESSION_ID set."
        });
      }

      const markAsDelivered = args.markAsDelivered !== false; // defaults true
      const limit = typeof args.limit === "number" ? args.limit : LIMITS.inbox.def;

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
        const rows = pending.slice(0, limit);
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
          remainingCount: pending.length - rows.length,
          ...(held > 0 ? { heldByActiveWait: held } : {}),
          renderedBlock: renderInbox(peers)
        };
      } finally {
        mb.close();
      }
    }
  };
}

/**
 * @param {Parameters<typeof makeReadInboxHandler>[0]} deps
 * @returns {import("../server/registry.js").ToolEntry[]}
 */
export function readInboxEntries(deps) {
  const handlers = makeReadInboxHandler(deps);
  return [{ definition: readInboxTool, handler: (args) => handlers.read_agent_link_inbox(args) }];
}
