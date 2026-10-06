// src/tools/read-inbox.js
//
// MCP tool that surfaces inbound agent-link messages addressed to the current
// session. The notify-hook (UserPromptSubmit / SessionStart) injects a hidden
// notification that mail is pending; this tool returns the actual messages so
// they appear in the visible Desktop transcript as a tool-call result.
//
// By default the tool drains pending messages (marks them delivered) in the
// same transaction. Set markAsDelivered:false to inspect without draining.
import { openMailbox } from "../claude/mailbox.js";

export const readInboxTool = {
  name: "read_agent_link_inbox",
  description:
    "Read pending agent-link messages addressed to the current session. By default the tool drains the pending " +
    "messages (marks them delivered) in the same transaction. Returns the messages and a rendered " +
    "<agent-link-inbox> block as a visible MCP tool result so the user can see the inbound mail in the transcript. " +
    "Pair with the agent-link UserPromptSubmit / SessionStart notify hook: when the model is told mail is pending " +
    "it should call this tool first, then answer the user.",
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

      const mb = openMb();
      try {
        const messages = markAsDelivered
          ? mb.drainFor({ toSessionId: session.sessionId })
          : mb.listPendingFor({ toSessionId: session.sessionId });
        const sliced = limit !== null ? messages.slice(0, limit) : messages;
        return {
          sessionId: session.sessionId,
          markedDelivered: markAsDelivered,
          messages: sliced,
          renderedBlock: renderInbox(sliced)
        };
      } finally {
        mb.close();
      }
    }
  };
}

function renderInbox(messages) {
  if (!messages.length) {
    return `<agent-link-inbox count="0"/>`;
  }
  const lines = [`<agent-link-inbox count="${messages.length}">`];
  for (const m of messages) {
    const replyAttr = m.reply_to_message_id ? ` replyTo="${m.reply_to_message_id}"` : "";
    const sentAt = new Date(m.sent_at).toISOString();
    lines.push(
      `  <message id="${m.id}" from="${m.from_session_id}" fromKind="${m.from_session_kind}" sentAt="${sentAt}"${replyAttr}>`
    );
    lines.push(`    <body>${escapeXml(m.body)}</body>`);
    lines.push(`  </message>`);
  }
  lines.push(`</agent-link-inbox>`);
  return lines.join("\n");
}

function escapeXml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
