import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import * as sessionIndex from "../../src/claude/session-index.js";

const { listClaudeSessions, resolveCurrentClaudeSession } = sessionIndex;
// Optional exports are read through the namespace so this file still loads
// (and fails on assertions, not on import) against older modules.
const findClaudeSessionById = (...args) => sessionIndex.findClaudeSessionById(...args);
const isClaudeSessionLoaded = (...args) => sessionIndex.isClaudeSessionLoaded(...args);

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "claude-sidecars");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-session-index-"));
const desktopRoot = path.join(tmp, "local-agent-mode-sessions");
const codeRoot = path.join(tmp, "claude-code-sessions");
const projectsRoot = path.join(tmp, "projects");
fs.mkdirSync(path.join(desktopRoot, "account", "org"), { recursive: true });
fs.mkdirSync(path.join(codeRoot, "account", "org"), { recursive: true });
fs.mkdirSync(path.join(projectsRoot, "-tmp-proj"), { recursive: true });

function writeSidecar(root, session) {
  fs.writeFileSync(
    path.join(root, "account", "org", `${session.sessionId}.json`),
    JSON.stringify(session, null, 2)
  );
}

writeSidecar(desktopRoot, {
  sessionId: "local_desktop",
  cliSessionId: "uuid-desktop",
  processName: "desktop-session",
  cwd: "/desktop/project",
  model: "opus",
  title: "Desktop target",
  isArchived: false
});

writeSidecar(desktopRoot, {
  sessionId: "local_archived",
  cliSessionId: "uuid-archived",
  processName: "archived-session",
  cwd: "/desktop/archived",
  model: "opus",
  title: "Archived target",
  isArchived: true
});

writeSidecar(codeRoot, {
  sessionId: "local_code",
  cliSessionId: "uuid-code",
  processName: "code-session",
  cwd: "/code/project",
  model: "sonnet",
  title: "Code target",
  isArchived: false
});

fs.writeFileSync(
  path.join(projectsRoot, "-tmp-proj", "uuid-transcript.jsonl"),
  JSON.stringify({
    type: "session",
    sessionId: "uuid-transcript",
    timestamp: "2026-06-18T12:00:00.000Z",
    cwd: "/tmp/proj",
    title: "Transcript fallback"
  }) + "\n"
);

const psOutput = "/usr/local/bin/claude --resume uuid-code --model sonnet\n";

{
  const sessions = listClaudeSessions({ desktopRoot, codeRoot, projectsRoot, psOutput });
  const desktop = sessions.find((s) => s.sessionId === "local_desktop");
  const code = sessions.find((s) => s.sessionId === "local_code");
  const transcript = sessions.find((s) => s.cliSessionId === "uuid-transcript");

  assert.equal(sessions.find((s) => s.sessionId === "local_archived"), undefined);

  assert.equal(desktop.surface, "desktop");
  assert.equal(desktop.supportsHookInbox, true);
  assert.equal(desktop.supportsChannel, false);

  assert.equal(code.surface, "code");
  assert.equal(code.loaded, true);
  assert.equal(code.supportsChannel, true);
  assert.equal(code.supportsHookInbox, true);

  assert.equal(transcript.surface, "code");
  assert.equal(transcript.sessionId, "local_uuid-transcript");
  assert.equal(transcript.source, "transcript");
}

{
  const sessions = listClaudeSessions({ desktopRoot, codeRoot, projectsRoot, psOutput, includeArchived: true });
  assert.equal(sessions.find((s) => s.sessionId === "local_archived")?.isArchived, true);
}

{
  const codeOnly = listClaudeSessions({ desktopRoot, codeRoot, projectsRoot, psOutput, surface: "code" });
  assert.ok(codeOnly.every((s) => s.surface === "code"));
  assert.ok(codeOnly.find((s) => s.sessionId === "local_code"));
  assert.equal(codeOnly.find((s) => s.sessionId === "local_desktop"), undefined);
}

{
  const current = resolveCurrentClaudeSession({
    sessionId: "uuid-code",
    desktopRoot,
    codeRoot,
    projectsRoot,
    psOutput
  });
  assert.equal(current.sessionId, "local_code");
  assert.equal(current.surface, "code");
}

