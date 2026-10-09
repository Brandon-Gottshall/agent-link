// tests/shipped-plugin.test.js
// The installed plugin must run with no node_modules. Both hosts install a
// plugin as a copy of this repo's git tree, so the shipped files are the
// tracked files (`git ls-files`); node_modules is never among them. This test
// copies exactly those files to a temp directory with no node_modules on the
// resolution path, then:
//   - starts dist/server.mjs as each host would and runs initialize + tools/list;
//   - runs the Claude notify hook and the Codex prompt hook against pending mail;
//   - checks statically that the hooks' import graphs and the bundle import
//     only Node built-ins (plus ws's optional, guarded native accelerators).
// Claude Code may still run `npm ci` over package-lock.json when it installs
// the plugin; nothing at runtime uses the result.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "./helpers/guard.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openMailbox } from "../src/claude/mailbox.js";
import { hermeticEnv } from "./helpers/env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THREAD = "019a0000-0000-7000-8000-0000000000b1";
const CLAUDE_SESSION = "shipped-plugin-0001";
const SENDER = "7c1e0000-0000-4000-8000-0000000000c2";
const BUILTINS = new Set(builtinModules);
// ws require()s these inside try/catch and falls back to pure JS without them.
const OPTIONAL_NATIVE = new Set(["bufferutil", "utf-8-validate"]);

const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
const shipped = listed.status === 0 ? listed.stdout.split("\0").filter(Boolean) : null;

const isBuiltin = (/** @type {string} */ spec) => spec.startsWith("node:") || BUILTINS.has(spec);

/** Copy the tracked files to a fresh temp dir; returns the copy's root. */
function copyShipped() {
  const base = mkdtempSync(path.join(os.tmpdir(), "agent-link-shipped-"));
  const dest = path.join(base, "agent-link");
  for (const rel of shipped ?? []) {
    const from = path.join(root, rel);
    if (!existsSync(from)) continue; // deleted in the working tree, not yet committed
    mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    copyFileSync(from, path.join(dest, rel));
  }
  return { base, dest };
}

/** True when some directory from dir up to / has a node_modules folder. */
function nodeModulesOnPath(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, "node_modules"))) return current;
    if (path.dirname(current) === current) return null;
  }
}

function sandboxEnv(base, extra = {}) {
  const home = path.join(base, "home");
  mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  const state = path.join(base, "state");
  return hermeticEnv({
    home,
    overrides: {
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      AGENT_LINK_STATE_DIR: state,
      AGENT_LINK_MAILBOX_PATH: path.join(state, "mailbox.jsonl"),
      AGENT_LINK_CODEX_AUTOSTART: "0",
      AGENT_LINK_DISABLE_CHANNEL: "1",
      // A stray NODE_PATH would let a missing package resolve from elsewhere.
      NODE_PATH: undefined,
      ...extra
    }
  });
}

/** initialize + tools/list over stdio; resolves with the tool names. */
function listTools(cwd, env) {
  const child = spawn(process.execPath, ["./dist/server.mjs"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for tools/list: ${stderr}`)), 20_000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}) before tools/list: ${stderr}`)); });
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          assert.ok(message.result?.serverInfo, `initialize failed: ${line}`);
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          clearTimeout(timer);
          if (message.error) reject(new Error(`tools/list failed: ${message.error.message}`));
          else resolve(message.result.tools.map((tool) => tool.name));
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shipped-plugin-test", version: "0" } }
    });
  }).finally(() => {
    child.removeAllListeners("exit");
    child.stdin.end();
    child.kill("SIGTERM");
  });
}

/** Relative-import closure of entry; returns every non-relative specifier. */
function externalImports(entry) {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"'\n]+)["']/gm;
  const seen = new Set();
  const external = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(pattern)) {
      if (spec.startsWith(".")) queue.push(path.resolve(path.dirname(file), spec));
      else external.add(spec);
    }
  }
  return { files: seen.size, external: [...external] };
}

