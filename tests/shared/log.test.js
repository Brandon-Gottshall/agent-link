// Refuses to run unless every state root is a temp directory (F3/N3).
import "../helpers/guard.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLogger, getLogger, LOG_LEVELS, resolveLogLevel, setLogger } from "../../src/shared/log.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-link-log-"));
process.once("exit", () => rmSync(tmp, { recursive: true, force: true }));

function sink() {
  /** @type {string[]} */
  const lines = [];
  return { lines, write: (/** @type {string} */ chunk) => { lines.push(chunk); return true; } };
}
const fixedClock = () => new Date("2026-10-06T12:00:00.000Z");

test("levels are ordered error < warn < info < debug", () => {
  assert.deepEqual(LOG_LEVELS, { error: 0, warn: 1, info: 2, debug: 3 });
});

test("resolveLogLevel: AGENT_LINK_LOG_LEVEL, then AGENT_LINK_DEBUG, then warn", () => {
  assert.equal(resolveLogLevel({}), "warn");
  assert.equal(resolveLogLevel({ AGENT_LINK_DEBUG: "1" }), "debug");
  assert.equal(resolveLogLevel({ AGENT_LINK_DEBUG: "0" }), "warn");
  assert.equal(resolveLogLevel({ AGENT_LINK_LOG_LEVEL: "INFO" }), "info");
  assert.equal(resolveLogLevel({ AGENT_LINK_LOG_LEVEL: "error", AGENT_LINK_DEBUG: "1" }), "error");
  assert.equal(resolveLogLevel({ AGENT_LINK_LOG_LEVEL: "verbose" }), "warn");
});

test("default level: warn and error reach stderr; info only the ring; debug nowhere", () => {
  const stderr = sink();
  const log = createLogger({ env: {}, stderr, clock: fixedClock, homedir: tmp });
  assert.equal(log.level, "warn");
  assert.equal(log.filePath, null, "no file unless configured or debugging");
  log.error("e.one", { n: 1 });
  log.warn("w.one");
  log.info("i.one", { k: "v" });
  log.debug("d.one");
  assert.deepEqual(stderr.lines, ['agent-link: [error] e.one {"n":1}\n', "agent-link: [warn] w.one\n"]);
  assert.deepEqual(log.recentEvents(), [
    { at: "2026-10-06T12:00:00.000Z", level: "error", event: "e.one", fields: { n: 1 } },
    { at: "2026-10-06T12:00:00.000Z", level: "warn", event: "w.one" },
    { at: "2026-10-06T12:00:00.000Z", level: "info", event: "i.one", fields: { k: "v" } }
  ]);
  assert.equal(log.enabled("warn"), true);
  assert.equal(log.enabled("info"), false);
});

test("never writes to stdout", () => {
  const original = process.stdout.write;
  let wrote = false;
  process.stdout.write = /** @type {any} */ (() => { wrote = true; return true; });
  try {
    const log = createLogger({ env: { AGENT_LINK_LOG_LEVEL: "debug", AGENT_LINK_LOG_FILE: path.join(tmp, "stdout-check.log") }, stderr: sink() });
    for (const level of /** @type {const} */ (["error", "warn", "info", "debug"])) log[level]("x");
  } finally {
    process.stdout.write = original;
  }
  assert.equal(wrote, false);
});

test("debug writes JSON lines to the default log file under the state dir with 0600", () => {
  const home = mkdtempSync(path.join(tmp, "home-"));
  const stderr = sink();
  const log = createLogger({ env: { AGENT_LINK_DEBUG: "1" }, stderr, clock: fixedClock, homedir: home });
  const file = path.join(home, ".agent-link", "logs", "agent-link.log");
  assert.equal(log.filePath, file);
  log.debug("d.event", { a: 1 });
  log.info("i.event");
  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    { at: "2026-10-06T12:00:00.000Z", level: "debug", event: "d.event", fields: { a: 1 } },
    { at: "2026-10-06T12:00:00.000Z", level: "info", event: "i.event" }
  ]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test("AGENT_LINK_LOG_FILE alone enables the file at the configured level", () => {
  const file = path.join(tmp, "explicit", "al.log");
  const log = createLogger({ env: { AGENT_LINK_LOG_FILE: file }, stderr: sink() });
  log.info("not.written");
  log.warn("written");
  const events = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line).event);
  assert.deepEqual(events, ["written"]);
});