fs.rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Fresh roots per scenario, so cached parses from the blocks above never mask
// a regression.
function makeRoots(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `agent-link-${prefix}-`));
  const roots = {
    base,
    desktopRoot: path.join(base, "local-agent-mode-sessions"),
    codeRoot: path.join(base, "claude-code-sessions"),
    projectsRoot: path.join(base, "projects")
  };
  fs.mkdirSync(path.join(roots.codeRoot, "acct", "org"), { recursive: true });
  fs.mkdirSync(roots.desktopRoot, { recursive: true });
  fs.mkdirSync(roots.projectsRoot, { recursive: true });
  return roots;
}

function rootsOnly(r) {
  return { desktopRoot: r.desktopRoot, codeRoot: r.codeRoot, projectsRoot: r.projectsRoot };
}

function writeTranscript(projectsRoot, project, cliId, records, { mtime } = {}) {
  const dir = path.join(projectsRoot, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cliId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

const REAL_SHAPED = path.join(FIXTURE_DIR, "code-2026-10", "local_0b5e7c1a-3f2d-4a6e-9c8b-1d2e3f4a5b6c.json");
const REAL_CLI = "7f3c2b1a-0e9d-4c8b-a7f6-5e4d3c2b1a09";
const REAL_PRIOR_CLI = "11111111-2222-4333-8444-555555555555";
const REAL_SID = "local_0b5e7c1a-3f2d-4a6e-9c8b-1d2e3f4a5b6c";

// P4-01: a real-shaped sidecar (no processName) is listed with its title and
// archive state, and its transcript (current or prior CLI id) does not show
// up as a second session.
{
  const r = makeRoots("p401");
  fs.copyFileSync(REAL_SHAPED, path.join(r.codeRoot, "acct", "org", path.basename(REAL_SHAPED)));
  const transcript = writeTranscript(r.projectsRoot, "-Users-example-work-sample-project", REAL_CLI, [
    { type: "mode", sessionId: REAL_CLI, timestamp: "2026-09-01T00:00:00.000Z" }
  ]);
  writeTranscript(r.projectsRoot, "-Users-example-work-sample-project", REAL_PRIOR_CLI, [
    { type: "mode", sessionId: REAL_PRIOR_CLI }
  ]);
  const sessions = listClaudeSessions({ ...rootsOnly(r), psOutput: "", includeArchived: true });
  const matches = sessions.filter((s) => s.cliSessionId === REAL_CLI || s.cliSessionId === REAL_PRIOR_CLI);
  assert.equal(matches.length, 1, `sidecar and its transcripts are one session (saw ${matches.length})`);
  assert.equal(matches[0].sessionId, REAL_SID);
  assert.equal(matches[0].source, "sidecar:code");
  assert.equal(matches[0].title, "Sample real-shaped Code session");
  assert.equal(matches[0].isArchived, true);
  assert.equal(matches[0].transcriptPath, transcript, "sidecar inherits its transcript path");
  // Archived sessions stay out of the default listing.
  assert.equal(listClaudeSessions({ ...rootsOnly(r), psOutput: "" }).find((s) => s.sessionId === REAL_SID), undefined);
  fs.rmSync(r.base, { recursive: true, force: true });
}

// P4-01: a malformed sidecar is parsed once per (mtime, size), not on every
// listing.
{
  const r = makeRoots("p401cache");
  const bad = path.join(r.codeRoot, "acct", "org", "local_broken-sidecar.json");
  fs.writeFileSync(bad, "{ not json");
  const originalRead = fs.readFileSync;
  let badReads = 0;
  fs.readFileSync = function patched(file, ...rest) {
    if (String(file) === bad) badReads += 1;
    return originalRead.call(this, file, ...rest);
  };
  try {
    listClaudeSessions({ ...rootsOnly(r), psOutput: "" });
    listClaudeSessions({ ...rootsOnly(r), psOutput: "" });
    listClaudeSessions({ ...rootsOnly(r), psOutput: "" });
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(badReads, 1, `malformed sidecar re-read on every listing (${badReads} reads)`);
  fs.rmSync(r.base, { recursive: true, force: true });
}

// P4-02: subagent transcripts under <cli>/subagents/ are not sessions and
// never replace their parent.
{
  const r = makeRoots("p402");
  const parent = writeTranscript(r.projectsRoot, "-tmp-proj", "parent-cli", [
    { type: "mode", sessionId: "parent-cli", cwd: "/tmp/proj", title: "Parent session" }
  ]);
  const subDir = path.join(r.projectsRoot, "-tmp-proj", "parent-cli", "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "agent-a1.jsonl"), JSON.stringify({ sessionId: "parent-cli", cwd: "/tmp/proj" }) + "\n");
  const sessions = listClaudeSessions({ ...rootsOnly(r), psOutput: "" });
  assert.equal(sessions.length, 1, `only the top-level transcript is a session (saw ${sessions.length})`);
  assert.equal(sessions[0].transcriptPath, parent);
  assert.equal(sessions[0].title, "Parent session");
  fs.rmSync(r.base, { recursive: true, force: true });
}

// P4-03: lastActivityAt is the transcript's mtime, not its first record.
{
  const r = makeRoots("p403");
  const mtime = Date.parse("2026-09-30T12:00:00.000Z");
  writeTranscript(r.projectsRoot, "-tmp-proj", "old-start", [
    { type: "mode", sessionId: "old-start", timestamp: "2026-01-01T00:00:00.000Z" }
  ], { mtime });
  writeTranscript(r.projectsRoot, "-tmp-proj", "new-start", [
    { type: "mode", sessionId: "new-start", timestamp: "2026-06-01T00:00:00.000Z" }
  ], { mtime: mtime - 86_400_000 });
  const sessions = listClaudeSessions({ ...rootsOnly(r), psOutput: "" });
  const old = sessions.find((s) => s.cliSessionId === "old-start");
  assert.equal(Math.round(old.lastActivityAt / 1000), Math.round(mtime / 1000));
  assert.equal(sessions[0].cliSessionId, "old-start", "most recently written session sorts first");
  fs.rmSync(r.base, { recursive: true, force: true });
}

// Fake `ps` on PATH: records each call and prints a configurable listing.
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-fake-ps-"));
const psMarker = path.join(fakeBin, "calls.log");
const psOutputFile = path.join(fakeBin, "ps-output.txt");
fs.writeFileSync(path.join(fakeBin, "ps"), `#!/bin/sh\necho call >> "${psMarker}"\ncat "${psOutputFile}"\n`, { mode: 0o755 });
const originalPath = process.env.PATH;
process.env.PATH = `${fakeBin}:${originalPath}`;
const psCalls = () => (fs.existsSync(psMarker) ? fs.readFileSync(psMarker, "utf8").trim().split("\n").filter(Boolean).length : 0);

// P4-07: the current session resolves by id (sidecar by cliSessionId, then
// transcript) without running ps and without summarizing transcripts.
{
  const r = makeRoots("p407");
  fs.copyFileSync(REAL_SHAPED, path.join(r.codeRoot, "acct", "org", path.basename(REAL_SHAPED)));
  writeTranscript(r.projectsRoot, "-tmp-proj", "unrelated-cli", [{ sessionId: "unrelated-cli" }]);
  writeTranscript(r.projectsRoot, "-tmp-proj", "transcript-only-cli", [{ sessionId: "transcript-only-cli" }]);
  fs.writeFileSync(psOutputFile, "");
  const before = psCalls();
  const originalOpen = fs.openSync;
  let opens = 0;
  fs.openSync = function patched(...args) {
    opens += 1;
    return originalOpen.apply(this, args);
  };
  let viaSidecar;
  let viaTranscript;
  try {
    viaSidecar = resolveCurrentClaudeSession({ sessionId: REAL_CLI, ...rootsOnly(r) });
    viaTranscript = resolveCurrentClaudeSession({ sessionId: "transcript-only-cli", ...rootsOnly(r) });
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(psCalls() - before, 0, "resolving the current session must not run ps");
  assert.equal(opens, 0, "resolving the current session must not open transcripts");
  assert.equal(viaSidecar?.sessionId, REAL_SID, "canonical id is the sidecar id");
  assert.equal(viaSidecar.loaded, true, "the current session is loaded by definition");
  assert.equal(viaTranscript.sessionId, "local_transcript-only-cli");
  assert.equal(viaTranscript.source, "transcript");
  // Every id form finds the same session.
  assert.equal(findClaudeSessionById(REAL_SID, rootsOnly(r)).sessionId, REAL_SID);
  assert.equal(findClaudeSessionById(`local_${REAL_CLI}`, rootsOnly(r)).sessionId, REAL_SID);
  fs.rmSync(r.base, { recursive: true, force: true });
}

// W2A-15: ps output larger than Node's default 1 MiB buffer still marks the
// session loaded.
{
  const r = makeRoots("w2a15");
  writeTranscript(r.projectsRoot, "-tmp-proj", "big-ps-cli", [{ sessionId: "big-ps-cli" }]);
  const filler = "/usr/libexec/some-daemon --flag value\n".repeat(60_000);
  fs.writeFileSync(psOutputFile, filler + "/usr/local/bin/claude --resume big-ps-cli --model opus\n");
  assert.ok(fs.statSync(psOutputFile).size > 2 * 1024 * 1024);
  const sessions = listClaudeSessions(rootsOnly(r));
  assert.equal(sessions.find((s) => s.cliSessionId === "big-ps-cli")?.loaded, true, "large ps output must not report loaded=false");
  assert.equal(isClaudeSessionLoaded("big-ps-cli"), true);
  assert.equal(isClaudeSessionLoaded("not-running-cli"), false);
  fs.rmSync(r.base, { recursive: true, force: true });
}

process.env.PATH = originalPath;
fs.rmSync(fakeBin, { recursive: true, force: true });

// Ported from desktop-registry: substrings in unrelated commands must NOT
// count as loaded. `tail` lacks --resume; in `grep`, claude is an argument,
// not the program.
{
  const r = makeRoots("psmatch");
  writeTranscript(r.projectsRoot, "-tmp-proj", "uuid-a", [{ sessionId: "uuid-a" }]);
  writeTranscript(r.projectsRoot, "-tmp-proj", "uuid-b", [{ sessionId: "uuid-b" }]);
  const negative = "tail -f ~/.claude/log\ngrep claude --resume uuid-a /var/tmp/notes\n";
  const neg = listClaudeSessions({ ...rootsOnly(r), psOutput: negative });
  assert.equal(neg.find((s) => s.cliSessionId === "uuid-a").loaded, false);
  assert.equal(neg.find((s) => s.cliSessionId === "uuid-b").loaded, false);
  assert.equal(isClaudeSessionLoaded("uuid-a", { psOutput: negative }), false);
  const positive = "claude --resume uuid-a --whatever\nfoo --bar\n";
  const pos = listClaudeSessions({ ...rootsOnly(r), psOutput: positive });
  assert.equal(pos.find((s) => s.cliSessionId === "uuid-a").loaded, true);
  assert.equal(pos.find((s) => s.cliSessionId === "uuid-b").loaded, false);
  // A longer id that merely starts with the target id is a different session.
  assert.equal(isClaudeSessionLoaded("uuid-a", { psOutput: "claude --resume uuid-ab\n" }), false);
  fs.rmSync(r.base, { recursive: true, force: true });
}

// W2C-04: CLAUDE_CONFIG_DIR relocates the transcripts the index and the
// current-session resolver read.
{
  const r = makeRoots("w2c04");
  const configDir = path.join(r.base, "relocated-claude");
  writeTranscript(path.join(configDir, "projects"), "-tmp-proj", "relocated-cli", [{ sessionId: "relocated-cli" }]);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const sessions = listClaudeSessions({ desktopRoot: r.desktopRoot, codeRoot: r.codeRoot, psOutput: "" });
    assert.ok(sessions.find((s) => s.cliSessionId === "relocated-cli"), "listing reads $CLAUDE_CONFIG_DIR/projects");
    const current = resolveCurrentClaudeSession({ sessionId: "relocated-cli", desktopRoot: r.desktopRoot, codeRoot: r.codeRoot });
    assert.equal(current?.sessionId, "local_relocated-cli");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
  fs.rmSync(r.base, { recursive: true, force: true });
}

console.log("session-index tests passed");