test("the shipped plugin runs with no node_modules", { skip: shipped ? false : "not a git checkout" }, async (t) => {
  const { base, dest } = copyShipped();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  assert.ok(existsSync(path.join(dest, "dist", "server.mjs")), "dist/server.mjs is tracked");
  assert.equal(nodeModulesOnPath(dest), null, "no node_modules from the copy up to /");

  await t.test("server: initialize + tools/list on both hosts", async () => {
    for (const host of ["claude", "codex"]) {
      const tools = await listTools(dest, sandboxEnv(path.join(base, `server-${host}`), { AGENT_LINK_HOST: host }));
      assert.ok(tools.includes("agent_link_health"), `${host}: agent_link_health listed`);
      assert.ok(tools.includes("message_agent"), `${host}: message_agent listed`);
    }
  });

  await t.test("Claude notify hook flags pending mail", () => {
    const sandbox = path.join(base, "claude-hook");
    const env = sandboxEnv(sandbox);
    mkdirSync(env.AGENT_LINK_STATE_DIR, { recursive: true });
    const transcript = path.join(sandbox, `${CLAUDE_SESSION}.jsonl`);
    writeFileSync(transcript, `${JSON.stringify({ sessionId: CLAUDE_SESSION, type: "summary" })}\n`);
    const mailbox = openMailbox({ mailboxPath: env.AGENT_LINK_MAILBOX_PATH });
    try {
      mailbox.insertMessage({ fromSessionId: SENDER, fromSessionKind: "claude", toSessionId: `local_${CLAUDE_SESSION}`, toSessionKind: "claude", body: "hello" });
    } finally {
      mailbox.close?.();
    }
    const res = spawnSync(process.execPath, [path.join(dest, "src", "claude", "notify-hook.js")], {
      input: JSON.stringify({ session_id: CLAUDE_SESSION, transcript_path: transcript, hook_event_name: "UserPromptSubmit" }),
      cwd: sandbox,
      env: { ...env, CLAUDE_PLUGIN_ROOT: dest },
      encoding: "utf8",
      timeout: 15_000
    });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
    assert.match(res.stdout, /read_agent_link_inbox/);
  });

  await t.test("Codex prompt hook flags pending mail", () => {
    const sandbox = path.join(base, "codex-hook");
    const env = sandboxEnv(sandbox);
    mkdirSync(env.AGENT_LINK_STATE_DIR, { recursive: true });
    const mailbox = openMailbox({ mailboxPath: env.AGENT_LINK_MAILBOX_PATH });
    try {
      mailbox.insertMessage({ fromSessionId: `claude:${SENDER}`, fromSessionKind: "claude", toSessionId: THREAD, toSessionKind: "codex", body: "hello" });
    } finally {
      mailbox.close?.();
    }
    const res = spawnSync(process.execPath, [path.join(dest, "src", "codex", "prompt-hook.js")], {
      input: JSON.stringify({ session_id: THREAD, hook_event_name: "UserPromptSubmit", cwd: sandbox, prompt: "hi" }),
      cwd: sandbox,
      env: { ...env, PLUGIN_ROOT: dest },
      encoding: "utf8",
      timeout: 15_000
    });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
    assert.match(res.stdout, /read_agent_link_inbox/);
  });

  await t.test("runtime code imports only Node built-ins", () => {
    for (const entry of ["src/claude/notify-hook.js", "src/codex/prompt-hook.js"]) {
      const { files, external } = externalImports(path.join(dest, entry));
      assert.ok(files > 1, `${entry}: import graph traced`);
      assert.deepEqual(external.filter((spec) => !isBuiltin(spec)), [], `${entry} imports only built-ins`);
    }
    const bundle = readFileSync(path.join(dest, "dist", "server.mjs"), "utf8");
    const topLevel = [...bundle.matchAll(/^import\s[^;]*?from\s*"([^"]+)";?$/gm)].map((m) => m[1]);
    assert.ok(topLevel.length > 0, "bundle has top-level imports");
    assert.deepEqual(topLevel.filter((spec) => !isBuiltin(spec)), [], "bundle imports only built-ins");
    const required = [...bundle.matchAll(/__require\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual(required.filter((spec) => !isBuiltin(spec) && !OPTIONAL_NATIVE.has(spec)), [],
      "bundle require()s only built-ins and ws's optional accelerators");
  });
});

test("package.json declares no runtime dependencies", () => {
  // Claude Code reports a plugin whose package.json lists runtime
  // dependencies as "packages not installed" whenever its install-time npm
  // step fails. The bundle carries everything, so they are devDependencies.
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies"]) {
    assert.equal(pkg[field], undefined, `package.json has no ${field}`);
  }
  for (const name of ["@modelcontextprotocol/sdk", "ws"]) {
    assert.ok(pkg.devDependencies?.[name], `${name} is a devDependency (bundled by scripts/build.mjs)`);
  }
});
