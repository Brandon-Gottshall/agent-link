#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installedPluginRoot = process.env.AGENT_LINK_INSTALLED_PLUGIN_ROOT
  ? path.resolve(process.env.AGENT_LINK_INSTALLED_PLUGIN_ROOT)
  : null;

const args = parseArgs(process.argv.slice(2));
const suitePath = path.resolve(process.cwd(), args.suite ?? "./wf/agent-link/suite.json");
const pluginRoot = path.resolve(args.pluginRoot ?? runnerRoot);
const live = args.live === true;
const runId = [
  new Date().toISOString().replace(/[:.]/g, "-"),
  live ? "live" : "dry",
  pluginRootLabel(pluginRoot),
  `pid${process.pid}`,
  crypto.randomUUID().slice(0, 8)
].join("-");

const suite = await readJson(suitePath);
validateSuite(suite);

if (live && process.env.CODEX_AGENT_LINK_WF_LIVE !== "1") {
  throw new Error("Live WF runs require CODEX_AGENT_LINK_WF_LIVE=1.");
}

const run = {
  runId,
  suiteId: suite.suiteId,
  title: suite.title,
  mode: live ? "live" : "dry",
  startedAt: new Date().toISOString(),
  completedAt: null,
  pluginRoot,
  suitePath,
  status: "running",
  toolCheck: null,
  scenarios: [],
  warnings: []
};

let client = null;
try {
  client = await connectMcp(pluginRoot, { live });
  run.toolCheck = await verifyRequiredTools(client, suite.requiredTools);
  if (run.toolCheck.status !== "pass") {
    throw new Error(`Missing required MCP tools: ${run.toolCheck.missingTools.join(", ")}`);
  }

  if (live) {
    run.scenarios.push(...await runLiveScenarios(client, suite));
  } else {
    run.scenarios.push(...await runDryScenarios(suite));
  }

  run.status = overallStatus(run.scenarios);
} catch (error) {
  run.status = "fail";
  run.error = {
    message: error.message,
    stack: error.stack
  };
} finally {
  if (client) {
    await client.close().catch(() => {});
  }
  run.completedAt = new Date().toISOString();
  const reports = await writeReports(run);
  run.reportFiles = reports;
}

if (run.status === "pass") {
  console.log(`Agent WF ${run.mode} passed; report=${run.reportFiles.markdown}`);
} else {
  console.error(`Agent WF ${run.mode} ${run.status}; report=${run.reportFiles.markdown}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live") {
      parsed.live = true;
    } else if (arg === "--suite") {
      parsed.suite = requiredArg(argv, ++i, "--suite");
    } else if (arg === "--plugin-root") {
      parsed.pluginRoot = requiredArg(argv, ++i, "--plugin-root");
    } else if (arg === "--installed-plugin-root") {
      if (!installedPluginRoot) {
        throw new Error("--installed-plugin-root needs AGENT_LINK_INSTALLED_PLUGIN_ROOT set to the installed plugin cache directory.");
      }
      parsed.pluginRoot = installedPluginRoot;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requiredArg(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function validateSuite(candidate) {
  assert.equal(typeof candidate.suiteId, "string", "suiteId is required");
  assert.equal(typeof candidate.title, "string", "title is required");
  assert.ok(Array.isArray(candidate.requiredTools), "requiredTools must be an array");
  assert.ok(candidate.requiredTools.length > 0, "requiredTools must not be empty");
  assert.ok(Array.isArray(candidate.scenarios), "scenarios must be an array");
  assert.ok(candidate.scenarios.length > 0, "scenarios must not be empty");
  const ids = new Set();
  for (const scenario of candidate.scenarios) {
    assert.equal(typeof scenario.id, "string", "scenario.id is required");
    assert.equal(typeof scenario.type, "string", `${scenario.id}.type is required`);
    assert.ok(!ids.has(scenario.id), `duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (scenario.type === "live_positive") {
      assert.equal(typeof scenario.promptTemplate, "string", `${scenario.id}.promptTemplate is required`);
      assert.equal(typeof scenario.dependencyName, "string", `${scenario.id}.dependencyName is required`);
      assert.ok(Array.isArray(scenario.requiredToolCalls), `${scenario.id}.requiredToolCalls must be an array`);
    } else if (scenario.type === "live_negative") {
      assert.equal(typeof scenario.prompt, "string", `${scenario.id}.prompt is required`);
      assert.ok(Array.isArray(scenario.forbiddenToolCalls), `${scenario.id}.forbiddenToolCalls must be an array`);
    } else if (scenario.type === "fixture") {
      assert.equal(typeof scenario.fixture, "string", `${scenario.id}.fixture is required`);
    } else {
      throw new Error(`Unsupported scenario type ${scenario.type} for ${scenario.id}`);
    }
  }
}

