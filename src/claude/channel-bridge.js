import fs from "node:fs";
import path from "node:path";
import { openMailbox, resolveMailboxPath } from "./mailbox.js";

// Poll cadence: start at 1s, double on every tick that finds nothing to
// deliver, cap at 30s, and snap back to 1s on delivery or when fs.watch sees
// the mailbox change. An idle bridge therefore costs one stat() every 30s.
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 30_000;
const WAKE_DEBOUNCE_MS = 50;

export function renderChannelMessage(message) {
  return {
    content: [
      `<agent-link-message id="${escapeAttr(message.id)}" from="${escapeAttr(message.from_session_id)}" fromKind="${escapeAttr(message.from_session_kind)}">`,
      `  <body>${escapeXml(message.body)}</body>`,
      `  <reply>Use reply_agent_link_message with messageId="${escapeAttr(message.id)}" to reply.</reply>`,
      `</agent-link-message>`
    ].join("\n"),
    meta: {
      message_id: String(message.id),
      from_session_id: String(message.from_session_id),
      from_kind: String(message.from_session_kind)
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
    if (session?.sessionId) cachedSession = session;
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
      const pending = mb.listPendingFor({ toSessionId: session.sessionId });
      lastHadPending = pending.length > 0;
      let delivered = 0;
      for (const message of pending) {
        const rendered = renderChannelMessage(message);
        await notify({
          method: "notifications/claude/channel",
          params: {
            content: rendered.content,
            meta: rendered.meta
          }
        });
        mb.markDelivered({ messageId: message.id });
        delivered += 1;
      }
      lastHadPending = false;
      lastSignature = signature;
      return { delivered };
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
      schedule(delay);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.close();
      watcher = null;
    }
  };
}

function escapeXml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function escapeAttr(s) {
  return escapeXml(s).replace(/"/g, "&quot;");
}
