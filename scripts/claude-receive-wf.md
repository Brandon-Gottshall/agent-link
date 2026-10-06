# WF Checklist: Claude Receive Direction (agent-link)

This is a low-context Workflow-Complete (WF) checklist for the **receive** side of the
`agent-link` plugin in Claude Desktop. It follows this WF doctrine:

> Regression tests prove the app still works as built. WF tests prove a low-context
> user can actually use it.

The receiving agent gets **no codebase context, no implementation hints, and no
hidden routes** beyond what is in this checklist. The agent is expected to use
its visible product cues (MCP tool listings, hook-injected prompts, tool results
in the transcript) to discover and complete each item.

The orchestration helper `scripts/claude-receive-wf.live.js` only prepares the
environment (inserts a single test message into the local JSONL mailbox
addressed to the receiver session). It does not drive the receiver's UI.

---

## Context (give this to the receiving agent)

- **Product:** `agent-link` MCP plugin running inside a real Claude Desktop session.
- **Entry surface:** the running Claude Desktop session itself. There is no URL.
- **Persona:** capable Claude Desktop user / agent who knows the `agent-link`
  plugin is installed but has not read its source.
- **Build/version:** record `git log --oneline -1` of the plugin worktree at run time.
- **Allowed credentials:** none required.
- **Setup performed by orchestration helper:**
  1. A single test message was inserted into the agent-link mailbox addressed
     to the receiver's `local_<uuid>` sessionId.
  2. The body is recognizable and starts with `WF test ping `.
  3. The orchestration helper printed the inserted `messageId`, target
     `sessionId`, and exact body string. Capture those for evidence.

## Success criteria (overall)

- The receiving agent reaches each checklist item using only what is visible in
  the Claude Desktop UI / MCP transcript.
- The receiving agent does **not** read `src/`, the mailbox JSONL file, or the
  notify-hook source to learn how to proceed.
- Pending mail is surfaced into the visible transcript (not hidden in
  additionalContext only) by the time item 3 completes.

---

## Checklist

For each item, record:

- **outcome:** `pass | partial | fail`
- **path taken:** ordered list of MCP tool calls or UI actions
- **confusion:** where the agent hesitated, guessed, or backtracked
- **evidence:** exact user-facing text (quoted) that supports the outcome
- **severity (only if not pass):** `P0 | P1 | P2 | P3` per the global severity model
- **issue class (only if not pass):** UX/discoverability | workflow logic | state/persistence | backend/runtime bug

---

### 1. Discoverability — find the agent-link tool surface

**Instruction:** Without being told the tool names, ask "what MCP tools are
available from agent-link?" or use the `/mcp` listing surface. Find the names of
the tools the agent would use to (a) read inbound mail, (b) reply to an inbound
message, (c) send a message to another Claude session, (d) inspect the mailbox
audit trail, (e) wait for a reply, (f) list other Claude sessions.

**Pass when:** the agent can name `read_agent_link_inbox`,
`reply_agent_link_message`, `message_claude_session`, `agent_link_mailbox_inspect`,
`wait_for_claude_session`, and `list_claude_sessions` (or
`list_loaded_claude_sessions`) from the visible tool listing. If a tool is
missing from the listing, that is a `P0` finding (the host did not load the
plugin or the tool name has drifted from the docs).

---

### 2. Receive notification — pending mail surfaces on the next prompt

