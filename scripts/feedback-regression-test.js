#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  extractRuntimeCallerContext
} from "../src/shared/caller-context.js";
import {
  appendReceipt,
  buildReceipt,
  listReceipts,
  receiptIndexSummary
} from "../src/shared/receipt-index.js";
import {
  archiveLocalThread,
  readLocalThread
} from "../src/codex/session-index.js";
import {
  activeTurnWarning,
  analyzeThreadWaitState,
  buildStateContract,
  classifySidebarMembership,
  extractFinalResponse,
  normalizeSidebarStateResponse,
  rankThreadSummaries,
  suggestThreadIds
} from "../src/codex/thread-utils.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempHome = await mkdtemp(path.join(os.tmpdir(), "codex-agent-link-feedback-"));

try {
  await writeSession({
    root: tempHome,
    archived: false,
    id: "4ae8408d-a7da-7e0f-9c66-c434c07d7c6c",
    name: "Agent Link Feedback",
    user: "Can we make meaningful improvements to the plugin?",
    assistant: "The core capability is useful."
  });
  await writeSession({
    root: tempHome,
    archived: true,
    id: "4ae84b56-ed41-76eb-a4a4-e4681764e75a",
    name: "Wait - Post-Pulse Idempotency Check",
    user: "Automation: Pulse Cliff Notes Builder\nAutomation ID: pulse-cliff-notes-builder",
    assistant: "Pulse cleanup report complete."
  });
  await writeSession({
    root: tempHome,
    archived: false,
    id: "4ae84030-27a1-799b-bbf6-9301b8c60ffc",
    name: "Link Receipts",
    user: "Reply exactly: Follow-up WF final response confirmed.",
    assistant: "Follow-up WF final response confirmed."
  });
  await writeSession({
    root: tempHome,
    archived: false,
    id: "4ae8454f-22c7-7c34-a0f7-6791625b4161",
    extraSessionMetaId: "4ae84ef2-2781-774f-aee0-5776813eb9ae",
    name: "AnteChamber",
    user: "Automation: ChatGPT Pulse View Check",
    assistant: "AnteChamber idle."
  });
  await writeSession({
    root: tempHome,
    archived: false,
    id: "4ae83149-19f2-734f-8139-0be29c908409",
    name: "Archive Helper Target",
    user: "Archive this helper fixture.",
    assistant: "Ready for archive."
  });
  await writeSession({
    root: tempHome,
    archived: false,
    id: "4ae83140-2edc-7214-8cbf-c637c149ef5c",
    name: "Archive MCP Target",
    user: "Archive this MCP fixture.",
    assistant: "Ready for archive."
  });
  for (let index = 0; index < 230; index += 1) {
    await writeSession({
      root: tempHome,
      archived: index % 2 === 0,
      id: `019d0000-0000-7000-8000-${String(index).padStart(12, "0")}`,
      name: `Distractor ${index}`,
      user: `Distractor thread ${index}`,
      assistant: "No match."
    });
  }

  const ranked = rankThreadSummaries([
    {
      id: "4ae84b56-ed41-76eb-a4a4-e4681764e75a",
      name: "Wait - Post-Pulse Idempotency Check",
      preview: "Automation: Pulse Cliff Notes Builder",
      updatedAt: "2026-05-03T13:01:51.000Z",
      archiveState: { scope: "archived" }
    }
  ], "Pulse Cliff Notes Builder", 5);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].match.reasons[0].field, "preview");

  const suggestions = suggestThreadIds([
    {
      id: "4ae8454f-22c7-7c34-a0f7-6791625b4161",
      name: "AnteChamber",
      preview: "Automation: ChatGPT Pulse View Check",
      archiveState: { scope: "active" }
    }
  ], "4ae8454f-22c7-7c34-a0f4-6791625b4161");
  assert.equal(suggestions[0].id, "4ae8454f-22c7-7c34-a0f7-6791625b4161");

  const warning = activeTurnWarning({ type: "active" }, "start_turn");
  assert.equal(warning.code, "target-active-or-waiting-turn");
  const state = buildStateContract({
    action: "resumed+started_turn",
    initialThread: { status: { type: "notLoaded" }, path: "/tmp/.codex/archived_sessions/x.jsonl" },
    beforeSendThread: { status: { type: "idle" }, path: "/tmp/.codex/archived_sessions/x.jsonl" },
    turn: { id: "turn-1", status: "inProgress" },
    appServer: { managed: true }
  });
  assert.equal(state.archiveState.initial.scope, "archived");
  assert.equal(state.desktopVisibility.controlledByAgentLink, false);
  assert.match(state.desktopVisibility.note, /rendererSidebarModel/);

  const sidebarState = normalizeSidebarStateResponse({
    authority: "rendererSidebarModel",
    modelVersion: 1,
    generatedAt: "2026-05-18T12:00:00.000Z",
    selectedThreadKey: "local:019df300-0000-7000-8000-in-sidebar",
    settings: { organizeMode: "project", sortKey: "updated_at" },
    sections: [
      { key: "threads", collapsed: false, itemKeys: ["local:019df300-0000-7000-8000-in-sidebar"] }
    ],
    items: [
      {
        key: "local:019df300-0000-7000-8000-in-sidebar",
        kind: "local",
        threadId: "019df300-0000-7000-8000-in-sidebar",
        title: "Visible"
      }
    ],
    indexes: {
      localThreadIds: ["019df300-0000-7000-8000-in-sidebar"],
      navigationThreadKeys: ["local:019df300-0000-7000-8000-in-sidebar"],
      visibleSidebarSectionKeys: ["threads"]
    },
    reason: null
  });
  assert.equal(sidebarState.ok, true);
  assert.equal(sidebarState.supported, true);
  assert.equal(sidebarState.authority, "rendererSidebarModel");
  assert.equal(sidebarState.selectedThreadKey, "local:019df300-0000-7000-8000-in-sidebar");
  assert.equal(sidebarState.selectedLocalThreadId, "019df300-0000-7000-8000-in-sidebar");
  assert.equal(sidebarState.localThreadIds.length, 1);
  assert.equal(
    classifySidebarMembership("019df300-0000-7000-8000-in-sidebar", sidebarState),
    "in_sidebar_model"
  );
  assert.equal(
    classifySidebarMembership("019df300-0000-7000-8000-background-only", sidebarState),
    "background_only"
  );

  const unsupportedSidebarState = normalizeSidebarStateResponse({
    authority: "unsupported",
    unsupported: true,
    reason: "Desktop sidebar model state is not available in this host."
  });
  assert.equal(unsupportedSidebarState.ok, true);
  assert.equal(unsupportedSidebarState.supported, false);
  assert.equal(unsupportedSidebarState.unsupported.reason, "Desktop sidebar model state is not available in this host.");
  assert.equal(
    classifySidebarMembership("019df300-0000-7000-8000-background-only", unsupportedSidebarState),
    "unknown"
  );
  assert.equal(
    classifySidebarMembership("019df300-0000-7000-8000-background-only", null),
    "unknown"
  );

  const response = extractFinalResponse({
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [
          { type: "agentMessage", text: "Done.", phase: "final" }
        ]
      }
    ]
  }, "turn-1");
  assert.equal(response.text, "Done.");
  const assistantResponse = extractFinalResponse({
    turns: [
      {
        id: "turn-2",
        status: "completed",
        items: [
          { type: "assistantMessage", text: "Also done.", phase: "final" }
        ]
      }
    ]
  }, "turn-2");
  assert.equal(assistantResponse.text, "Also done.");
  const fallbackResponse = extractFinalResponse({
    turns: [
      {
        id: "turn-3",
        status: "completed",
        items: [
          { type: "userMessage", text: "Only the user message is attached to this turn." }
        ]
      },
      {
        id: "turn-4",
        status: "completed",
        items: [
          { type: "agentMessage", text: "Fallback final text.", phase: "final_answer" }
        ]
      }
    ]
  }, "turn-3");
  assert.equal(fallbackResponse.text, "Fallback final text.");
  assert.equal(fallbackResponse.source, "latestTurnFallback");
  assert.equal(fallbackResponse.requestedTurnId, "turn-3");
  const staleActiveWaitState = analyzeThreadWaitState({
    status: { type: "active", activeFlags: ["waitingOnApproval"] },
    turns: [
      {
        id: "turn-blocked",
        status: "inProgress",
        items: [
          { type: "agentMessage", text: "Waiting on approval.", phase: "commentary" }
        ]
      },
      {
        id: "turn-final",
        status: "completed",
        completedAt: "2026-05-04T04:03:23.000Z",
        items: [
          { type: "agentMessage", text: "Finished despite stale status.", phase: "final_answer" }
        ]
      }
    ]
  });
  assert.equal(staleActiveWaitState.shouldContinueWaiting, false);
  assert.equal(staleActiveWaitState.staleTopLevelStatus, true);
  assert.equal(staleActiveWaitState.finalResponse.text, "Finished despite stale status.");
  assert.equal(staleActiveWaitState.warnings[0].code, "stale-top-level-active-status");
  const genuinelyActiveWaitState = analyzeThreadWaitState({
    status: { type: "active" },
    turns: [
      {
        id: "turn-done",
        status: "completed",
        items: [
          { type: "agentMessage", text: "Older final.", phase: "final_answer" }
        ]
      },
      {
        id: "turn-active",
        status: "inProgress",
        items: [
          { type: "userMessage", text: "Still working?" }
        ]
      }
    ]
  });
  assert.equal(genuinelyActiveWaitState.shouldContinueWaiting, true);
  assert.equal(genuinelyActiveWaitState.staleTopLevelStatus, false);

  const runtimeCallerContext = extractRuntimeCallerContext({
    params: {
      _meta: {
        "openai/codex": {
          caller: {
            thread: { id: "019df200-0000-7000-8000-runtime-thread" },
            turn: { id: "019df200-0000-7000-8000-runtime-turn" }
          },
          toolCallId: "call_runtime_context"
        }
      }
    }
  }, {
    requestId: 42,
    sessionId: "session-runtime-test"
  });
  assert.equal(runtimeCallerContext.available, true);
  assert.equal(runtimeCallerContext.threadId, "019df200-0000-7000-8000-runtime-thread");
  assert.equal(runtimeCallerContext.turnId, "019df200-0000-7000-8000-runtime-turn");
  assert.equal(runtimeCallerContext.toolCallId, "call_runtime_context");

  const runtimeReceipt = buildReceipt({
    action: "launch_thread",
    receipt: {
      purpose: "runtime caller context"
    },
    runtimeCallerContext,
    target: {
      threadId: "019df200-0000-7000-8000-target"
    },
    message: null,
    finalResponse: null,
    delivery: null,
    appServer: {}
  });
  assert.equal(runtimeReceipt.origin.threadId, "019df200-0000-7000-8000-runtime-thread");
  assert.equal(runtimeReceipt.origin.turnId, "019df200-0000-7000-8000-runtime-turn");
  assert.equal(runtimeReceipt.origin.toolCallId, "call_runtime_context");
  assert.equal(runtimeReceipt.origin.source, "runtime_context");
  assert.equal(runtimeReceipt.origin.runtime.requestId, "42");

  const mixedReceipt = buildReceipt({
    action: "launch_thread",
    receipt: {
      purpose: "mixed caller context",
      originThreadId: "019df200-0000-7000-8000-caller-thread"
    },
    runtimeCallerContext,
    target: {
      threadId: "019df200-0000-7000-8000-target"
    },
    message: null,
    finalResponse: null,
    delivery: null,
    appServer: {}
  });
  assert.equal(mixedReceipt.origin.threadId, "019df200-0000-7000-8000-caller-thread");
  assert.equal(mixedReceipt.origin.turnId, "019df200-0000-7000-8000-runtime-turn");
  assert.equal(mixedReceipt.origin.source, "mixed");
  assert.equal(mixedReceipt.origin.sources.threadId, "caller_supplied");
  assert.equal(mixedReceipt.origin.sources.turnId, "runtime_context");

  const receipt = buildReceipt({
    action: "launch_thread",
    receipt: {
      purpose: "WF verification",
      originThreadId: "4ae8408d-a7da-7e0f-9c66-c434c07d7c6c",
      originTurnId: "4ae840f6-a43b-7cb4-aa06-9917627e25ee",
      originToolCallId: "call_launch_receipt_test",
      cleanupRecommendation: "archiveable",
      note: "Created by regression test",
      tags: ["wf", "receipt"]
    },
    target: {
      threadId: "4ae84030-27a1-799b-bbf6-9301b8c60ffc",
      turnId: "4ae84030-aaec-742f-ade5-6bf010c76858",
      name: "Link Receipts",
      cwd: "/tmp/codex-agent-link",
      deepLink: "codex://threads/4ae84030-27a1-799b-bbf6-9301b8c60ffc"
    },
    message: "Reply exactly: Follow-up WF final response confirmed.",
    finalResponse: "Follow-up WF final response confirmed.",
    delivery: {
      state: "accepted_by_app_server",
      action: "started_thread+started_turn",
      turnId: "4ae84030-aaec-742f-ade5-6bf010c76858"
    },
    replyConfirmation: {
      waited: true,
      ok: true,
      timedOut: false,
      turnStatus: "completed",
      finalResponse: "Follow-up WF final response confirmed."
    },
    appServer: {
      kind: "managed",
      managed: true,
      connected: true,
      codexHome: tempHome,
      platformOs: "macos"
    }
  });
  // Its own receipt log: never the inherited AGENT_LINK_RECEIPT_LOG or ~/.agent-link.
  const receiptLog = path.join(tempHome, "receipts.jsonl");
  const appended = await appendReceipt(receipt, { path: receiptLog });
  assert.equal(appended.ok, true);
  assert.equal(appended.path, receiptLog);
  assert.equal(receiptIndexSummary({ path: receiptLog }).path, appended.path);
  const receiptsByTarget = await listReceipts({
    path: receiptLog,
    targetThreadId: "4ae84030-27a1-799b-bbf6-9301b8c60ffc",
    limit: 5
  });
  assert.equal(receiptsByTarget.data.length, 1);
  assert.equal(receiptsByTarget.data[0].origin.threadId, "4ae8408d-a7da-7e0f-9c66-c434c07d7c6c");
  assert.equal(receiptsByTarget.data[0].cleanupRecommendation, "archiveable");
  assert.equal(receiptsByTarget.data[0].replyConfirmation.ok, true);
  const receiptsBySearch = await listReceipts({
    path: receiptLog,
    searchTerm: "Created by regression test"
  });
  assert.equal(receiptsBySearch.data[0].target.name, "Link Receipts");

  const previousThreadIdEnv = process.env.CODEX_THREAD_ID;
  const previousTurnIdEnv = process.env.CODEX_TURN_ID;
  process.env.CODEX_THREAD_ID = "019df000-0000-7000-8000-auto-origin";
  process.env.CODEX_TURN_ID = "019df000-0000-7000-8000-auto-turn";
  try {
    const inferredReceipt = buildReceipt({
      action: "launch_thread",
      receipt: {
        purpose: "auto origin inference"
      },
      target: {
        threadId: "019df000-0000-7000-8000-target"
      },
      message: null,
      finalResponse: null,
      delivery: null,
      appServer: {}
    });
    assert.equal(inferredReceipt.origin.threadId, "019df000-0000-7000-8000-auto-origin");
    assert.equal(inferredReceipt.origin.turnId, "019df000-0000-7000-8000-auto-turn");
    assert.equal(inferredReceipt.origin.source, "environment");
  } finally {
    restoreEnv("CODEX_THREAD_ID", previousThreadIdEnv);
    restoreEnv("CODEX_TURN_ID", previousTurnIdEnv);
  }

  const archived = await archiveLocalThread("4ae83149-19f2-734f-8139-0be29c908409", { codexHome: tempHome });
  assert.equal(archived.ok, true);
  assert.equal(archived.alreadyArchived, false);
  assert.match(archived.from, /\/sessions\//);
  assert.match(archived.to, /\/archived_sessions\//);
  assert.equal(archived.archiveStateBefore.scope, "active");
  assert.equal(archived.archiveStateAfter.scope, "archived");
  const archivedRead = await readLocalThread("4ae83149-19f2-734f-8139-0be29c908409", { codexHome: tempHome });
  assert.equal(archivedRead.thread.archiveState.scope, "archived");
  const archivedAgain = await archiveLocalThread("4ae83149-19f2-734f-8139-0be29c908409", { codexHome: tempHome });
  assert.equal(archivedAgain.alreadyArchived, true);

  const client = new Client({ name: "codex-agent-link-feedback-regression", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./src/server.js"],
    cwd: pluginRoot,
    env: {
      ...process.env,
      HOME: tempHome,
      CODEX_HOME: tempHome,
      AGENT_LINK_STATE_DIR: path.join(tempHome, ".agent-link"),
      AGENT_LINK_RECEIPT_LOG: receiptLog,
      AGENT_LINK_MAILBOX_PATH: path.join(tempHome, "mailbox.jsonl"),
      AGENT_LINK_CODEX_URL: "",
      AGENT_LINK_CODEX_SOCK: "",
      AGENT_LINK_CODEX_APP_SERVER_BIN: "",
      CODEX_AGENT_LINK_AUTOSTART: "0",
      CODEX_AGENT_LINK_URL: "",
      CODEX_APP_SERVER_URL: "",
      CODEX_AGENT_LINK_SOCK: "",
      CODEX_APP_SERVER_SOCK: "",
      CODEX_AGENT_LINK_APP_SERVER_BIN: "",
      CODEX_APP_SERVER_BIN: ""
    }
  });

  try {
    await client.connect(transport);
    const health = await client.callTool({
      name: "agent_link_health",
      arguments: {
        startAppServer: false,
        includeCallerContext: true
      }
    });
    assert.equal(health.isError, false);
    const healthPayload = JSON.parse(health.content[0].text);
    assert.match(healthPayload.callerContextContract.precedence[1], /MCP tools\/call runtime metadata/);
    assert.equal(healthPayload.callerContext.available, false);

    const runtimeHealth = await client.callTool({
      name: "agent_link_health",
      _meta: {
        "openai/codex": {
          callerThreadId: "019df201-0000-7000-8000-runtime-thread",
          callerTurnId: "019df201-0000-7000-8000-runtime-turn",
          callerToolCallId: "call_runtime_health"
        }
      },
      arguments: {
        startAppServer: false,
        includeCallerContext: true
      }
    });
    assert.equal(runtimeHealth.isError, false);
    const runtimeHealthPayload = JSON.parse(runtimeHealth.content[0].text);
    assert.equal(runtimeHealthPayload.callerContext.available, true);
    assert.equal(runtimeHealthPayload.callerContext.threadId, "019df201-0000-7000-8000-runtime-thread");
    assert.equal(runtimeHealthPayload.callerContext.turnId, "019df201-0000-7000-8000-runtime-turn");
    assert.equal(runtimeHealthPayload.callerContext.toolCallId, "call_runtime_health");

    const list = await client.callTool({
      name: "list_codex_threads",
      arguments: {
        archiveScope: "all",
        searchTerm: "Pulse Cliff Notes Builder",
        limit: 5
      }
    });
    assert.equal(list.isError, false);
    const listPayload = JSON.parse(list.content[0].text);
    assert.equal(listPayload.data[0].archiveState.scope, "archived");
    assert.equal(listPayload.data[0].match.reasons[0].field, "preview");

    const resolved = await client.callTool({
      name: "resolve_codex_thread",
      arguments: {
        query: "Pulse Cliff Notes Builder",
        limit: 3
      }
    });
    assert.equal(resolved.isError, false);
    const resolvedPayload = JSON.parse(resolved.content[0].text);
    assert.equal(resolvedPayload.best.id, "4ae84b56-ed41-76eb-a4a4-e4681764e75a");
    assert.equal(resolvedPayload.selection.bestId, "4ae84b56-ed41-76eb-a4a4-e4681764e75a");
    assert.match(resolvedPayload.selection.strategy, /highest match score/);

    const missing = await client.callTool({
      name: "get_codex_thread",
      arguments: {
        threadId: "4ae84b56-ed41-76eb-a4a4-e4681764e757"
      }
    });
    assert.equal(missing.isError, true);
    const missingPayload = JSON.parse(missing.content[0].text);
    assert.equal(missingPayload.details.didYouMean[0].id, "4ae84b56-ed41-76eb-a4a4-e4681764e75a");

    const missingAnteChamber = await client.callTool({
      name: "get_codex_thread",
      arguments: {
        threadId: "4ae8454f-22c7-7c34-a0f4-6791625b4161"
      }
    });
    assert.equal(missingAnteChamber.isError, true);
    const missingAnteChamberPayload = JSON.parse(missingAnteChamber.content[0].text);
    assert.equal(missingAnteChamberPayload.details.didYouMean[0].id, "4ae8454f-22c7-7c34-a0f7-6791625b4161");

    const receiptList = await client.callTool({
      name: "list_agent_link_receipts",
      arguments: {
        targetThreadId: "4ae84030-27a1-799b-bbf6-9301b8c60ffc"
      }
    });
    assert.equal(receiptList.isError, false);
    const receiptListPayload = JSON.parse(receiptList.content[0].text);
    assert.equal(receiptListPayload.data[0].origin.threadId, "4ae8408d-a7da-7e0f-9c66-c434c07d7c6c");

    const receiptThread = await client.callTool({
      name: "get_codex_thread",
      arguments: {
        threadId: "4ae84030-27a1-799b-bbf6-9301b8c60ffc",
        includeReceipts: true
      }
    });
    assert.equal(receiptThread.isError, false);
    const receiptThreadPayload = JSON.parse(receiptThread.content[0].text);
    assert.equal(receiptThreadPayload.thread.id, "4ae84030-27a1-799b-bbf6-9301b8c60ffc");
    assert.equal(receiptThreadPayload.agentLinkReceipts.data[0].purpose, "WF verification");

    const archivedByTool = await client.callTool({
      name: "archive_codex_thread",
      arguments: {
        threadId: "4ae83140-2edc-7214-8cbf-c637c149ef5c",
        reason: "Regression cleanup fixture",
        receipt: {
          purpose: "archive regression",
          originThreadId: "4ae8408d-a7da-7e0f-9c66-c434c07d7c6c",
          cleanupRecommendation: "archiveable",
          tags: ["cleanup", "regression"]
        }
      }
    });
    assert.equal(archivedByTool.isError, false);
    const archivedByToolPayload = JSON.parse(archivedByTool.content[0].text);
    assert.equal(archivedByToolPayload.archive.archiveStateAfter.scope, "archived");
    assert.equal(archivedByToolPayload.receipt.recorded, true);
    assert.equal(archivedByToolPayload.loadedCheck.checked, false);
    assert.equal(archivedByToolPayload.receipt.receipt.evidence.loadedThreadGuard.status, "loaded_thread_guard_unchecked");
    assert.match(archivedByToolPayload.receipt.receipt.evidence.interpretation, /loadedThreadGuard is the primary active-safety evidence/);

    const archiveReceipts = await client.callTool({
      name: "list_agent_link_receipts",
      arguments: {
        targetThreadId: "4ae83140-2edc-7214-8cbf-c637c149ef5c",
        action: "archive_thread"
      }
    });
    assert.equal(archiveReceipts.isError, false);
    const archiveReceiptsPayload = JSON.parse(archiveReceipts.content[0].text);
    assert.equal(archiveReceiptsPayload.data[0].action, "archive_thread");
    assert.equal(archiveReceiptsPayload.data[0].origin.threadId, "4ae8408d-a7da-7e0f-9c66-c434c07d7c6c");
    assert.equal(archiveReceiptsPayload.data[0].evidence.loadedThreadGuard.checked, false);
    assert.equal(archiveReceiptsPayload.data[0].evidence.archiveMove.after.scope, "archived");
    assert.match(archiveReceiptsPayload.data[0].evidence.interpretation, /target.status may come from local JSONL/);
  } finally {
    await client.close();
  }

  console.log("Feedback regression test passed");
} finally {
  await rm(tempHome, { recursive: true, force: true });
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function writeSession({ root, archived, id, extraSessionMetaId, name, user, assistant }) {
  const dir = path.join(root, archived ? "archived_sessions" : "sessions", "2026", "05", "03");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${id}.jsonl`);
  const records = [
    {
      timestamp: "2026-05-03T13:00:00.000Z",
      type: "session_meta",
      payload: {
        id,
        timestamp: "2026-05-03T13:00:00.000Z",
        cwd: "/tmp/codex-agent-link",
        source: "test",
        cli_version: "0.128.0-alpha.1",
        model_provider: "openai"
      }
    }
  ];
  if (extraSessionMetaId) {
    records.push({
      timestamp: "2026-05-03T13:00:00.001Z",
      type: "session_meta",
      payload: {
        id: extraSessionMetaId,
        timestamp: "2026-05-03T12:00:00.000Z",
        cwd: "/tmp/parent-thread",
        source: "test",
        cli_version: "0.128.0-alpha.1",
        model_provider: "openai"
      }
    });
  }
  records.push(
    {
      timestamp: "2026-05-03T13:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: name ? `${name}\n${user}` : user
      }
    },
    {
      timestamp: "2026-05-03T13:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: assistant
      }
    }
  );
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}
