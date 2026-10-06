// Shared helpers for tests that run the MCP server against the stub Codex
// app-server (tests/fixtures/stub-codex-app-server.js). Never launches Codex.app.
import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const stubAppServer = path.join(pluginRoot, "tests", "fixtures", "stub-codex-app-server.js");

// A per-run symlink to the stub. Its path appears in the argv of every
// app-server the server spawns for this run, so taggedProcesses() can find
// them even when the stub died before writing its spawn-log line.
export function taggedStub(dir) {
  const link = path.join(dir, "stub-codex-app-server.js");
  symlinkSync(stubAppServer, link);
  return link;
}

// Live processes whose argv contains `tag`, plus every member of their process
// groups (the stub's grandchild). Reads argv only, never environments.
export function taggedProcesses(tag) {
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,args="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr}`);
  const rows = result.stdout.split("\n").filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), pgid: Number(match[2]), args: match[3] } : null;
  }).filter(Boolean);
  const leaders = new Set(rows.filter((row) => row.args.includes(tag) && row.pid !== process.pid).map((row) => row.pid));
  return rows.filter((row) => leaders.has(row.pid) || leaders.has(row.pgid)).map((row) => row.pid);
}

export function readSpawnLog(file) {
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { starts: [], grandchildren: [] };
  }
  const starts = [];
  const grandchildren = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const [pid, kind, value] = line.split(" ");
    if (kind === "start") starts.push({ pid: Number(pid), url: value });
    if (kind === "grandchild") grandchildren.push({ parent: Number(pid), pid: Number(value) });
  }
  return { starts, grandchildren };
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Resolves with { code, signal } when the child exits, or { timeout: true }.
export function waitForExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve({ timeout: true });
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", onExit);
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