**Instruction:** The orchestration helper has already inserted one test message
addressed to this session. Send the receiver agent any user prompt (e.g. "What
is on my plate?"). Observe what the receiver does on its next turn.

**Pass when:** the receiver acts on a model-only notification that mail is
pending and calls `read_agent_link_inbox` *before* answering the user prompt.
The user-facing transcript should include the resulting `read_agent_link_inbox`
tool call and its result block.

**Partial when:** the receiver eventually calls `read_agent_link_inbox` but only
after the user prompts a second time, or after the user manually mentions
agent-link.

**Fail when:** the receiver answers the user prompt without ever calling
`read_agent_link_inbox`, or claims there is no mail when the helper confirms one
is queued. Severity defaults to `P1` (the message is silently lost from the
visible transcript even though it remains in the mailbox).

---

### 3. Read the message body — body is visible verbatim

**Instruction:** Have the receiver state the body of the inbound message
verbatim. The body should match the string the orchestration helper printed.

**Pass when:** the body in the transcript exactly matches the helper's printed
body. The body must come from the `read_agent_link_inbox` tool result (visible
in the transcript), not from `additionalContext` (which is hidden from the
user).

**Fail when:** the body is paraphrased only, or the agent reports it can see
the body but the visible transcript shows only a generic "you have mail"
notification with no body. Severity `P1` — leaking the body via
`additionalContext` only would defeat the visibility contract.

---

### 4. Reply — round-trip via `reply_agent_link_message`

**Instruction:** Have the receiver reply to the sender. The sender is identified
in the inbound message envelope as `from="local_<uuid>" fromHarness="claude" fromVerified="true"`.
The receiver should call `reply_agent_link_message` with `messageId` set to the
inbound message id and `body` set to a short reply.

**Pass when:** the call returns `{messageId, delivery, target}` with no
`error`. The visible tool-call payload includes the inbound `messageId`.

**Partial when:** the receiver falls back to `message_claude_session` and the
reply succeeds with `replyToMessageId` set, but does not use the simpler reply
helper.

**Fail when:** the reply is sent only as natural-language text in the receiver's
turn, with no Agent Link reply/send tool call. Severity `P2`.

---

### 5. Inbox-empty after read — drained state is visible

**Instruction:** Have the receiver call `read_agent_link_inbox` a second time
(no arguments).

**Pass when:** the tool result contains `<agent-link-inbox count="0"/>`,
indicating the mailbox is empty for this session.

**Fail when:** the original message is returned a second time. That means the
first call did not drain (state/persistence bug, severity `P1`).

---

### 6. Visible audit trail — `agent_link_mailbox_inspect` shows both messages

**Instruction:** Have the receiver call `agent_link_mailbox_inspect` filtered
by `toSessionId` equal to its own sessionId, and again filtered by
`fromSessionId` equal to its own sessionId. Across the two calls the agent
should be able to point to:

- the original inbound message (with body matching what the helper printed,
  and `acknowledged_at` non-null after the receiver's reply if `replyToMessageId`
  was set)
- the receiver's own reply (with `reply_to_message_id` matching the inbound
  message's `id`)

**Pass when:** both messages are visible in the inspect results and the
`reply_to_message_id` linkage is intact.

**Partial when:** both messages exist but the linkage is missing because
item 4 used a manual send and omitted `replyToMessageId`.

**Fail when:** the inspect tool errors, returns nothing, or omits one side of
the round-trip. Severity `P1` (audit trail gap).

---

## Reporting template

Use the format below 
when writing the run record. Save runs under
`docs/wf-runs/YYYY-MM-DD-claude-receive.md`.

```md
# WF Run Report — Claude Receive

## Context
- Product: agent-link (Claude receive direction)
- Entry surface: real Claude Desktop session
- Persona: capable Claude Desktop user, no repo context
- Agent constraints: no codebase access, no hidden routes
- Build/version: <git log --oneline -1>
- Receiver sessionId: local_<uuid>
- Inserted messageId: <ulid>
- Inserted body: WF test ping <iso-timestamp>

## Checklist Results
1. [pass/fail/partial] Discoverability
   Path taken:
   Confusion:
   Evidence:
   Severity if failed:

2. [pass/fail/partial] Receive notification on next prompt
   Path taken:
   Confusion:
   Evidence:
   Severity if failed:

3. [pass/fail/partial] Read message body verbatim
   Path taken:
   Confusion:
   Evidence:
   Severity if failed:

4. [pass/fail/partial] Reply via message_claude_session
   Path taken:
   Confusion:
   Evidence:
   Severity if failed:

5. [pass/fail/partial] Inbox empty after read
   Path taken:
   Confusion:
   Evidence:
   Severity if failed:

6. [pass/fail/partial] Visible audit trail (mailbox_inspect)
   Path taken:
   Confusion:
   Evidence:
   Severity if failed:

## Findings
- P0:
- P1:
- P2:
- P3:

## Overall Verdict
- WF status: pass | fail | partial
- Blocking issues:
- Recommended follow-up:
```
