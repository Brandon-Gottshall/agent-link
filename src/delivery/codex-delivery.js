// src/delivery/codex-delivery.js
//
// Background Codex delivery (design R1.11, R1.12a, R7.14; B7 spike):
//   - reminder turns for open reply/action messages (unless
//     AGENT_LINK_CODEX_REMINDERS=0);
//   - queued Codex mail at most an hour old (a failed push, a reply to a
//     busy sender, a message handed over to a Codex role holder);
//   - push claims left stale by a crash or an unanswered request;
//   - delivery confirmation from the userMessage item's clientId.
//
// Safety rules, each enforced here or in makeBackgroundPreflight:
//   - A pass runs only while this server already has a connected endpoint.
//     It never connects, so it never starts a managed app-server (on a Claude
//     host or anywhere else), and it touches only threads the tracker saw in
//     that endpoint, so an endpoint with nothing to do still idles out.
//   - The tracker is cleared whenever the endpoint connection closes or is
//     replaced (idle shutdown, exit, reconnect).
//   - Every push is preceded by a fresh thread/read and the held check (a
//     stale idle record never skips it) and the deny-only rollout check.
//   - At most one background turn per thread per pass; an accepted turn
//     marks the thread active at once.
import { existsSync } from "node:fs";
import { openMailbox, resolveMailboxPath } from "../claude/mailbox.js";
import { getLogger } from "../shared/log.js";
import { reminderSettings } from "./message-status.js";
import { deliverCodexReminders } from "./reminders.js";
import { handedOverTo, isPendingFor, readRoleTable } from "./role-handover.js";
import {
  CODEX_PUSH_VIA,
  deliveredClientId,
  desktopPushPolicy,
  makeBackgroundPreflight,
  makePushClaimSweepState,
  makeThreadStatusTracker,
  pushQueuedCodexMail,
  pushWhenIdle,
  sweepStalePushClaims
} from "./codex-push.js";

/**
 * The Codex thread a mailbox row is for now: a role's new holder (R7.20),
 * else the stored recipient; null for a Claude recipient.
 * @param {Record<string, any>} row
 * @param {import("../registry/roles.js").RoleTable | null} roleTable
 */
export function codexRecipientOf(row, roleTable) {
  const holder = handedOverTo(row, roleTable);
  if (holder) return holder.startsWith("codex:") ? holder.slice("codex:".length) : null;
  return row.to_session_kind === "codex" ? String(row.to_session_id).replace(/^codex:/, "") : null;
}

/**
 * Marks a pushed message delivered when the thread reports the userMessage
 * item carrying its id (clientId, B7 spike), unless it already is. Only for
 * a message addressed to that thread. Accepted risk (documented): any
 * client of the same endpoint could send a userMessage with another
 * message's id as clientId and mark it delivered; it cannot change the
 * message or resolve it.
 * @param {{threadId: string, messageId: string}} confirmed
 * @param {{mailboxOpener?: () => ReturnType<typeof openMailbox>, mailboxExists?: () => boolean}} [options]
 * @returns {boolean} true when this call marked it delivered
 */