async function connectMcp(root, options = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./src/server.js"],
    cwd: root,
    env: {
      ...process.env,
      CODEX_AGENT_LINK_AUTOSTART: options.live ? "1" : "0"
    }
  });
  const mcpClient = new Client({ name: "codex-agent-link-agent-wf", version: "0.1.0" });
  await mcpClient.connect(transport);
  return mcpClient;
}

async function verifyRequiredTools(mcpClient, requiredTools) {
  const listed = await mcpClient.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const missing = requiredTools.filter((name) => !names.includes(name));
  return {
    status: missing.length === 0 ? "pass" : "fail",
    requiredTools,
    foundTools: names,
    missingTools: missing
  };
}

async function runDryScenarios(currentSuite) {
  const results = [];
  for (const scenario of currentSuite.scenarios) {
    if (scenario.type !== "fixture") {
      results.push({
        id: scenario.id,
        title: scenario.title,
        type: scenario.type,
        status: "not_applicable",
        outcome: "live scenario skipped in dry mode",
        failureCodes: [],
        evidence: {}
      });
      continue;
    }
    const fixturePath = path.resolve(path.dirname(suitePath), scenario.fixture);
    const fixture = await readJson(fixturePath);
    const caseResults = [];
    for (const fixtureCase of fixture.cases ?? []) {
      const verdict = evaluateFixtureCase(fixtureCase);
      const expectationFailureCodes = fixtureCase.expectedFailureCodes ?? [];
      const expectedCodesPresent = expectationFailureCodes.every((code) => verdict.failureCodes.includes(code));
      const expectationMet = verdict.status === fixtureCase.expectedStatus && expectedCodesPresent;
      caseResults.push({
        ...verdict,
        expectedStatus: fixtureCase.expectedStatus,
        expectedFailureCodes: expectationFailureCodes,
        expectationMet
      });
    }
    const failedExpectations = caseResults.filter((result) => !result.expectationMet);
    results.push({
      id: scenario.id,
      title: scenario.title,
      type: scenario.type,
      status: failedExpectations.length === 0 ? "pass" : "fail",
      outcome: `${caseResults.length} fixture cases evaluated`,
      failureCodes: failedExpectations.length === 0 ? [] : ["fixture_expectation_failed"],
      evidence: {
        fixturePath,
        cases: caseResults
      }
    });
  }
  return results;
}

function evaluateFixtureCase(fixtureCase) {
  if (fixtureCase.behavior === "positive") {
    return evaluatePositive({
      id: fixtureCase.id,
      threadPayload: fixtureCase.thread,
      receiptsPayload: fixtureCase.receipts,
      originThreadId: fixtureCase.originThreadId,
      targetThreadId: fixtureCase.targetThreadId,
      requiredToolCalls: fixtureCase.requiredToolCalls ?? [],
      timedOut: fixtureCase.timedOut === true
    });
  }
  if (fixtureCase.behavior === "negative") {
    return evaluateNegative({
      id: fixtureCase.id,
      threadPayload: fixtureCase.thread,
      receiptsPayload: fixtureCase.receipts,
      originThreadId: fixtureCase.originThreadId,
      forbiddenToolCalls: fixtureCase.forbiddenToolCalls ?? [],
      timedOut: fixtureCase.timedOut === true
    });
  }
  throw new Error(`Unsupported fixture behavior for ${fixtureCase.id}: ${fixtureCase.behavior}`);
}

async function runLiveScenarios(mcpClient, currentSuite) {
  const results = [];
  for (const scenario of currentSuite.scenarios) {
    if (scenario.type === "fixture") {
      continue;
    }
    if (scenario.type === "live_positive") {
      results.push(await runLivePositive(mcpClient, currentSuite, scenario));
    } else if (scenario.type === "live_negative") {
      results.push(await runLiveNegative(mcpClient, currentSuite, scenario));
    }
  }
  return results;
}