test("the log file is size-capped with one rotation", () => {
  const file = path.join(tmp, "rotate.log");
  const log = createLogger({ env: { AGENT_LINK_LOG_FILE: file }, stderr: sink(), maxFileBytes: 300 });
  for (let i = 0; i < 20; i += 1) log.warn("rotate.event", { i, pad: "x".repeat(40) });
  assert.ok(statSync(file).size <= 300, "current file stays under the cap");
  assert.ok(existsSync(`${file}.1`), "one rotated file");
  assert.equal(existsSync(`${file}.2`), false, "only one rotation is kept");
  const current = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line).fields.i);
  assert.equal(current.at(-1), 19, "newest event is in the current file");
});

test("a failing log file disables itself once and never throws", () => {
  const blocker = path.join(tmp, "blocker");
  writeFileSync(blocker, "a file, not a directory");
  const stderr = sink();
  const log = createLogger({ env: { AGENT_LINK_LOG_FILE: path.join(blocker, "x.log") }, stderr });
  log.warn("first");
  log.warn("second");
  assert.equal(log.filePath, null);
  const notices = stderr.lines.filter((line) => line.includes("log.file_disabled"));
  assert.equal(notices.length, 1);
});

test("ring buffer is bounded and recentEvents returns copies", () => {
  const log = createLogger({ env: {}, stderr: sink(), ringSize: 3 });
  for (let i = 0; i < 5; i += 1) log.info("tick", { i });
  const events = log.recentEvents();
  assert.deepEqual(events.map((event) => event.fields?.i), [2, 3, 4]);
  assert.deepEqual(log.recentEvents(1).map((event) => event.fields?.i), [4]);
  assert.deepEqual(log.recentEvents(0), []);
  events[0].event = "mutated";
  assert.equal(log.recentEvents()[0].event, "tick");
});

test("fields: errors are summarized without stacks, long strings cut, undefined dropped", () => {
  const log = createLogger({ env: {}, stderr: sink() });
  const error = Object.assign(new Error("boom"), { code: "EPIPE" });
  log.warn("fields", { error, long: "y".repeat(5000), gone: undefined });
  const [event] = log.recentEvents();
  assert.deepEqual(event.fields?.error, { name: "Error", message: "boom", code: "EPIPE" });
  assert.equal(/** @type {string} */ (event.fields?.long).length, 4003);
  assert.equal("gone" in (event.fields ?? {}), false);
});

test("getLogger is a process-wide singleton that tests can replace", () => {
  const replacement = createLogger({ env: {}, stderr: sink() });
  setLogger(replacement);
  assert.equal(getLogger(), replacement);
  setLogger(null);
  const fresh = getLogger();
  assert.notEqual(fresh, replacement);
  assert.equal(getLogger(), fresh);
});

test("AGENT_LINK_DEBUG uses the shared flag semantics (1/true/yes/on)", () => {
  for (const value of ["1", "true", "YES", "on"]) assert.equal(resolveLogLevel({ AGENT_LINK_DEBUG: value }), "debug", value);
  for (const value of ["0", "false", "no", "off", "maybe"]) assert.equal(resolveLogLevel({ AGENT_LINK_DEBUG: value }), "warn", value);
});

test("an existing looser log file is tightened to 0600 on first write", () => {
  const file = path.join(mkdtempSync(path.join(tmp, "loose-")), "old.log");
  writeFileSync(file, "", { mode: 0o644 });
  const log = createLogger({ env: { AGENT_LINK_LOG_FILE: file }, stderr: sink() });
  log.warn("w.event");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a relative AGENT_LINK_LOG_FILE disables the file with one notice and never throws", () => {
  const stderr = sink();
  const log = createLogger({ env: { AGENT_LINK_LOG_FILE: "relative.log" }, stderr });
  assert.equal(log.filePath, null);
  log.warn("w.event");
  assert.match(stderr.lines[0], /log\.file_disabled.*AGENT_LINK_LOG_FILE must be an absolute path/);
});
