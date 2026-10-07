// Child process for tests/claude/resolution-race.test.js: imports the
// handlers from SRC_ROOT (this checkout by default), signals ready, waits for
// the go file, then resolves one message and prints the outcome as JSON.
//   node resolve-racer.js <srcRoot> <mailboxPath> <messageId> <mode> <readyFile> <goFile>
// mode: reply | decline | done | send (message_claude_session with replyToMessageId)
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [srcRoot, mailboxPath, messageId, mode, readyFile, goFile] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(path.join(srcRoot, rel)).href);
const { openMailbox } = await load("src/claude/mailbox.js");
const { makeReplyAgentLinkMessageHandler } = await load("src/tools/claude-reply.js");
const { makeClaudeSendHandler } = await load("src/tools/claude-send.js");

const uuid = (n) => `7a000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const session = (n) => ({ sessionId: `local_${uuid(n)}`, cliSessionId: uuid(n), surface: "code", loaded: true, title: `S${n}` });
const SENDER = session(1);
const RECEIVER = session(2);
const deps = {
  host: "claude",
  listSessions: () => [SENDER, RECEIVER],
  mailboxOpener: () => openMailbox({ mailboxPath }),
  resolveCurrentSession: () => RECEIVER,
  appendReceipt: async () => ({ ok: true })
};
writeFileSync(readyFile, "1");
while (!existsSync(goFile)) await new Promise((resolve) => setImmediate(resolve));
try {
  if (mode === "send") {
    await makeClaudeSendHandler(deps).message_claude_session({ sessionId: SENDER.sessionId, message: "answer by send", replyToMessageId: messageId });
  } else {
    await makeReplyAgentLinkMessageHandler(deps).reply_agent_link_message({ messageId, resolution: mode, message: `${mode} text` });
  }
  process.stdout.write(JSON.stringify({ mode, ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ mode, ok: false, code: error?.errorCode ?? String(error) }));
}
