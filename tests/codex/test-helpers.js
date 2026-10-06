import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const stubAppServer = path.join(pluginRoot, "tests", "fixtures", "stub-codex-app-server.js");

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

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
