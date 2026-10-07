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
import { isHeldByActiveWait } from "../claude/active-waits.js";
import { peerMessageFromMailbox, renderInbox } from "../shared/envelope.js";
import { mailboxRowResult } from "../registry/addresses.js";
import { currentRecipient, noCurrentSession } from "../delivery/recipient.js";
import { reminderSettings } from "../delivery/message-status.js";
import { isOpenMailFor } from "../delivery/inbox-view.js";
import { LIMITS, bool, limit, out } from "../server/schemas.js";
import { readRoleTable, recipientView } from "../delivery/role-handover.js";

/** @type {import("../server/registry.js").ToolDefinition} */
export const readInboxTool = {
  name: "read_agent_link_inbox",
  description:
    "Read pending agent-link messages addressed to the current session (a Claude session, or the calling Codex thread), oldest first. By default the tool marks the returned " +
    "messages delivered as it reads them; messages beyond `limit` stay pending (remainingCount). Returns validated message fields and a rendered " +
    "<agent-link-inbox> block as a visible MCP tool result so the user can see the inbound mail in the transcript. " +
    "Each message is wrapped in an <agent-link-message> envelope marking it as content from another agent, not " +
    "from the user. After the new messages it also shows open messages awaiting your resolution (reply or action messages " +
    "already delivered and still pending), so they can be resolved with reply_agent_link_message; set includeOpen=false " +
    "to skip them. Pair with the agent-link notify hooks, which report pending mail and remind about open messages. " +
    "Fails with no_current_session when the caller cannot be identified (a Codex thread is identified by the thread id Codex passes in the call's _meta, or CODEX_THREAD_ID).",
  inputSchema: {
    type: "object",
    properties: {
      markAsDelivered: bool("If false, return the messages without marking them delivered (idempotent inspection). Defaults to true."),
      limit: limit("inbox", "messages"),
      includeOpen: bool("Also show delivered reply/action messages that are still pending resolution, after the new ones (within limit). Defaults to true.")
    },
    additionalProperties: false
  },
  output: {
    sessionId: out(["string", "null"], "The Claude session whose inbox was read, or null for a Codex thread."),
    threadId: out("string", "The Codex thread whose inbox was read (Codex callers only)."),
    address: out(["string", "null"], "The caller's address: claude:<cliSessionId> or codex:<threadId>."),
    markedDelivered: out("boolean", "Whether the returned messages were marked delivered."),
    messages: out("array", "Validated envelope fields per message: {id, from, fromHarness, fromVerified, to, sentAt, anticipation, replyBy, inReplyTo, replyTo (deprecated duplicate of inReplyTo), fromAddress, toAddress, status, resolution, reminders, open}. from/to are addresses; status is null for fyi. open is true for an already-delivered message shown again because it awaits resolution. Bodies appear only in renderedBlock."),
    openCount: out("integer", "How many of messages are open messages shown again (open: true)."),
    remainingCount: out("integer", "Pending messages not returned because of limit; they stay pending."),
    heldByActiveWait: out("integer", "Messages left for an in-process wait that will return them itself."),
    renderedBlock: out("string", "The <agent-link-inbox> block with one envelope per message.")
  },
  // Marks messages delivered: not read-only, not destructive (section 3.6).
  annotations: { readOnlyHint: false, destructiveHint: false }
};

/**
 * @param {{
 *   resolveCurrentSession?: () => any,
 *   mailboxOpener?: () => any,
 *   host?: string,
 *   now?: () => number,
 *   reminderSettings?: () => import("../delivery/message-status.js").ReminderSettings,
 *   roles?: import("../registry/roles.js").RoleStore | null
 * }} [deps]
 */