export function confirmDelivery({ threadId, messageId }, { mailboxOpener = () => openMailbox(), mailboxExists = () => existsSync(resolveMailboxPath()) } = {}) {
  let mailbox = null;
  try {
    if (!mailboxExists()) return false;
    mailbox = mailboxOpener();
    const row = mailbox.getMessage({ messageId });
    if (!row || row.delivered_at || String(row.to_session_id).replace(/^codex:/, "") !== threadId) return false;
    mailbox.markDelivered({ messageId, to: `codex:${threadId}`, via: CODEX_PUSH_VIA });
    return true;
  } catch (error) {
    getLogger().warn("codex_delivery.confirm_failed", { message: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    mailbox?.close();
  }
}

/**
 * @param {{
 *   appServer: {
 *     request: (method: string, params?: any) => Promise<any>,
 *     isConnected?: () => boolean,
 *     onNotification?: (listener: (message: any) => void) => () => void,
 *     onConnectionChange?: (listener: (event: "connecting" | "closed") => void) => () => void
 *   },
 *   roles?: import("../registry/roles.js").RoleStore | null,
 *   reminders?: boolean,
 *   tracker?: ReturnType<typeof makeThreadStatusTracker>,
 *   rolloutCheck?: import("./codex-push.js").RolloutCheck | null,
 *   policy?: () => import("./codex-push.js").DesktopPushPolicy,
 *   mailboxOpener?: () => ReturnType<typeof openMailbox>,
 *   mailboxExists?: () => boolean,
 *   settings?: import("./message-status.js").ReminderSettings,
 *   now?: () => number
 * }} options
 */
export function makeCodexDelivery({
  appServer,
  roles = null,
  reminders = true,
  tracker = makeThreadStatusTracker(),
  rolloutCheck = null,
  policy = () => desktopPushPolicy(),
  mailboxOpener = () => openMailbox(),
  mailboxExists = () => existsSync(resolveMailboxPath()),
  settings = reminderSettings(),
  now = () => Date.now()
}) {
  let running = false;
  // The stale push-claim sweep's rotation and give-up bookkeeping (N1).
  const claimSweep = makePushClaimSweepState();

  /**
   * One background pass.
   * @returns {Promise<{skipped?: string, reminders?: any[], pushed?: any[], claims?: any[]}>}
   */
  async function pass() {
    if (running) return { skipped: "running" };
    // F2: never connect (never start a managed app-server) from here.
    if (typeof appServer.isConnected !== "function" || !appServer.isConnected()) return { skipped: "not_connected" };
    if (!mailboxExists()) return { skipped: "no_mailbox" };
    running = true;
    let mailbox = null;
    try {
      mailbox = mailboxOpener();
      const roleTable = readRoleTable(roles);
      const recipientOf = (/** @type {Record<string, any>} */ row) => codexRecipientOf(row, roleTable);
      const claims = await sweepStalePushClaims({
        appServer,
        mailbox,
        recipientOf,
        state: claimSweep,
        onAbandon: ({ messageId, reason }) => getLogger().info("codex_delivery.push_claim_abandoned", { messageId, reason, note: "left to inbox pull" })
      });
      if (tracker.size === 0) return { claims };
      const preflight = makeBackgroundPreflight({ appServer, tracker, policy: policy(), rolloutCheck, sent: new Set() });
      const at = now();
      const reminded = reminders ? await deliverCodexReminders({ appServer, mailbox, now: at, settings, roleTable, preflight }) : [];
      const pushed = await pushQueuedCodexMail({
        appServer,
        mailbox,
        preflight,
        now: at,
        recipientOf,
        isPendingFor: (row, threadId) => isPendingFor(row, roleTable, new Set([threadId, `codex:${threadId}`]))
      });
      const sent = [...reminded, ...pushed].filter((r) => r.outcome === "sent");
      if (sent.length || claims.length) getLogger().info("codex_delivery.pass", { reminders: reminded, pushed, claims });
      return { reminders: reminded, pushed, claims };
    } catch (error) {
      getLogger().warn("codex_delivery.failed", { message: error instanceof Error ? error.message : String(error) });
      return { skipped: "failed" };
    } finally {
      mailbox?.close();
      running = false;
    }
  }

  /** @type {NodeJS.Timeout | null} */
  let soon = null;
  /**
   * Feeds one app-server notification: clientId confirmation, the tracker,
   * and a pass shortly after a thread goes idle.
   * @param {any} message
   */
  function onNotification(message) {
    const confirmed = deliveredClientId(message);
    if (confirmed) confirmDelivery(confirmed, { mailboxOpener, mailboxExists });
    const change = tracker.observe(message);
    if (!change?.idle || soon) return;
    soon = setTimeout(() => {
      soon = null;
      void pass();
    }, 250);
    soon.unref?.();
  }

  /** @param {"connecting" | "closed"} _event */
  function onConnectionChange(_event) {
    // A new or lost endpoint: nothing the old one reported still holds.
    tracker.clear();
  }

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {Array<() => void>} */
  const unsubscribe = [];
  return {
    pass,
    onNotification,
    onConnectionChange,
    tracker,
    start() {
      timer = setInterval(() => void pass(), settings.intervalMs);
      timer.unref?.();
      const offNotification = appServer.onNotification?.(onNotification);
      if (offNotification) unsubscribe.push(offNotification);
      const offConnection = appServer.onConnectionChange?.(onConnectionChange);
      if (offConnection) unsubscribe.push(offConnection);
      return timer;
    },
    stop() {
      if (timer) clearInterval(timer);
      if (soon) clearTimeout(soon);
      for (const off of unsubscribe.splice(0)) off();
    }
  };
}

/**
 * Starts background Codex delivery for a server (see the module comment).
 * @param {Parameters<typeof makeCodexDelivery>[0]} options
 */
export function startCodexDelivery(options) {
  const delivery = makeCodexDelivery(options);
  delivery.start();
  return delivery;
}

/**
 * Fork's reconcile `deliver` seam (src/codex/fork.js makeForkJobs, section
 * 9.3): pushes a reconcile message that is already in the original's
 * mailbox through the same Codex push as every other message
 * (pushWhenIdle): only to an idle original that is not held (mailbox-only,
 * R1.12a) and whose transcript no other process has open; otherwise it
 * stays queued, with the push's warning, for the original's inbox.
 *
 * Claims: fork holds `fork-push-<id>` around this call; the push takes
 * `push-<id>`, the one claim that gates a turn for a message. Neither waits
 * on the other, and fork's recovery, the background retry and this call can
 * never start two turns for one message.
 * @param {{
 *   appServer: {request: (method: string, params?: any) => Promise<any>},
 *   tracker?: import("./codex-push.js").ThreadStatusTracker | null,
 *   rolloutCheck?: import("./codex-push.js").RolloutCheck | null,
 *   mailboxOpener?: () => ReturnType<typeof openMailbox>
 * }} options
 * @returns {(record: {messageId: string, threadId: string, envelope?: string | null}) => Promise<{delivery: "delivered" | "queued", deliveredVia?: string, turnId?: string, warnings: any[]}>}
 */
export function makeReconcileDelivery({ appServer, tracker = null, rolloutCheck = null, mailboxOpener = () => openMailbox() }) {
  return async ({ messageId, threadId, envelope = null }) => {
    const mailbox = mailboxOpener();
    try {
      const pushed = await pushWhenIdle({ appServer, mailbox, messageId, threadId, tracker, rolloutCheck, text: envelope });
      return {
        delivery: pushed.delivery,
        ...(pushed.deliveredVia ? { deliveredVia: pushed.deliveredVia } : {}),
        ...(pushed.turnId ? { turnId: pushed.turnId } : {}),
        warnings: pushed.warnings
      };
    } finally {
      mailbox.close();
    }
  };
}