async function runLivePositive(mcpClient, currentSuite, scenario) {
  const createdThreads = [];
  const scenarioCwd = scenarioCwdFor(currentSuite, scenario);
  const gitBefore = await gitStatus(scenarioCwd);
  let cleanup = [];
  try {
    const targetLaunch = await callJson(mcpClient, "launch_codex_thread", {
      name: `${scenario.targetThreadName} ${runId}`,
      cwd: scenarioCwd,
      ephemeral: false,
      openInGui: false,
      receipt: {
        purpose: `WF target for ${scenario.id}`,
        cleanupRecommendation: "archiveable",
        tags: ["wf-agent-link", scenario.id, "dependency-target"]
      }
    });
    const targetThreadId = targetLaunch.thread.id;
    createdThreads.push(targetThreadId);

    const prompt = scenario.promptTemplate
      .replaceAll("{{targetThreadId}}", targetThreadId)
      .replaceAll("{{dependencyName}}", scenario.dependencyName);
    const originLaunch = await callJson(mcpClient, "launch_codex_thread", {
      name: `${scenario.originThreadName} ${runId}`,
      cwd: scenarioCwd,
      ephemeral: false,
      openInGui: false,
      message: prompt,
      receipt: {
        purpose: `WF origin for ${scenario.id}`,
        cleanupRecommendation: "archiveable",
        tags: ["wf-agent-link", scenario.id, "dependency-origin"]
      }
    });
    const originThreadId = originLaunch.thread.id;
    createdThreads.push(originThreadId);

    const wait = await pollThread(mcpClient, originThreadId, {
      timeoutMs: scenario.timeoutMs ?? currentSuite.defaults?.timeoutMs,
      pollIntervalMs: scenario.pollIntervalMs ?? currentSuite.defaults?.pollIntervalMs
    });
    const receiptsPayload = await callJson(mcpClient, "list_agent_link_receipts", {
      originThreadId,
      action: "message_thread",
      searchTerm: "dependency-handoff",
      limit: 20
    });
    const verdict = evaluatePositive({
      id: scenario.id,
      threadPayload: wait.threadPayload,
      receiptsPayload,
      originThreadId,
      targetThreadId,
      requiredToolCalls: scenario.requiredToolCalls,
      timedOut: wait.timedOut
    });
    const gitAfter = await gitStatus(scenarioCwd);
    const gitFailure = gitMutationFailure(gitBefore, gitAfter);
    if (gitFailure) {
      verdict.failureCodes.push(gitFailure.code);
      verdict.status = "fail";
    }
    verdict.evidence = {
      ...verdict.evidence,
      targetThreadId,
      originThreadId,
      prompt,
      gitBefore,
      gitAfter,
      gitFailure
    };
    cleanup = await cleanupThreads(mcpClient, createdThreads, scenario.id);
    return {
      id: scenario.id,
      title: scenario.title,
      type: scenario.type,
      ...verdict,
      cleanup
    };
  } catch (error) {
    cleanup = await cleanupThreads(mcpClient, createdThreads, scenario.id);
    return {
      id: scenario.id,
      title: scenario.title,
      type: scenario.type,
      status: "fail",
      failureCodes: ["scenario_error"],
      outcome: error.message,
      evidence: { stack: error.stack, createdThreads },
      cleanup
    };
  }
}

async function runLiveNegative(mcpClient, currentSuite, scenario) {
  const createdThreads = [];
  const scenarioCwd = scenarioCwdFor(currentSuite, scenario);
  const gitBefore = await gitStatus(scenarioCwd);
  let cleanup = [];
  try {
    const originLaunch = await callJson(mcpClient, "launch_codex_thread", {
      name: `${scenario.originThreadName} ${runId}`,
      cwd: scenarioCwd,
      ephemeral: false,
      openInGui: false,
      message: scenario.prompt,
      receipt: {
        purpose: `WF origin for ${scenario.id}`,
        cleanupRecommendation: "archiveable",
        tags: ["wf-agent-link", scenario.id, "negative-origin"]
      }
    });
    const originThreadId = originLaunch.thread.id;
    createdThreads.push(originThreadId);
    const wait = await pollThread(mcpClient, originThreadId, {
      timeoutMs: scenario.timeoutMs ?? currentSuite.defaults?.timeoutMs,
      pollIntervalMs: scenario.pollIntervalMs ?? currentSuite.defaults?.pollIntervalMs
    });
    const receiptsPayload = await callJson(mcpClient, "list_agent_link_receipts", {
      originThreadId,
      action: "message_thread",
      searchTerm: "dependency-handoff",
      limit: 20
    });
    const verdict = evaluateNegative({
      id: scenario.id,
      threadPayload: wait.threadPayload,
      receiptsPayload,
      originThreadId,
      forbiddenToolCalls: scenario.forbiddenToolCalls,
      timedOut: wait.timedOut
    });
    const gitAfter = await gitStatus(scenarioCwd);
    const gitFailure = gitMutationFailure(gitBefore, gitAfter);
    if (gitFailure) {
      verdict.failureCodes.push(gitFailure.code);
      verdict.status = "fail";
    }
    verdict.evidence = {
      ...verdict.evidence,
      originThreadId,
      prompt: scenario.prompt,
      gitBefore,
      gitAfter,
      gitFailure
    };
    cleanup = await cleanupThreads(mcpClient, createdThreads, scenario.id);
    return {
      id: scenario.id,
      title: scenario.title,
      type: scenario.type,
      ...verdict,
      cleanup
    };
  } catch (error) {
    cleanup = await cleanupThreads(mcpClient, createdThreads, scenario.id);
    return {
      id: scenario.id,
      title: scenario.title,
      type: scenario.type,
      status: "fail",
      failureCodes: ["scenario_error"],
      outcome: error.message,
      evidence: { stack: error.stack, createdThreads },
      cleanup
    };
  }
}

