// A stray rejection or exception in the MCP server is logged and runs the
// normal shutdown (exit 1), instead of crashing silently or hanging.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hermeticEnv } from "../helpers/env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * @param {string} entry  src/server.js or dist/server.mjs
 * @param {string} inject module source run before the server, via --import
 */
function runServer(entry, inject) {
  const home = hermeticEnv().HOME;
  const env = hermeticEnv({
    home,
    overrides: {
      CODEX_AGENT_LINK_AUTOSTART: "0",
      CODEX_AGENT_LINK_RECEIPT_LOG: path.join(home, "agent-link-receipts.jsonl"),
      AGENT_LINK_MAILBOX_PATH: path.join(home, "mailbox.jsonl"),
      CODEX_AGENT_LINK_STATE_DIR: path.join(home, "managed")
    }
  });
  const child = spawn(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(inject)}`,
    path.join(root, entry)
  ], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not exit; stderr: ${stderr}`));
    }, 15000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout });
    });
  });
}

// Fire only once the server has installed its handler for `event`, so a slow
// module load cannot let the fault escape to Node's default crash handler.
const whenHandled = (event, fault) =>
  `const t = setInterval(() => { if (process.listenerCount(${JSON.stringify(event)}) > 0) { clearInterval(t); ${fault} } }, 20);`;

for (const entry of ["src/server.js", "dist/server.mjs"]) {
  test(`${entry}: unhandled rejection is logged and shuts down with exit 1`, async () => {
    const result = await runServer(entry, whenHandled("unhandledRejection", 'Promise.reject(new Error("stray rejection"));'));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /agent-link: \[error\] process\.unhandled_rejection .*stray rejection/);
    assert.equal(result.stdout, "", "nothing written to the protocol stream");
  });

  test(`${entry}: uncaught exception is logged and shuts down with exit 1`, async () => {
    const result = await runServer(entry, whenHandled("uncaughtException", 'throw new Error("stray throw");'));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /agent-link: \[error\] process\.uncaught_exception .*stray throw/);
    assert.equal(result.stdout, "");
  });
}
