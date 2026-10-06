import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openMailbox } from "../../src/claude/mailbox.js";
import { makeAgentLinkChannelBridge, renderChannelMessage } from "../../src/claude/channel-bridge.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-channel-"));
const mailboxPath = path.join(tmp, "mailbox.jsonl");
const session = { sessionId: "local_code", cliSessionId: "uuid-code", surface: "code" };

{
  const rendered = renderChannelMessage({
    id: "01TEST",
    from_session_id: "local_sender",
    from_session_kind: "codex",
    body: "hello channel"
  });
  assert.match(rendered.content, /<agent-link-message/);
  assert.match(rendered.content, /hello channel/);
  assert.equal(rendered.meta.message_id, "01TEST");
  assert.equal(rendered.meta.from_session_id, "local_sender");
  assert.equal(rendered.meta.from_kind, "codex");
}

{
  const mb = openMailbox({ mailboxPath });
  const messageId = mb.insertMessage({
    fromSessionId: "local_sender",
    fromSessionKind: "codex",
    toSessionId: "local_code",
    toSessionKind: "claude",
    body: "channel payload"
  });
  mb.close();

  const notifications = [];
  const bridge = makeAgentLinkChannelBridge({
    resolveCurrentSession: () => session,
    mailboxOpener: () => openMailbox({ mailboxPath }),
    notify: async (notification) => notifications.push(notification)
  });

  const result = await bridge.pollOnce();
  assert.equal(result.delivered, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, "notifications/claude/channel");
  assert.equal(notifications[0].params.meta.message_id, messageId);
  assert.match(notifications[0].params.content, /channel payload/);

  const check = openMailbox({ mailboxPath });
  assert.equal(check.listPendingFor({ toSessionId: "local_code" }).length, 0);
  assert.ok(check.inspect({ toSessionId: "local_code" })[0].delivered_at);
  check.close();
}

// Idle cost: unchanged mailbox is skipped with a single stat(); the session is
// resolved once; the timer backs off exponentially to the cap.
{
  const idlePath = path.join(tmp, "idle-mailbox.jsonl");
  fs.writeFileSync(idlePath, "");
  let resolves = 0;
  let opens = 0;
  const notifications = [];
  const bridge = makeAgentLinkChannelBridge({
    resolveCurrentSession: () => {
      resolves += 1;
      return session;
    },
    mailboxPath: idlePath,
    mailboxOpener: () => {
      opens += 1;
      return openMailbox({ mailboxPath: idlePath });
    },
    notify: async (n) => notifications.push(n),
    pollIntervalMs: 20,
    maxPollIntervalMs: 160,
    watch: false
  });

  assert.equal((await bridge.pollOnce()).delivered, 0);
  assert.equal((await bridge.pollOnce()).skipped, "unchanged");
  assert.equal(opens, 1, "unchanged mailbox is not re-read");

  bridge.start();
  await new Promise((r) => setTimeout(r, 1000));
  const stats = bridge.stats();
  bridge.stop();
  // Fixed 20 ms polling would be ~50 ticks; backoff 20->40->80->160 caps it.
  assert.ok(stats.ticks <= 12, `backoff limits ticks (saw ${stats.ticks})`);
  assert.equal(stats.delayMs, 160, "delay reached the cap");
  assert.equal(resolves, 1, "session resolved once");
  assert.equal(opens, 1, "idle ticks never reopen the mailbox");

  // A new message changes the signature and is delivered on the next tick.
  const mb = openMailbox({ mailboxPath: idlePath });
  mb.insertMessage({ fromSessionId: "s", fromSessionKind: "codex", toSessionId: "local_code", toSessionKind: "claude", body: "after idle" });
  mb.close();
  assert.equal((await bridge.pollOnce()).delivered, 1);
  assert.equal(notifications.length, 1);
}

// fs.watch wakes a backed-off bridge immediately when the mailbox changes.
{
  const watchDir = fs.mkdtempSync(path.join(tmp, "watch-"));
  const watchPath = path.join(watchDir, "mailbox.jsonl");
  fs.writeFileSync(watchPath, "");
  const notifications = [];
  const bridge = makeAgentLinkChannelBridge({
    resolveCurrentSession: () => session,
    mailboxPath: watchPath,
    mailboxOpener: () => openMailbox({ mailboxPath: watchPath }),
    notify: async (n) => notifications.push(n),
    pollIntervalMs: 10_000,
    maxPollIntervalMs: 30_000
  });
  bridge.start();
  assert.equal(bridge.stats().watching, true);
  await new Promise((r) => setTimeout(r, 100));
  const mb = openMailbox({ mailboxPath: watchPath });
  mb.insertMessage({ fromSessionId: "s", fromSessionKind: "codex", toSessionId: "local_code", toSessionKind: "claude", body: "wake" });
  mb.close();
  const deadline = Date.now() + 3000;
  while (notifications.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  bridge.stop();
  assert.equal(notifications.length, 1, "watcher delivered well before the 10 s poll");
}

// No resolvable session: ticks back off and stay cheap.
{
  let resolves = 0;
  const bridge = makeAgentLinkChannelBridge({
    resolveCurrentSession: () => {
      resolves += 1;
      return null;
    },
    mailboxPath: path.join(tmp, "none.jsonl"),
    notify: async () => {},
    pollIntervalMs: 20,
    maxPollIntervalMs: 160,
    watch: false
  });
  bridge.start();
  await new Promise((r) => setTimeout(r, 1000));
  bridge.stop();
  assert.ok(resolves <= 12, `unresolved session retried on backoff (saw ${resolves})`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("channel-bridge tests passed");