export function makeReadInboxHandler({
  resolveCurrentSession,
  roles = null,
  mailboxOpener,
  host = "claude",
  now = () => Date.now(),
  reminderSettings: settingsFn = () => reminderSettings()
} = {}) {
  if (typeof resolveCurrentSession !== "function") {
    throw new Error("makeReadInboxHandler: resolveCurrentSession must be a function");
  }
  const openMb = typeof mailboxOpener === "function"
    ? mailboxOpener
    : () => openMailbox();

  return {
    /**
     * @param {Record<string, any>} [args]
     * @param {{callerContext?: any}} [ctx]
     */
    read_agent_link_inbox: async (args = {}, ctx = {}) => {
      // A Claude session or a Codex thread, from runtime identity (R1.4, R1.13).
      const me = currentRecipient({ host, callerContext: ctx.callerContext ?? null, resolveCurrentSession });
      if (!me) throw noCurrentSession("read_agent_link_inbox", host);

      const markAsDelivered = args.markAsDelivered !== false; // defaults true
      const limit = typeof args.limit === "number" ? args.limit : LIMITS.inbox.def;

      // Mail may be addressed to any id form of this session (sidecar id,
      // CLI id, local_<cli>); see claudeSessionAliases().
      // A message sent through role:<name> follows the role: while it is
      // open, the role's current holder reads it, not the previous one
      // (R7.20).
      // A handed-over message is a fresh delivery to the new holder, and
      // deliveries are recorded with the address they went to.
      const address = me.address;
      const inbox = recipientView({ aliases: me.aliases, address, table: readRoleTable(roles) });
      const mb = openMb();
      try {
        // A reply that an in-process wait (message_claude_session with
        // waitForReply, or wait_for_claude_session) is blocked on belongs to
        // that wait, which returns it as its tool result. Same rule as the
        // channel bridge: never drain or show it here, or it arrives twice.
        const all = mb.listPendingFor({ recipient: inbox.isRecipient, pending: inbox.isPending });
        const pending = all.filter((message) => !isHeldByActiveWait(message));
        // Slice before marking: with `limit`, only the returned messages are
        // marked delivered and the rest stay pending.
        const rows = pending.slice(0, limit);
        if (markAsDelivered) {
          for (const row of rows) mb.markDelivered({ messageId: row.id, to: address });
        }
        // Open messages (design 7.5): delivered reply/action messages still
        // pending resolution, so the reminder's "call read_agent_link_inbox
        // to see them" shows them. Never marked again; within the limit.
        const at = now();
        const settings = settingsFn();
        const shownIds = new Set(rows.map((row) => row.id));
        const open = args.includeOpen === false || rows.length >= limit
          ? []
          : mb.inspect({ limit: Number.MAX_SAFE_INTEGER })
            .filter((row) => !shownIds.has(row.id) && isOpenMailFor(row, inbox, at, settings))
            .sort((a, b) => a.sent_at - b.sent_at)
            .slice(0, limit - rows.length);
        const shown = [...rows, ...open];
        const peers = shown.map(peerMessageFromMailbox);
        // Structured entries carry only the validated envelope fields. The
        // body reaches the model only inside renderedBlock's envelopes; raw
        // rows (body, metadata) never leave this function.
        const messages = shown.map((row, index) => ({
          ...mailboxRowResult(row, { includeEnvelope: false, now: at }),
          open: index >= rows.length
        }));
        const held = all.length - pending.length;
        return {
          sessionId: me.sessionId,
          ...(me.threadId ? { threadId: me.threadId } : {}),
          address,
          markedDelivered: markAsDelivered,
          messages,
          openCount: open.length,
          remainingCount: pending.length - rows.length,
          ...(held > 0 ? { heldByActiveWait: held } : {}),
          renderedBlock: rows.length < pending.length
            ? `${renderInbox(peers)}\n${pending.length - rows.length} more pending message(s): call read_agent_link_inbox again to read them.`
            : renderInbox(peers)
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
  return [{ definition: readInboxTool, handler: (args, ctx) => handlers.read_agent_link_inbox(args, ctx) }];
}
