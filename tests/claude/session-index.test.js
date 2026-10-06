import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listClaudeSessions, resolveCurrentClaudeSession } from "../../src/claude/session-index.js";

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
console.log("session-index tests passed");
