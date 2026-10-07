// src/codex/thread-actions.js
//
// launch_codex_thread and archive_codex_thread (moved from src/server.js in
// PR B5, unchanged). Built by a factory taking the app-server client and the
// messaging and desktop-routing helpers they share; nothing runs at import
// time.

import { codexThreadDeepLink } from "./desktop-routing.js";
import { extractLoadedThreadIds } from "./loaded-threads.js";
import { archiveLocalThread, findLocalThreadFile, readLocalThread } from "./session-index.js";
import { summarizeThread, summarizeTurn } from "./thread-summary.js";
import { inferArchiveState, loadedStateSemantics } from "./thread-utils.js";
import { optionalString, requiredString } from "../shared/args.js";
import { assertPeerBodyWithinLimit } from "../shared/envelope.js";
import { AgentLinkError } from "../shared/errors.js";
import { resolveLabels } from "../delivery/message-status.js";

/** @typedef {import("./thread-queries.js").AppServerLike} AppServerLike */
/** @typedef {import("./thread-messaging.js").ToolContext} ToolContext */
/** @typedef {ReturnType<typeof import("./thread-messaging.js").makeThreadMessaging>} ThreadMessaging */
/** @typedef {ReturnType<typeof import("./desktop-routing.js").makeDesktopRouting>} DesktopRouting */

/**
 * The loaded-thread guard archive runs before touching a thread.
 * @typedef {{
 *   ok: boolean,
 *   source: string,
 *   checked: boolean,
 *   loaded: boolean | null,
 *   loadedThreadIds?: string[],
 *   error?: string,
 *   fallback?: string,
 *   note?: string,
 *   appServer: any
 * }} LoadedCheck
 */

/**
 * What an archive did (app-server or local transcript move).
 * @typedef {{
 *   source?: string,
 *   alreadyArchived: boolean,
 *   from: string | null,
 *   to: string | null,
 *   thread: any,
 *   archiveStateBefore: any,
 *   archiveStateAfter: any,
 *   response?: any,
 *   [key: string]: any
 * }} ArchiveMove
 */

/**
 * @typedef {{
 *   appServer: AppServerLike,
 *   messaging: Pick<ThreadMessaging, "sendToThread" | "recordActionReceipt"> & Partial<Pick<ThreadMessaging, "callerAddress">>,
 *   desktop: Pick<DesktopRouting, "openCodexDesktopThread">
 * }} ThreadActionDeps
 */

/**
 * @param {Record<string, any>} source
 * @param {Record<string, any>} target
 * @param {string} key
 */
export function copyOptionalString(source, target, key) {
  const value = optionalString(source[key]).trim();
  if (value) {
    target[key] = value;
  }
}

/**
 * @param {{ephemeral?: boolean}} args
 */
export function launchWarnings(args) {
  if (args.ephemeral !== true) {
    return [];
  }
  return [
    {
      code: "ephemeral-thread-limited-history",
      severity: "warning",
      message: "This thread was created as ephemeral. Some app-server read paths, including includeTurns-based reply confirmation, may be unavailable; use ephemeral=false for WF tests that need waitForReply evidence."
    }
  ];
}

/**
 * @param {{loadedCheck: LoadedCheck, archive: ArchiveMove, action: string}} options
 */
export function archiveReceiptEvidence({ loadedCheck, archive, action }) {
  const checked = loadedCheck.checked === true;
  const loaded = loadedCheck.loaded === true;
  const status = checked
    ? (loaded ? "loaded_thread_detected" : "loaded_thread_guard_passed")
    : "loaded_thread_guard_unchecked";
  return {
    primaryStatus: action,
    loadedThreadGuard: {
      status,
      checked,
      loaded: loadedCheck.loaded ?? null,
      source: loadedCheck.source ?? null,
      loadedThreadIdsCount: Array.isArray(loadedCheck.loadedThreadIds) ? loadedCheck.loadedThreadIds.length : null,
      note: loadedCheck.note ?? null,
      error: loadedCheck.error ?? null
    },
    archiveMove: {
      source: archive.source ?? "local-jsonl",
      alreadyArchived: archive.alreadyArchived,
      from: archive.from,
      to: archive.to,
      before: archive.archiveStateBefore,
      after: archive.archiveStateAfter,
      appServerResponse: archive.response ?? null
    },
    interpretation: "For archive receipts, loadedThreadGuard is the primary active-safety evidence. target.status may come from local JSONL and can be unknown even when the app-server loaded-thread guard passed."
  };
}

/**
 * The launcher recorded on a launch receipt (R9.9): a session address from
 * runtime identity, never `external`.
 * @param {string | null | undefined} address
 * @returns {string | null}
 */
