#!/usr/bin/env node
// Measure managed app-server churn and idle CPU of one agent-link MCP server.
// Thin CLI over measure() in tests/helpers/idle-churn.js. Uses the stub
// app-server (tests/fixtures/stub-codex-app-server.js); never launches Codex.app.
//
//   node scripts/idle-churn-measure.js [--idle-seconds 120] [--plugin-root DIR]
//        [--real-home] [--session-id ID] [--shutdown stdin|sigterm|sighup]
//
// --plugin-root lets you measure another build (e.g. an installed copy) with
// the same harness. --real-home keeps HOME so the Claude channel bridge
// indexes the real session corpus (read-only; the mailbox is always a temp
// file so no real message is consumed).
import path from "node:path";
import { measure } from "../tests/helpers/idle-churn.js";
import { pluginRoot } from "../tests/helpers/codex-stub.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const result = await measure({
  idleSeconds: Number(opt("--idle-seconds", "120")),
  pluginRoot: path.resolve(opt("--plugin-root", pluginRoot)),
  realHome: args.includes("--real-home"),
  sessionId: opt("--session-id", undefined),
  shutdown: opt("--shutdown", "stdin")
});
console.log(JSON.stringify(result, null, 2));
