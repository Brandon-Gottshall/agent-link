// Stale-lock takeover keeps mutual exclusion (PR B9 review I1). Eight
// processes are released together against a stale lock (dead owner, old
// mtime), many times; a second holder inside the critical section is a
// violation.
//
//   AGENT_LINK_LOCK_MODULE=<path to roles.js>  run against another tree
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = process.env.AGENT_LINK_LOCK_MODULE ?? path.join(root, "src", "registry", "roles.js");
const WORKERS = 8;
const TRIALS = 30;

// Each trial: the parent leaves a stale lock (dead owner, old mtime) and then
// releases all workers at once, so they race to take it over together.
const worker = `
  import fs from "node:fs";
  import path from "node:path";
  import { withFileLockSync } from ${JSON.stringify(modulePath)};
  const [dir, trials] = [process.argv[1], Number(process.argv[2])];
  const lock = path.join(dir, "roles.json.lock");
  const holder = path.join(dir, "holder");
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let violations = 0;
  for (let i = 0; i < trials; i++) {
    while (!fs.existsSync(path.join(dir, "go-" + i))) sleep(1);
    withFileLockSync(lock, () => {
      try {
        fs.writeFileSync(holder, String(process.pid), { flag: "wx" });
      } catch {
        violations += 1;
        return;
      }
      sleep(3);
      fs.rmSync(holder, { force: true });
    }, { timeoutMs: 60000, staleMs: 5000 });
    fs.writeFileSync(path.join(dir, "done-" + i + "-" + process.pid), "");
  }
  process.stdout.write(JSON.stringify({ violations }));
`;

test(`stale-lock takeover never lets two of ${WORKERS} racing processes hold the lock (${TRIALS} trials)`, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-link-lock-stress-"));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const lock = path.join(dir, "roles.json.lock");
    const results = Promise.all(Array.from({ length: WORKERS }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", worker, dir, String(TRIALS)], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { err += chunk; });
      child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker exited ${code}: ${err}`))));
    })));
    for (let i = 0; i < TRIALS; i++) {
      writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 4242, token: `dead-${i}` }));
      const old = Date.now() / 1000 - 600;
      utimesSync(lock, old, old);
      await sleep(30);
      writeFileSync(path.join(dir, `go-${i}`), "");
      while (readdirSync(dir).filter((name) => name.startsWith(`done-${i}-`)).length < WORKERS) await sleep(5);
    }
    const violations = (await results).reduce((sum, r) => sum + r.violations, 0);
    assert.equal(violations, 0, `${violations} times a second process entered the critical section`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
