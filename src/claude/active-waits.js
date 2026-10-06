// In-process registry of reply waits that are currently blocked.
//
// message_claude_session(waitForReply) and wait_for_claude_session poll the
// mailbox every 250 ms for the reply they are blocked on. When the caller is a
// loaded Claude Code session, its channel bridge runs in this same process and
// wakes ~50 ms after the mailbox changes, so without coordination it claims the
// reply first and pushes it as a second <agent-link-message> that the tool
// result already carries. A wait registers what it will consume here; the
// bridge leaves matching messages pending for the wait. When the wait ends
// (reply, idle or timeout) it unregisters, and listeners are told so the
// bridge delivers anything the wait left behind on its next poll.
//
// A wait matches a message when the message comes from one of `fromIds`, is
// addressed to one of `toIds`, and either replies to `replyToMessageId` or,
// without one, was sent at or after `since`. This mirrors exactly what each
// wait would consume, so a message the wait would never take (a third party's
// reply, an older message) is still delivered normally.

const waits = new Map();
const endListeners = new Set();
let nextToken = 1;

export function registerActiveWait({ replyToMessageId = null, fromIds = [], toIds = [], since = null } = {}) {
  const token = nextToken++;
  waits.set(token, {
    replyToMessageId: typeof replyToMessageId === "string" && replyToMessageId ? replyToMessageId : null,
    from: new Set(fromIds),
    to: new Set(toIds),
    since: Number.isFinite(since) ? since : null
  });
  let released = false;
  return function releaseActiveWait() {
    if (released) return;
    released = true;
    waits.delete(token);
    for (const listener of [...endListeners]) {
      try {
        listener();
      } catch {
        // A listener failure must not break the wait that is ending.
      }
    }
  };
}

export function isHeldByActiveWait(message) {
  if (!message || waits.size === 0) return false;
  for (const wait of waits.values()) {
    if (!wait.from.has(message.from_session_id) || !wait.to.has(message.to_session_id)) continue;
    if (wait.replyToMessageId) {
      if (message.reply_to_message_id === wait.replyToMessageId) return true;
    } else if (wait.since === null || message.sent_at >= wait.since) {
      return true;
    }
  }
  return false;
}

// Returns an unsubscribe function.
export function onActiveWaitEnded(listener) {
  if (typeof listener !== "function") return () => {};
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

export function activeWaitCount() {
  return waits.size;
}
