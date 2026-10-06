#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  launchProjectWorker,
  messageProjectOrchestrator,
  resolveProjectOrchestrator,
  returnProjectWorkResult
} from "../src/codex/project-orchestrator.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-project-orchestrator-"));

try {
  const projectRoot = path.join(tempRoot, "source-project");
  await mkdir(path.join(projectRoot, ".codex"), { recursive: true });
  const binding = {
    projectRoot,
    projectId: "codex-agent-link",
    orchestratorThreadId: "thread-orchestrator-bound",
    role: "project_orchestrator",
    policyVersion: "v0",
    createdAt: "2026-05-16T20:00:00.000Z",
    lastVerifiedAt: "2026-05-16T20:05:00.000Z"
  };
  await writeFile(
    path.join(projectRoot, ".codex", "project-orchestrator.json"),
    `${JSON.stringify(binding, null, 2)}\n`
  );

  const calls = [];
  const deps = {
    now: () => "2026-05-16T22:00:00.000Z",
    readThread: async (threadId) => {
      calls.push(["readThread", threadId]);
      if (threadId === "thread-orchestrator-bound") {
        return {
          ok: true,
          thread: {
            id: threadId,
            name: "Codex Project Orchestrator Patch",
            cwd: projectRoot,
            status: { type: "idle" }
          }
        };
      }
      throw new Error(`missing thread ${threadId}`);
    },
    listThreads: async () => {
      throw new Error("binding resolution should not search when the binding is readable");
    },
    messageThread: async (args) => {
      calls.push(["messageThread", args]);
      return {
        ok: true,
        action: "started_turn",
        threadId: args.threadId,
        message: args.message,
        receipt: { recorded: true }
      };
    },
    launchThread: async (args) => {
      calls.push(["launchThread", args]);
      return {
        ok: true,
        thread: {
          id: "thread-worker-created",
          name: args.name,
          cwd: args.cwd
        },
        turn: { id: "turn-worker-created" },
        gui: { attempted: false },
        receipt: { recorded: true }
      };
    }
  };

  const resolved = await resolveProjectOrchestrator({ projectRoot }, deps);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source, "binding");
  assert.equal(resolved.threadId, "thread-orchestrator-bound");
  assert.equal(resolved.binding.projectId, "codex-agent-link");
  assert.equal(resolved.verification.readable, true);
  assert.deepEqual(calls[0], ["readThread", "thread-orchestrator-bound"]);

  const messaged = await messageProjectOrchestrator({
    projectRoot,
    message: "Status update from Worker A.",
    receipt: {
      purpose: "project orchestrator regression"
    }
  }, deps);
  assert.equal(messaged.ok, true);
  assert.equal(messaged.resolution.threadId, "thread-orchestrator-bound");
  const messageCall = calls.find((call) => call[0] === "messageThread");
  assert.equal(messageCall[1].threadId, "thread-orchestrator-bound");
  assert.equal(messageCall[1].message, "Status update from Worker A.");

  const launched = await launchProjectWorker({
    projectRoot,
    name: "Worker B",
    workerRole: "implementation worker",
    task: "Patch the smoke expected tool list.",
    receipt: {
      purpose: "project worker launch"
    }
  }, deps);
  assert.equal(launched.ok, true);
  assert.equal(launched.resolution.threadId, "thread-orchestrator-bound");
  const launchCall = calls.find((call) => call[0] === "launchThread");
  assert.equal(launchCall[1].ephemeral, false);
  assert.equal(launchCall[1].openInGui, false);
  assert.equal(launchCall[1].cwd, projectRoot);
  assert.match(launchCall[1].message, /Return path/);
  assert.match(launchCall[1].message, /thread-orchestrator-bound/);
  assert.match(launchCall[1].message, /return_project_work_result/);
  assert.match(launchCall[1].message, /Patch the smoke expected tool list\./);

  const returned = await returnProjectWorkResult({
    projectRoot,
    workerThreadId: "thread-worker-created",
    status: "done",
    summary: "Updated orchestrator tool docs.",
    changedPaths: ["README.md"],
    testsRun: ["node scripts/project-orchestrator-regression-test.js"],
    blockers: [],
    nextSteps: []
  }, deps);
  assert.equal(returned.ok, true);
  const returnMessageCall = calls.filter((call) => call[0] === "messageThread").at(-1);
  assert.equal(returnMessageCall[1].threadId, "thread-orchestrator-bound");
  assert.match(returnMessageCall[1].message, /Project worker result/);
  assert.match(returnMessageCall[1].message, /"status": "done"/);
  assert.match(returnMessageCall[1].message, /README\.md/);

  const corruptRoot = path.join(tempRoot, "corrupt-project");
  await mkdir(path.join(corruptRoot, ".codex"), { recursive: true });
  await writeFile(
    path.join(corruptRoot, ".codex", "project-orchestrator.json"),
    "{ not valid json"
  );
  await assert.rejects(
    () => resolveProjectOrchestrator({ projectRoot: corruptRoot }, deps),
    /project-orchestrator binding is corrupt/i
  );

  const ambiguousRoot = path.join(tempRoot, "ambiguous-project");
  const ambiguousDeps = {
    readThread: async () => {
      throw new Error("no binding candidate");
    },
    listThreads: async () => ({
      ok: true,
      source: "local-jsonl-fallback",
      data: [
        {
          id: "thread-ambiguous-a",
          name: "Project Orchestrator",
          preview: "Project: Ambiguous",
          cwd: ambiguousRoot,
          updatedAt: "2026-05-16T21:00:00.000Z"
        },
        {
          id: "thread-ambiguous-b",
          name: "Project Orchestrator",
          preview: "Project: Ambiguous",
          cwd: ambiguousRoot,
          updatedAt: "2026-05-16T20:59:00.000Z"
        }
      ]
    })
  };
  await assert.rejects(
    () => resolveProjectOrchestrator({
      projectRoot: ambiguousRoot,
      query: "Project Orchestrator"
    }, ambiguousDeps),
    /ambiguous/i
  );

  console.log("Project orchestrator regression test passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
