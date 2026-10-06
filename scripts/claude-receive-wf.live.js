#!/usr/bin/env node
// scripts/claude-receive-wf.live.js
//
// Orchestration helper for the Claude receive WF test (Phase 11 of the
// agent-link restructure plan). It does NOT drive the receiver's UI. It only:
//
//   1. Resolves a target Claude Desktop session (by `local_<uuid>` arg, or
//      lists registry candidates when no arg is given).
//   2. Inserts ONE recognizable test message into the local JSONL mailbox
//      addressed to that session.
//   3. Prints the inserted messageId, target sessionId, exact body, mailbox
//      path, and a pointer to the WF checklist.
//
// The actual WF test is performed by a human or low-context agent operating
// the receiver's Claude Desktop session. See:
//   scripts/claude-receive-wf.md
//
// Usage:
//   AGENT_LINK_LIVE=1 node scripts/claude-receive-wf.live.js                    # list sessions, exit
//   AGENT_LINK_LIVE=1 node scripts/claude-receive-wf.live.js local_<uuid>       # insert default body
//   AGENT_LINK_LIVE=1 node scripts/claude-receive-wf.live.js local_<uuid> --body "custom text"
//   AGENT_LINK_LIVE=1 node scripts/claude-receive-wf.live.js local_<uuid> --from local_<other-uuid>
//
// Optional env:
//   AGENT_LINK_MAILBOX_PATH  override mailbox JSONL path (defaults to
//                            ~/.agent-link/mailbox.jsonl)

import "./live-guard.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openMailbox, resolveMailboxPath } from "../src/claude/mailbox.js";
import { listClaudeSessions } from "../src/claude/session-index.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const CHECKLIST_PATH = path.join(REPO_ROOT, "scripts/claude-receive-wf.md");

function parseArgs(argv) {
  const out = { positional: [], body: null, from: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--body") { out.body = argv[++i] ?? null; continue; }
    if (a === "--from") { out.from = argv[++i] ?? null; continue; }
    if (a.startsWith("--body=")) { out.body = a.slice("--body=".length); continue; }
    if (a.startsWith("--from=")) { out.from = a.slice("--from=".length); continue; }
    out.positional.push(a);
  }
  return out;
}

function printHelp() {
  process.stdout.write(
`claude-receive-wf.live.js — environment prep for the Claude receive WF test.

Usage:
  AGENT_LINK_LIVE=1 node scripts/claude-receive-wf.live.js                       List candidate sessions and exit.
  AGENT_LINK_LIVE=1 node scripts/claude-receive-wf.live.js <local_uuid>          Insert a test message addressed to <local_uuid>.
  AGENT_LINK_LIVE=1 node scripts/claude-receive-wf.live.js <local_uuid> --body "..."   Custom body (must still start with "WF test ping" for recognizability).
  AGENT_LINK_LIVE=1 node scripts/claude-receive-wf.live.js <local_uuid> --from <local_other>   Override the synthetic sender id.

This script DOES NOT open Claude Desktop, click anything, or otherwise drive the
receiver's UI. It only seeds the mailbox. The receiving agent (human or
low-context model) then runs the checklist at:

  ${CHECKLIST_PATH}
`);
}

function loadSessions() {
  try {
    return listClaudeSessions({ surface: "desktop", includeArchived: true });
  } catch (err) {
    process.stderr.write(`error: failed to read Claude session registry: ${err.message}\n`);
    process.exit(2);
  }
}

function listCandidates(sessions) {
  if (!sessions.length) {
    process.stdout.write(
`No Claude Desktop sessions found in the local registry. Either:
  - Claude Desktop has not been launched against any local-agent-mode session, or
  - the registry roots are missing under ~/Library/Application Support/Claude/.

Re-run with an explicit local_<uuid> sessionId once a session exists.
`);
    return;
  }
  process.stdout.write("Candidate Claude Desktop sessions:\n\n");
  for (const s of sessions) {
    const loadedTag = s.loaded === true ? " [loaded]" : s.loaded === false ? " [offline]" : "";
    const title = s.title ?? "<no title>";
    const cwd = s.cwd ?? "<no cwd>";
    process.stdout.write(`  ${s.sessionId}${loadedTag}\n`);
    process.stdout.write(`    title: ${title}\n`);
    process.stdout.write(`    cwd:   ${cwd}\n`);
  }
  process.stdout.write(
`\nRe-invoke with one sessionId to insert the test message:

  AGENT_LINK_LIVE=1 node scripts/claude-receive-wf.live.js <local_uuid>

`);
}

function makeBody(custom) {
  const stamp = new Date().toISOString();
  if (custom && typeof custom === "string" && custom.length) {
    return custom;
  }
  return `WF test ping ${stamp} — please call read_agent_link_inbox and reply with "WF test pong" using reply_agent_link_message.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const sessions = loadSessions();

  if (args.positional.length === 0) {
    listCandidates(sessions);
    process.exit(0);
  }

  const target = args.positional[0];
  if (!/^local_[0-9a-f-]+$/i.test(target)) {
    process.stderr.write(
      `error: target sessionId must look like local_<uuid> (got: ${target})\n`
    );
    process.exit(2);
  }

  const known = sessions.find((s) => s.sessionId === target);
  if (!known) {
    process.stderr.write(
`warning: target sessionId ${target} is not in the local registry.
The mailbox will accept the insert anyway, but the receiver will only see the
message if a Claude Desktop session with that sessionId exists. Continuing.

`);
  }

  const fromSessionId = args.from && args.from.trim().length
    ? args.from.trim()
    : "local_wf-orchestrator";
  const body = makeBody(args.body);

  const mailboxPath = resolveMailboxPath();
  const mb = openMailbox();
  let messageId;
  try {
    messageId = mb.insertMessage({
      fromSessionId,
      fromSessionKind: "claude",
      toSessionId: target,
      toSessionKind: "claude",
      body,
      metadata: {
        receipt: {
          purpose: "wf-claude-receive",
          note: "Inserted by scripts/claude-receive-wf.live.js for the WF receive checklist."
        }
      },
      replyToMessageId: null
    });
  } finally {
    mb.close();
  }

  process.stdout.write(
`Inserted WF test message into the agent-link mailbox.

  messageId:        ${messageId}
  toSessionId:      ${target}${known ? " (registered)" : " (not in local registry)"}
  fromSessionId:    ${fromSessionId}
  mailbox path:     ${mailboxPath}
  body:
    ${body}

Next steps (the script stops here — it does not touch the receiver's UI):

  1. Open the receiver Claude Desktop session ${target} (or confirm it is
     already open). The next user prompt in that session should fire the
     agent-link UserPromptSubmit hook.
  2. Run the WF checklist against that session:
       ${CHECKLIST_PATH}
  3. Record outcomes per item (pass | partial | fail), severity for any
     non-pass, and save the run report under docs/wf-runs/.
`);
}

main().catch((err) => {
  process.stderr.write(`claude-receive-wf: ${err.stack || err.message}\n`);
  process.exit(1);
});