function evaluatePositive(options) {
  const toolCalls = extractToolCalls(options.threadPayload);
  const finalText = extractFinalText(options.threadPayload);
  const receipts = options.receiptsPayload?.data ?? [];
  const dependencyReceipt = receipts.find((receipt) => dependencyReceiptMatches(receipt, {
    originThreadId: options.originThreadId,
    targetThreadId: options.targetThreadId
  }));
  const failureCodes = [];
  const missingToolCalls = options.requiredToolCalls.filter((tool) => !toolCalls.includes(tool));
  if (options.timedOut) {
    failureCodes.push("timeout_or_stall");
  }
  if (missingToolCalls.length > 0) {
    failureCodes.push("missing_required_tool_call");
  }
  if (!dependencyReceipt) {
    failureCodes.push("missing_dependency_receipt");
  }
  if (!finalText) {
    failureCodes.push("missing_final_answer");
  }
  if (finalText && !/callback wired:/i.test(finalText)) {
    failureCodes.push("missing_callback_wired_final");
  }
  if (dependencyReceipt?.id && finalText && !finalText.includes(dependencyReceipt.id)) {
    failureCodes.push("final_missing_receipt_id");
  }
  return {
    id: options.id,
    status: failureCodes.length === 0 ? "pass" : "fail",
    failureCodes,
    outcome: failureCodes.length === 0
      ? "dependency callback wired and final answer satisfied"
      : `failed: ${failureCodes.join(", ")}`,
    evidence: {
      toolCalls,
      missingToolCalls,
      finalText,
      dependencyReceiptId: dependencyReceipt?.id ?? null,
      receiptCount: receipts.length
    }
  };
}

function evaluateNegative(options) {
  const toolCalls = extractToolCalls(options.threadPayload);
  const finalText = extractFinalText(options.threadPayload);
  const receipts = options.receiptsPayload?.data ?? [];
  const forbiddenCalls = options.forbiddenToolCalls.filter((tool) => toolCalls.includes(tool));
  const dependencyReceipts = receipts.filter((receipt) => dependencyReceiptMatches(receipt, {
    originThreadId: options.originThreadId
  }));
  const failureCodes = [];
  if (options.timedOut) {
    failureCodes.push("timeout_or_stall");
  }
  if (forbiddenCalls.length > 0) {
    failureCodes.push("forbidden_tool_call");
  }
  if (dependencyReceipts.length > 0) {
    failureCodes.push("unexpected_dependency_receipt");
  }
  if (!finalText) {
    failureCodes.push("missing_final_answer");
  }
  return {
    id: options.id,
    status: failureCodes.length === 0 ? "pass" : "fail",
    failureCodes,
    outcome: failureCodes.length === 0
      ? "no dependency callback tools or receipts used"
      : `failed: ${failureCodes.join(", ")}`,
    evidence: {
      toolCalls,
      forbiddenCalls,
      finalText,
      dependencyReceiptIds: dependencyReceipts.map((receipt) => receipt.id),
      receiptCount: receipts.length
    }
  };
}

function extractToolCalls(threadPayload) {
  return flattenItems(threadPayload)
    .filter((item) => item.type === "mcpToolCall")
    .map((item) => item.tool)
    .filter(Boolean);
}

