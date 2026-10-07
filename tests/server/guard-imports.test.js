// Every offline test file loads tests/helpers/guard.js before anything else
// (fix round a3, N3), so even a bare `node --test <file>` refuses to run
// unless HOME, CODEX_HOME, CLAUDE_CONFIG_DIR and AGENT_LINK_STATE_DIR point
// into the temp directory. This scans every file the offline runner lists.
// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("every offline test file imports the state guard as its first import", () => {
  const runner = readFileSync(path.join(root, "scripts", "run-offline-tests.js"), "utf8");
  const listed = runner.slice(runner.indexOf("const groups"), runner.indexOf("groups.all"));
  const files = [...new Set((listed.match(/"(tests|scripts)\/[^"]+\.js"/g) ?? []).map((quoted) => quoted.slice(1, -1)))];
  assert.ok(files.length > 50, "the runner lists the offline tests");
  assert.ok(files.includes("tests/server/guard-imports.test.js"), "this check is itself run");
  const missing = [];
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    const firstImport = source.split("\n").find((line) => /^import[\s{"*]/.test(line));
    let expected = path.relative(path.dirname(file), "tests/helpers/guard.js");
    if (!expected.startsWith(".")) expected = `./${expected}`;
    if (firstImport !== `import "${expected}";`) missing.push(`${file}: first import is ${JSON.stringify(firstImport ?? null)}`);
  }
  assert.deepEqual(missing, []);
});
