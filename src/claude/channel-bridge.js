import fs from "node:fs";
import path from "node:path";
import { openMailbox, resolveMailboxPath } from "./mailbox.js";
import { isHeldByActiveWait, onActiveWaitEnded } from "./active-waits.js";
import { claudeSessionAliases } from "./identity.js";
import { normalizePeerMessage, peerMessageFromMailbox, renderPeerEnvelope } from "../shared/envelope.js";

// Poll cadence: start at 1s, double on every tick that finds nothing to
// deliver, cap at 30s, and snap back to 1s on delivery or when fs.watch sees
// the mailbox change. An idle bridge therefore costs one stat() every 30s.
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 30_000;
const WAKE_DEBOUNCE_MS = 50;

// The channel event content is exactly the section 2 peer envelope. The meta
// carries the same validated ids; nothing unvalidated reaches the model.
export function renderChannelMessage(message) {
  const peer = peerMessageFromMailbox(message);
  const fields = normalizePeerMessage(peer);
  return {
    content: renderPeerEnvelope(peer),
    meta: {
      message_id: fields.id,
      from_session_id: fields.from,
      from_kind: fields.fromHarness,
      from_verified: fields.fromVerified ? "true" : "false"
    }
  };
}

export function makeAgentLinkChannelBridge({
  resolveCurrentSession,
  mailboxOpener,
  mailboxPath,
  notify,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPollIntervalMs = DEFAULT_MAX_POLL_INTERVAL_MS,
  watch = true
} = {}) {
  const customOpener = typeof mailboxOpener === "function";
  const openMb = customOpener ? mailboxOpener : () => openMailbox();
  // The unchanged-file shortcut is only safe when we know which file the
  // opener reads; a custom opener without a path always gets a full check.
  const signaturePath = mailboxPath ?? (customOpener ? null : resolveMailboxPath());
  const minDelay = Math.max(1, pollIntervalMs);
  const maxDelay = Math.max(minDelay, maxPollIntervalMs);

  let timer = null;
  let watcher = null;
  let unsubscribeWaitEnded = null;
  let running = false;
  let stopped = true;
  let delay = minDelay;
  let cachedSession = null;
  let lastSignature = null;
  let lastHadPending = true;
  const stats = { ticks: 0, fullChecks: 0, skippedUnchanged: 0, sessionResolves: 0, wakes: 0 };

  // The current session never changes for the life of this server, and
  // resolving it walks every Claude transcript plus a `ps` scan. Resolve once
  // and reuse; retry only while unresolved (on the backed-off schedule).
  function currentSession() {
    if (cachedSession) return cachedSession;
    stats.sessionResolves += 1;
    const session = typeof resolveCurrentSession === "function" ? resolveCurrentSession() : null;
    // A transcript-only resolution may later gain its Desktop sidecar (and
    // with it the canonical id other agents address), so keep asking the
    // resolver (memoized by the server) instead of pinning it here.
    if (session?.sessionId && session.source !== "transcript") cachedSession = session;
    return session;
  }

  function mailboxSignature() {
    if (!signaturePath) return null;
    try {
      const st = fs.statSync(signaturePath);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch (error) {
      return error?.code === "ENOENT" ? "missing" : null;
    }
  }

  async function pollOnce({ force = false } = {}) {
    stats.ticks += 1;
    const session = currentSession();
    if (!session?.sessionId) return { delivered: 0, skipped: "no_current_session" };
    if (session.surface && session.surface !== "code") return { delivered: 0, skipped: "not_code_surface" };
    if (typeof notify !== "function") return { delivered: 0, skipped: "no_notify" };

    // Signature is taken before reading, so a write that lands mid-check
    // changes the signature and is picked up on the next tick.
    const signature = mailboxSignature();
    if (!force && signature !== null && signature === lastSignature && !lastHadPending) {
      stats.skippedUnchanged += 1;
      return { delivered: 0, skipped: "unchanged" };
    }
    stats.fullChecks += 1;
    const mb = openMb();
    try {
      const all = mb.listPendingFor({ toSessionIds: claudeSessionAliases(session) });
      // A reply that an in-process wait (message_claude_session with
      // waitForReply, or wait_for_claude_session) is blocked on stays pending
      // for that wait, which returns it as its tool result; pushing it here
      // too would deliver it twice. Held messages keep lastHadPending set, so
      // later polls re-check them, and the wait's end wakes the bridge.
      const pending = all.filter((message) => !isHeldByActiveWait(message));
      const held = all.length - pending.length;
      lastHadPending = all.length > 0;
      // Claim every message before the first await. The inbox tool runs in
      // this same process and drains synchronously, so a claim made before
      // notifying means it can never hand out a message the channel is
      // already delivering. A failed notification releases what it did not
      // deliver.
      for (const message of pending) mb.markDelivered({ messageId: message.id });
      let delivered = 0;
      try {
        for (const message of pending) {
          const rendered = renderChannelMessage(message);
          await notify({
            method: "notifications/claude/channel",
            params: {
              content: rendered.content,
              meta: rendered.meta
            }
          });
          delivered += 1;
        }
      } catch (error) {
        for (const message of pending.slice(delivered)) mb.releaseDelivery({ messageId: message.id });
        throw error;
      }
      lastHadPending = held > 0;
      lastSignature = signature;
      return held > 0 ? { delivered, held } : { delivered };
    } finally {
      mb.close();
    }
  }

  function schedule(ms) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
    timer.unref?.();
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    if (running) {
      schedule(delay);
      return;
    }
    running = true;
    let active = false;
    try {
      const result = await pollOnce();
      active = (result?.delivered ?? 0) > 0;
    } catch (err) {
      process.stderr.write(`agent-link channel bridge: ${err.message}\n`);
    } finally {
      running = false;
    }
    delay = active ? minDelay : Math.min(delay * 2, maxDelay);
    schedule(delay);
  }

  function wake() {
    if (stopped) return;
    stats.wakes += 1;
    delay = minDelay;
    schedule(WAKE_DEBOUNCE_MS);
  }

  function startWatcher() {
    if (!watch || !signaturePath) return;
    try {
      const dir = path.dirname(signaturePath);
      const base = path.basename(signaturePath);
      watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename || String(filename) === base) wake();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  return {
    pollOnce,
    stats: () => ({ ...stats, delayMs: delay, watching: Boolean(watcher) }),
    start() {
      if (!stopped) return;
      stopped = false;
      delay = minDelay;
      startWatcher();
      // A wait that ends without consuming what it held (timeout, idle)
      // hands it back to the channel right away, not after a backoff.
      unsubscribeWaitEnded = onActiveWaitEnded(wake);
      schedule(delay);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.close();
      watcher = null;
      unsubscribeWaitEnded?.();
      unsubscribeWaitEnded = null;
    }
  };
}