function extractFinalText(threadPayload) {
  const finalMessages = flattenItems(threadPayload)
    .filter((item) => item.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string");
  return finalMessages.at(-1)?.text ?? "";
}

function flattenItems(threadPayload) {
  const turns = threadPayload?.thread?.turns ?? [];
  return turns.flatMap((turn) => turn.items ?? []);
}

function dependencyReceiptMatches(receipt, options = {}) {
  if (!receipt || receipt.action !== "message_thread") {
    return false;
  }
  if (options.originThreadId && receipt.origin?.threadId !== options.originThreadId) {
    return false;
  }
  if (options.targetThreadId && receipt.target?.threadId !== options.targetThreadId) {
    return false;
  }
  const text = [
    ...(receipt.tags ?? []),
    receipt.purpose,
    receipt.messagePreview
  ].filter(Boolean).join("\n").toLowerCase();
  return text.includes("dependency-handoff") || text.includes("dependency callback request");
}

async function pollThread(mcpClient, threadId, options = {}) {
  const timeoutMs = clampNumber(options.timeoutMs ?? 180000, 1000, 600000);
  const pollIntervalMs = clampNumber(options.pollIntervalMs ?? 2500, 500, 30000);
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await readThreadSnapshot(mcpClient, threadId);
    if (isCompletedThread(latest)) {
      return {
        timedOut: false,
        threadPayload: latest
      };
    }
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  latest = await readThreadSnapshot(mcpClient, threadId).catch(() => latest);
  return {
    timedOut: !isCompletedThread(latest),
    threadPayload: latest
  };
}

async function readThreadSnapshot(mcpClient, threadId) {
  return callJson(mcpClient, "get_codex_thread", {
    threadId,
    includeTurns: true,
    recentItems: 100,
    includeReceipts: true,
    receiptLimit: 20
  });
}

function isCompletedThread(threadPayload) {
  const finalText = extractFinalText(threadPayload);
  const threadStatus = threadPayload?.thread?.status?.type;
  const latestTurn = threadPayload?.thread?.turns?.at(-1);
  return Boolean(finalText && (threadStatus === "idle" || latestTurn?.status === "completed"));
}

async function cleanupThreads(mcpClient, threadIds, scenarioId) {
  const results = [];
  for (const threadId of [...threadIds].reverse()) {
    try {
      const archive = await callJson(mcpClient, "archive_codex_thread", {
        threadId,
        reason: `Cleanup disposable Agent Link WF thread for ${scenarioId}`,
        receipt: {
          purpose: `Cleanup WF thread for ${scenarioId}`,
          cleanupRecommendation: "archived",
          tags: ["wf-agent-link", scenarioId, "cleanup"]
        }
      });
      results.push({
        threadId,
        ok: archive.ok !== false,
        action: archive.action,
        archiveState: archive.archive?.archiveStateAfter ?? null
      });
    } catch (error) {
      results.push({
        threadId,
        ok: false,
        error: error.message
      });
    }
  }
  return results;
}

async function callJson(mcpClient, name, toolArgs) {
  const result = await mcpClient.callTool({
    name,
    arguments: toolArgs
  });
  const text = result.content?.[0]?.text ?? "{}";
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} returned non-JSON content: ${text.slice(0, 500)}`);
  }
  if (result.isError || payload.ok === false) {
    const message = payload.error || `${name} failed`;
    const err = new Error(message);
    err.details = payload;
    throw err;
  }
  return payload;
}

function scenarioCwdFor(currentSuite, scenario) {
  return path.resolve(runnerRoot, scenario.cwd ?? currentSuite.defaults?.cwd ?? ".");
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.max(min, Math.min(max, n));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gitStatus(cwd) {
  try {
    const stdout = await execFileText("git", ["status", "--porcelain"], { cwd });
    return {
      ok: true,
      cwd,
      porcelain: stdout.trim()
    };
  } catch (error) {
    return {
      ok: false,
      cwd,
      error: error.message,
      porcelain: null
    };
  }
}

function gitMutationFailure(before, after) {
  if (!before.ok || !after.ok) {
    return null;
  }
  if (before.porcelain === after.porcelain) {
    return null;
  }
  return {
    code: "repo_tracked_state_changed",
    before: before.porcelain,
    after: after.porcelain
  };
}

function execFileText(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, commandArgs, options, (error, stdout, stderr) => {
      if (error) {
        error.message = stderr?.trim() || error.message;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

function overallStatus(results) {
  if (results.some((result) => result.status === "fail")) {
    return "fail";
  }
  if (results.some((result) => cleanupFailed(result))) {
    return "partial";
  }
  return "pass";
}

function cleanupFailed(result) {
  return Array.isArray(result.cleanup) && result.cleanup.some((entry) => entry.ok === false);
}

async function writeReports(currentRun) {
  const reportRoot = path.join(runnerRoot, "wf-runs", currentRun.suiteId);
  await fs.mkdir(reportRoot, { recursive: true });
  const jsonPath = path.join(reportRoot, `${currentRun.runId}.json`);
  const markdownPath = path.join(reportRoot, `${currentRun.runId}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(currentRun, null, 2)}\n`);
  await fs.writeFile(markdownPath, renderMarkdownReport(currentRun));
  return {
    json: jsonPath,
    markdown: markdownPath
  };
}

function renderMarkdownReport(currentRun) {
  const lines = [];
  lines.push(`# ${currentRun.title}`);
  lines.push("");
  lines.push(`- Run: \`${currentRun.runId}\``);
  lines.push(`- Mode: \`${currentRun.mode}\``);
  lines.push(`- Status: \`${currentRun.status}\``);
  lines.push(`- Plugin root: \`${currentRun.pluginRoot}\``);
  lines.push("");
  lines.push("## Tool Check");
  lines.push("");
  if (currentRun.toolCheck) {
    lines.push(`- Status: \`${currentRun.toolCheck.status}\``);
    lines.push(`- Missing tools: ${currentRun.toolCheck.missingTools.length ? currentRun.toolCheck.missingTools.map(code).join(", ") : "none"}`);
  } else {
    lines.push("- Status: not run");
  }
  lines.push("");
  lines.push("## Coverage Matrix");
  lines.push("");
  lines.push("| Scenario | Type | Outcome | Status | Failure Codes |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const scenario of currentRun.scenarios) {
    lines.push(`| ${scenario.id} | ${scenario.type} | ${escapeTable(scenario.outcome ?? "")} | ${scenario.status} | ${(scenario.failureCodes ?? []).map(code).join(", ") || "none"} |`);
  }
  lines.push("");
  lines.push("## Evidence");
  for (const scenario of currentRun.scenarios) {
    lines.push("");
    lines.push(`### ${scenario.id}`);
    lines.push("");
    lines.push(`- Status: \`${scenario.status}\``);
    lines.push(`- Outcome: ${scenario.outcome ?? ""}`);
    if (scenario.evidence?.originThreadId) {
      lines.push(`- Origin thread: \`${scenario.evidence.originThreadId}\``);
    }
    if (scenario.evidence?.targetThreadId) {
      lines.push(`- Target thread: \`${scenario.evidence.targetThreadId}\``);
    }
    if (scenario.evidence?.toolCalls) {
      lines.push(`- Tool calls: ${scenario.evidence.toolCalls.map(code).join(", ") || "none"}`);
    }
    if (scenario.evidence?.dependencyReceiptId) {
      lines.push(`- Dependency receipt: \`${scenario.evidence.dependencyReceiptId}\``);
    }
    if (scenario.evidence?.finalText) {
      lines.push("");
      lines.push("Final text:");
      lines.push("");
      lines.push("```text");
      lines.push(scenario.evidence.finalText);
      lines.push("```");
    }
    if (scenario.evidence?.cases) {
      lines.push("");
      lines.push("Fixture cases:");
      lines.push("");
      lines.push("| Case | Status | Expected | Failure Codes | Expectation |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const fixtureCase of scenario.evidence.cases) {
        lines.push(`| ${fixtureCase.id} | ${fixtureCase.status} | ${fixtureCase.expectedStatus} | ${(fixtureCase.failureCodes ?? []).map(code).join(", ") || "none"} | ${fixtureCase.expectationMet ? "pass" : "fail"} |`);
      }
    }
    if (scenario.cleanup) {
      lines.push("");
      lines.push("Cleanup:");
      for (const entry of scenario.cleanup) {
        lines.push(`- ${entry.threadId}: ${entry.ok ? "ok" : `failed (${entry.error})`}`);
      }
    }
  }
  if (currentRun.error) {
    lines.push("");
    lines.push("## Run Error");
    lines.push("");
    lines.push("```text");
    lines.push(currentRun.error.stack ?? currentRun.error.message);
    lines.push("```");
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function code(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function pluginRootLabel(root) {
  if (path.resolve(root) === runnerRoot) {
    return "source";
  }
  if (installedPluginRoot && path.resolve(root) === installedPluginRoot) {
    return "installed";
  }
  return path.basename(root).replace(/[^a-zA-Z0-9_.-]/g, "-") || "plugin";
}
