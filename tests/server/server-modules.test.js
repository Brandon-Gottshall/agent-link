// The split server modules (design doc R5.1, PR B5):
//   - src/server.js keeps src/server/process-guard.js as its FIRST import, in
//     source and in the dist bundle;
//   - importing the bootstrap and every handler module has no side effects
//     (no listeners, no handles, no child processes, no stdout, no files);
//   - createAgentLinkServer() builds the server in-process without starting
//     anything, and its tools/list matches the committed snapshots.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hermeticEnv } from "../helpers/env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SPLIT_MODULES = [
  "src/server/index.js",
  "src/server/health.js",
  "src/server/lifecycle.js",
  "src/codex/thread-queries.js",
  "src/codex/loaded-threads.js",
  "src/codex/thread-actions.js",
  "src/codex/thread-messaging.js",
  "src/codex/thread-summary.js",
  "src/codex/desktop-routing.js",
  "src/shared/process.js"
];

/** Import specifiers of the static import statements, in source order. */
function staticImports(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...withoutComments.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']\s*;?/gm)].map((match) => match[1]);
}

test("src/server.js imports process-guard first", () => {
  const imports = staticImports(readFileSync(path.join(root, "src", "server.js"), "utf8"));
  assert.ok(imports.length >= 2, `expected imports, got ${JSON.stringify(imports)}`);
  assert.equal(imports[0], "./server/process-guard.js", "process-guard must be the first import of src/server.js");
});

test("dist/server.mjs installs the process handlers before the MCP SDK evaluates", () => {
  const bundle = readFileSync(path.join(root, "dist", "server.mjs"), "utf8");
  const guard = bundle.indexOf("process.unhandled_rejection");
  const sdk = bundle.indexOf("StdioServerTransport = class");
  const bootstrap = bundle.indexOf("function createAgentLinkServer");
  assert.ok(guard > 0, "process-guard is in the bundle");
  assert.ok(sdk > 0 && bootstrap > 0, "the SDK and the bootstrap are in the bundle");
  assert.ok(guard < sdk, "process-guard evaluates before the MCP SDK");
  assert.ok(guard < bootstrap, "process-guard evaluates before the server bootstrap");
});

// Runs in a fresh Node so the test runner's own listeners and handles do not
// count. It records the process state, imports every module, lets a tick
// pass, and records the state again. PipeWrap/TTYWrap are the lazily created
// process.stdin/stdout/stderr handles, which a dependency may touch while it
// loads; reading stdin is checked through its listeners instead.
const PROBE = `
import { readdirSync } from "node:fs";
const events = ["unhandledRejection", "uncaughtException", "SIGINT", "SIGTERM", "SIGHUP", "exit", "beforeExit", "warning"];
const STDIO_HANDLES = new Set(["PipeWrap", "TTYWrap"]);
const snapshot = () => ({
  listeners: Object.fromEntries(events.map((name) => [name, process.listenerCount(name)])),
  resources: process.getActiveResourcesInfo().filter((name) => !STDIO_HANDLES.has(name)).sort(),
  home: readdirSync(process.env.HOME).sort()
});
const stdinListeners = () => Object.fromEntries(["data", "readable", "end", "close"].map((name) => [name, process.stdin.listenerCount(name)]));
const stdinBefore = stdinListeners();
const before = snapshot();
const modules = JSON.parse(process.env.PROBE_MODULES);
const exported = {};
for (const url of modules) {
  const mod = await import(url);
  exported[url] = Object.keys(mod).sort();
}
await new Promise((resolve) => setImmediate(resolve));
const after = snapshot();
const stdin = { before: stdinBefore, after: stdinListeners() };
process.stderr.write(JSON.stringify({ before, after, stdin, exported }));
`;

test("importing the split modules has no side effects", () => {
  const env = hermeticEnv({ overrides: { PROBE_MODULES: JSON.stringify(SPLIT_MODULES.map((file) => pathToFileURL(path.join(root, file)).href)) } });
  const homeBefore = readdirSync(env.HOME).sort();
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE], {
    cwd: root,
    env,
    encoding: "utf8",
    input: "",
    timeout: 20000
  });
  assert.equal(result.status, 0, `probe exited ${result.status} (signal ${result.signal}); stderr: ${result.stderr}`);
  assert.equal(result.stdout, "", "nothing written to stdout");
  const { before, after, stdin, exported } = JSON.parse(result.stderr);
  assert.deepEqual(after.listeners, before.listeners, "no process listeners were added (a started server adds SIGINT/SIGTERM/SIGHUP/exit)");
  assert.deepEqual(stdin.after, stdin.before, "nothing reads stdin (a started server's transport would)");
  assert.deepEqual(after.resources, before.resources, "no timers, sockets, servers or child processes were left active");
  assert.deepEqual(after.home, before.home, "no files were created under HOME");
  assert.deepEqual(readdirSync(env.HOME).sort(), homeBefore, "HOME is unchanged after the probe");
  for (const file of SPLIT_MODULES) {
    const url = pathToFileURL(path.join(root, file)).href;
    assert.ok(exported[url].length > 0, `${file} exports something`);
  }
});

test("createAgentLinkServer builds the server in-process without starting it", async () => {
  const { loadConfig } = await import("../../src/server/config.js");
  const { createAgentLinkServer } = await import("../../src/server/index.js");
  const listenersBefore = ["SIGINT", "SIGTERM", "SIGHUP", "exit"].map((name) => process.listenerCount(name));
  const requests = [];
  const fakeAppServer = {
    request: async (method, params) => {
      requests.push(method);
      return {};
    },
    getConnectionSummary: () => ({ connected: false }),
    close: async () => {},
    killManagedSync: () => {}
  };
  for (const host of ["codex", "claude"]) {
    const config = loadConfig({ ...process.env, AGENT_LINK_HOST: host, AGENT_LINK_DISABLE_CHANNEL: "1" });
    let fatalHandler = null;
    const app = createAgentLinkServer({
      config,
      appServer: /** @type {any} */ (fakeAppServer),
      setFatalHandler: (fn) => { fatalHandler = fn; }
    });
    assert.equal(typeof fatalHandler, "function", "the fatal handler is handed to process-guard");
    assert.equal(app.appServer, fakeAppServer, "the injected app-server client is used");
    const snapshot = JSON.parse(readFileSync(path.join(root, "tests", "fixtures", `tools-list.${host}.json`), "utf8"));
    assert.deepEqual(JSON.parse(JSON.stringify(app.registry.listTools())), snapshot, `${host}: in-process tools/list matches the committed snapshot`);
  }
  assert.deepEqual(requests, [], "building the server sends no app-server request");
  assert.deepEqual(["SIGINT", "SIGTERM", "SIGHUP", "exit"].map((name) => process.listenerCount(name)), listenersBefore, "no shutdown handlers until start()");
});
