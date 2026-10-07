// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendJsonl,
  appendJsonlSync,
  parseJsonlLines,
  readJsonl,
  readJsonlSync,
  toJsonl
} from "../../src/shared/jsonl.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-link-jsonl-"));
process.once("exit", () => rmSync(tmp, { recursive: true, force: true }));

test("parseJsonlLines skips blank and corrupt lines and keeps order", () => {
  const raw = '{"a":1}\n\n   \nnot json\n{"b":2}\r\n[3]\nnull\n{"truncated":\n';
  assert.deepEqual(parseJsonlLines(raw), [{ a: 1 }, { b: 2 }, [3], null]);
  assert.deepEqual(parseJsonlLines(""), []);
  assert.deepEqual(parseJsonlLines(undefined), []);
});

test("toJsonl", () => {
  assert.equal(toJsonl([{ a: 1 }, "x"]), '{"a":1}\n"x"\n');
  assert.equal(toJsonl([]), "");
});

test("appendJsonl creates a 0700 directory and a 0600 file", async () => {
  const file = path.join(tmp, "nested", "dir", "log.jsonl");
  await appendJsonl(file, { a: 1 });
  await appendJsonl(file, [{ b: 2 }, { c: 3 }]);
  assert.equal(readFileSync(file, "utf8"), '{"a":1}\n{"b":2}\n{"c":3}\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test("appendJsonlSync matches appendJsonl", () => {
  const file = path.join(tmp, "sync", "log.jsonl");
  appendJsonlSync(file, { a: 1 });
  appendJsonlSync(file, [{ b: 2 }]);
  assert.deepEqual(readJsonlSync(file), [{ a: 1 }, { b: 2 }]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("readJsonl streams records and tolerates a corrupt tail", async () => {
  const file = path.join(tmp, "stream.jsonl");
  const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i }));
  writeFileSync(file, `${lines.join("\n")}\n\n{"partial":`);
  let count = 0;
  let last = null;
  for await (const record of readJsonl(file)) {
    count += 1;
    last = record;
  }
  assert.equal(count, 5000);
  assert.deepEqual(last, { i: 4999 });
});

test("readJsonl stops cleanly when the consumer breaks early", async () => {
  const file = path.join(tmp, "early.jsonl");
  writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3}\n');
  const seen = [];
  for await (const record of readJsonl(file)) {
    seen.push(record);
    if (seen.length === 2) break;
  }
  assert.deepEqual(seen, [{ a: 1 }, { a: 2 }]);
});

test("missing files read as empty; other errors propagate", async () => {
  const missing = path.join(tmp, "nope.jsonl");
  assert.deepEqual(readJsonlSync(missing), []);
  const records = [];
  for await (const record of readJsonl(missing)) records.push(record);
  assert.deepEqual(records, []);
  assert.throws(() => readJsonlSync(tmp), /EISDIR/);
});