export function launcherAddress(address) {
  return typeof address === "string" && /^(claude|codex):/.test(address) ? address : null;
}

/**
 * @param {ThreadActionDeps} deps
 */
export function makeThreadActions({ appServer, messaging, desktop }) {
  const { sendToThread, recordActionReceipt, callerAddress } = messaging;
  const { openCodexDesktopThread } = desktop;

  /**
   * @param {Record<string, any>} args
   * @param {ToolContext} [toolContext]
   */
  async function launchThreadTool(args, toolContext = {}) {
    const result = await launchThread(args, toolContext);
    // gui.opened: Codex Desktop was actually routed (section 3.7).
    return { ...result, gui: { opened: result.gui?.attempted === true && result.gui?.ok === true, ...result.gui } };
  }

  /**
   * @param {Record<string, any>} args
   * @param {ToolContext} [toolContext]
   */
  async function archiveThreadTool(args, toolContext = {}) {
    const result = await archiveThread(args, toolContext);
    return { status: result.action === "already_archived" ? "already_archived" : "archived", ...result };
  }

  /**
   * @param {Record<string, any>} args
   * @param {ToolContext} [toolContext]
   * @returns {Promise<Record<string, any>>}
   */
  async function launchThread(args, toolContext = {}) {
    // Reject an oversized message, or bad labels, before a thread is created for it.
    assertPeerBodyWithinLimit(optionalString(args.message).trim());
    const labels = resolveLabels({ anticipation: args.anticipation, replyBy: args.replyBy, waitForReply: false, now: Date.now() });
    if (!optionalString(args.message).trim() && (args.anticipation !== undefined || args.replyBy !== undefined)) {
      throw new AgentLinkError("invalid_arguments", "anticipation and replyBy label the first message; pass message too.", {
        details: { errors: [{ path: args.anticipation !== undefined ? "anticipation" : "replyBy", rule: "requires", expected: "message" }] }
      });
    }
    /** @type {Record<string, any>} */
    const startParams = {};
    copyOptionalString(args, startParams, "cwd");
    copyOptionalString(args, startParams, "model");
    copyOptionalString(args, startParams, "modelProvider");
    copyOptionalString(args, startParams, "serviceTier");
    if (typeof args.ephemeral === "boolean") {
      startParams.ephemeral = args.ephemeral;
    }

    const response = await appServer.request("thread/start", startParams);
    const threadId = requiredString(response.thread?.id, "thread.id");
    const message = optionalString(args.message).trim();
    const requestedName = optionalString(args.name).trim();
    const shouldPersistBlankThread = !message && args.ephemeral !== true;
    const threadName = requestedName || (shouldPersistBlankThread ? "New thread" : "");
    let turn = null;
    let nameUpdate = null;

    if (threadName) {
      await appServer.request("thread/name/set", { threadId, name: threadName });
      nameUpdate = {
        name: threadName,
        reason: requestedName
          ? "name was supplied by caller"
          : "blank non-ephemeral thread was named so Codex can persist and later reopen it"
      };
    }

    let peerMessage = null;
    /** @type {Record<string, any> | null} */
    let sent = null;
    if (message) {
      /** @type {Record<string, any>} */
      const startParams = {};
      copyOptionalString(args, startParams, "cwd");
      copyOptionalString(args, startParams, "model");
      copyOptionalString(args, startParams, "effort");
      // The sender chose every setting of the new thread and its first turn.
      const overrides = {};
      for (const field of ["cwd", "model", "effort", "modelProvider", "serviceTier"]) {
        copyOptionalString(args, overrides, field);
      }
      // Mailbox first, then push (R1.10, R1.11): the new thread is loaded and
      // idle, so the message starts its first turn.
      sent = await sendToThread({ toolContext, threadId, message, labels, overrides, receipt: args.receipt, plan: "start", startParams });
      peerMessage = sent.peerMessage;
      if (sent.push.delivery === "delivered") turn = summarizeTurn(sent.push.response?.turn);
    }

    const shouldOpenGui = args.openInGui === true;
    const gui = shouldOpenGui
      ? await openCodexDesktopThread({ threadId, ephemeral: args.ephemeral === true })
      : {
          attempted: false,
          threadId,
          deepLink: codexThreadDeepLink(threadId),
          reason: "openInGui was false; thread was created through app-server without routing or focusing Codex Desktop.",
          behavior: "Deep link is returned as data only; no GUI process was contacted.",
          focusPolicy: "No keyboard, mouse, menu, window automation, or LaunchServices route was used."
        };
    const deepLink = codexThreadDeepLink(threadId);

    const appServerSummary = appServer.getConnectionSummary();
    const action = message
      ? (nameUpdate ? "started_thread+named_thread+started_turn" : "started_thread+started_turn")
      : (nameUpdate ? "started_thread+named_thread" : "started_thread");
    /** @type {Record<string, any>} */
    const result = {
      ok: true,
      source: "app-server",
      action,
      thread: {
        ...summarizeThread(response.thread),
        name: nameUpdate?.name ?? response.thread?.name ?? null
      },
      nameUpdate,
      turn,
      peerMessage,
      ...(sent
        ? {
            messageId: sent.messageId,
            delivery: sent.push.delivery,
            deliveredVia: sent.push.deliveredVia,
            anticipation: labels.anticipation,
            replyBy: labels.replyBy === null ? null : new Date(labels.replyBy).toISOString()
          }
        : {}),
      warnings: [...launchWarnings(args), ...(sent ? sent.push.warnings : [])],
      gui,
      appServer: appServerSummary
    };
    result.receipt = await recordActionReceipt({
      action: "launch_thread",
      receipt: args.receipt,
      target: {
        threadId,
        turnId: turn?.id ?? null,
        name: result.thread.name,
        cwd: result.thread.cwd,
        archiveState: result.thread.archiveState,
        status: result.thread.status,
        deepLink
      },
      message,
      finalResponse: null,
      delivery: {
        state: sent && sent.push.delivery !== "delivered" ? "queued_in_mailbox" : "accepted_by_app_server",
        action,
        turnId: turn?.id ?? null
      },
      replyConfirmation: null,
      runtimeCallerContext: toolContext.callerContext,
      appServer: appServerSummary,
      // R9.9: the launcher, from runtime identity only; external is never one.
      extra: { launchedBy: launcherAddress(callerAddress?.(toolContext)), ...(sent ? { messageId: sent.messageId } : {}) }
    });
    return result;
  }

  /**
   * @param {Record<string, any>} args
   * @param {ToolContext} [toolContext]
   */
  async function archiveThread(args, toolContext = {}) {
    const threadId = optionalString(args.threadId).trim() || optionalString(toolContext.callerContext?.threadId).trim();
    if (!threadId) {
      throw new AgentLinkError("invalid_arguments", "threadId is required when caller thread context is unavailable.", {
        details: { errors: [{ path: "threadId", rule: "required", expected: "string (no caller thread context)" }] }
      });
    }
    const reason = optionalString(args.reason).trim();
    const loadedCheck = await checkLoadedForArchive(threadId, {
      useLocalFallback: args.useLocalFallback
    });

    if (loadedCheck.checked) {
      try {
        const archive = await archiveThreadViaAppServer(threadId);
        const action = archive.alreadyArchived ? "already_archived" : "app_server_archive";
        return await buildArchiveThreadResult({
          source: "app-server",
          action,
          threadId,
          reason,
          loadedCheck,
          archive,
          args,
          toolContext
        });
      } catch (error) {
        if (loadedCheck.loaded && args.forceLoaded !== true) {
          error.details = {
            ...(error.details ?? {}),
            loadedCheck,
            stateSemantics: loadedStateSemantics(),
            hint: "Native app-server archive failed while the thread was loaded; refusing local fallback without forceLoaded=true."
          };
          throw error;
        }
      }
    }

    if (loadedCheck.loaded && args.forceLoaded !== true) {
      throw new AgentLinkError("active_turn_conflict", `Thread ${threadId} is currently loaded; refusing to archive without forceLoaded=true.`, {
        details: { status: "loaded", activeTurnId: null, loadedCheck },
        hint: "Ask the active thread to finish or switch away before archiving, or set forceLoaded=true only when you intentionally accept that risk."
      });
    }

    const archive = await archiveLocalThread(threadId);
    const action = archive.alreadyArchived ? "already_archived" : "local_archive_moved";
    return await buildArchiveThreadResult({
      source: "local-jsonl",
      action,
      threadId,
      reason,
      loadedCheck,
      archive,
      args,
      toolContext
    });
  }

  /**
   * @param {string} threadId
   * @returns {Promise<ArchiveMove & {ok: true, source: "app-server", threadId: string, codexHome: string | null}>}
   */
  async function archiveThreadViaAppServer(threadId) {
    const before = await readArchiveSnapshot(threadId);
    let response;
    let rolloutGone = false;
    try {
      response = await appServer.request("thread/archive", { threadId });
    } catch (error) {
      // B7 spike: archiving an archived thread fails with -32600 "no rollout
      // found for thread id". So does an id that never existed: only a
      // thread Agent Link can still find (app-server read, or its transcript
      // on disk, archived ones included) counts as already archived.
      if (!isAlreadyArchivedError(error)) throw error;
      if (!before) {
        throw new AgentLinkError("not_found", `No Codex thread has id ${JSON.stringify(threadId).slice(0, 80)}.`, {
          details: { id: threadId, candidates: [] },
          hint: "Call list_codex_threads (archiveScope: \"all\") to find the thread."
        });
      }
      response = null;
      rolloutGone = true;
    }
    const after = await readArchiveSnapshot(threadId);
    return {
      ok: true,
      source: "app-server",
      response,
      threadId,
      alreadyArchived: rolloutGone || before?.archiveState?.scope === "archived",
      from: before?.path ?? null,
      to: after?.path ?? null,
      thread: after ?? before ?? { id: threadId, status: { type: "unknown" } },
      archiveStateBefore: before?.archiveState ?? null,
      archiveStateAfter: after?.archiveState ?? null,
      codexHome: appServer.getConnectionSummary().codexHome ?? null
    };
  }

  // Prefer the app-server's view. Look on disk only when the app-server cannot
  // read the thread or does not report its transcript path, and then by
  // filename rather than by scanning transcripts.
  /**
   * @param {string} threadId
   */
  async function readArchiveSnapshot(threadId) {
    let fromAppServer = null;
    try {
      const read = await appServer.request("thread/read", { threadId, includeTurns: false });
      fromAppServer = summarizeThread(read.thread);
    } catch {
      fromAppServer = null;
    }
    if (fromAppServer?.path) {
      return fromAppServer;
    }
    if (fromAppServer) {
      const located = await findLocalThreadFile(threadId).catch(() => null);
      return located
        ? { ...fromAppServer, path: located.file, archiveState: inferArchiveState(located.file) }
        : fromAppServer;
    }
    try {
      const local = await readLocalThread(threadId);
      return summarizeThread(local.thread);
    } catch {
      return null;
    }
  }

  /**
   * @param {{source: string, action: string, threadId: string, reason: string, loadedCheck: LoadedCheck, archive: ArchiveMove, args: Record<string, any>, toolContext: ToolContext}} options
   */
  async function buildArchiveThreadResult({ source, action, threadId, reason, loadedCheck, archive, args, toolContext }) {
    const appServerSummary = appServer.getConnectionSummary();
    /** @type {Record<string, any>} */
    const result = {
      ok: true,
      source,
      action,
      threadId,
      reason: reason || null,
      loadedCheck,
      archive,
      stateSemantics: loadedStateSemantics(),
      appServer: appServerSummary
    };

    result.receipt = await recordActionReceipt({
      action: "archive_thread",
      receipt: args.receipt,
      target: {
        threadId,
        turnId: null,
        name: archive.thread.name,
        cwd: archive.thread.cwd,
        archiveState: archive.archiveStateAfter,
        status: archive.thread.status,
        deepLink: codexThreadDeepLink(threadId)
      },
      message: reason || null,
      finalResponse: null,
      delivery: {
        state: action,
        action: "archive_thread",
        from: archive.from,
        to: archive.to,
        loadedCheck
      },
      evidence: archiveReceiptEvidence({ loadedCheck, archive, action }),
      replyConfirmation: null,
      runtimeCallerContext: toolContext.callerContext,
      appServer: appServerSummary
    });

    return result;
  }

  /**
   * @param {string} threadId
   * @param {{useLocalFallback?: boolean}} [args]
   * @returns {Promise<LoadedCheck>}
   */
  async function checkLoadedForArchive(threadId, args = {}) {
    try {
      const response = await appServer.request("thread/loaded/list", { limit: 1000 });
      const loadedThreadIds = extractLoadedThreadIds(response);
      return {
        ok: true,
        source: "app-server",
        checked: true,
        loaded: loadedThreadIds.includes(threadId),
        loadedThreadIds,
        appServer: appServer.getConnectionSummary()
      };
    } catch (error) {
      if (args.useLocalFallback === false) {
        throw error;
      }
      return {
        ok: false,
        source: "app-server",
        checked: false,
        loaded: null,
        error: error.message,
        fallback: "local-jsonl",
        appServer: appServer.getConnectionSummary(),
        note: "App-server loaded-state check was unavailable; proceeding because useLocalFallback was not false."
      };
    }
  }

  return { launchThread, launchThreadTool, archiveThread, archiveThreadTool };
}

/**
 * The app-server's answer to thread/archive on a thread that is already
 * archived (B7 spike, codex-cli 0.159.2): JSON-RPC -32600 "no rollout found
 * for thread id ...".
 * @param {unknown} error
 */
export function isAlreadyArchivedError(error) {
  const e = /** @type {any} */ (error);
  return e?.code === -32600 && /no rollout found/i.test(String(e?.message ?? ""));
}
