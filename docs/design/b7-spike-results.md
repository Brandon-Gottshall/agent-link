# B7 spike results (2026-10-07)

Evidence for R1.12a, R7.14 and R9.12 in [host-neutral-agent-link.md](host-neutral-agent-link.md). Raw logs stay out of the repo. Everything below was copied from observed output and scrubbed of local paths and account data. Thread ids are throwaway spike threads, and all of them are archived.

## Versions and method

- Agent Link's endpoint in the spike was a managed stdio `codex app-server` started from the installed CLI `codex-cli 0.159.2` with the owner's normal `CODEX_HOME`. A second CLI on `PATH` (Homebrew cask) is `0.148.0` and was not used.
- The desktop app was ChatGPT.app 154.0.8037.98, which bundles Codex (`Contents/Resources/codex-cli/.../codex`, `codex-cli 0.160.1`). No separate Codex.app was running.
- Protocol field names come from `codex app-server generate-json-schema` (0.159.2).
- Every spike thread had a fresh `mktemp -d` cwd, `sandbox: read-only`, `approvalPolicy: never`, and a name starting with "agent-link B7 spike (throwaway)". Prompts asked for a one-word reply with no tools.
- Turns: 43 of the 45 budgeted (40 `turn/start` turns + 3 `thread/compact/start`), plus one `turn/steer` and one `turn/start` that steered an active turn. Usage over the 40 turns: 1,586,962 input tokens (1,003,264 cached), 523 output tokens. The three compactions reported `totalTokens` of 17,494, 41,303 and 5,693. There were no auth, quota or rate-limit errors.
- Cached share = `cachedInputTokens / inputTokens` of the turn's last `thread/tokenUsage/updated`.

## A. Desktop app and daemon (R1.12a)

Process evidence (`ps -axo pid,ppid,args`, `lsof`):

| Observation | Evidence |
|---|---|
| The desktop app runs its own app-server | `ChatGPT` (main process) → child `codex -c features.code_mode_host=true app-server --analytics-default-enabled -c ...`. It has no `--listen` flag, so it uses the default `stdio://`. |
| That app-server talks to the app over stdio only | fds 0, 1 and 2 of the child are unix socketpair ends whose peers are fds of the `ChatGPT` main process. It has no listening socket and no TCP. |
| No daemon is running | `$CODEX_HOME/app-server-control/app-server-control.sock` does not exist. `codex app-server daemon version` → `failed to connect to …/app-server-control/app-server-control.sock … No such file or directory`. The daemon's pid files name pids that are no longer running, and `app-server-daemon/loaded-threads.json` is `[]`. The daemon was not started. |
| The desktop app has a separate IPC socket | `ChatGPT` listens on `$CODEX_HOME/ipc/ipc.sock` and holds 8 accepted connections. It is not the app-server control socket. It was not probed. |
| Rollout files show what is loaded where | The desktop app-server holds exactly one rollout JSONL open, for a thread created today. No other process has a rollout open. |

Rollout descriptor lifecycle on Agent Link's own endpoint (spike thread `01a11703-94f9-7382-bb4a-37f5f8d3ade5`):

| Step | Rollout fds held by our app-server | In `thread/loaded/list` |
|---|---|---|
| Before `thread/start` | 0 | `[]` |
| After `thread/start` (no turn yet) | 0 | yes |
| After the first turn completes (idle) | 1 | yes |
| After `thread/unsubscribe` (+1.5 s) | 1 | yes (unsubscribe did not unload it) |
| After `thread/archive` | 0 | n/a |

**Result: mailbox-only.** The desktop app's threads live in a private stdio app-server owned by the app. Neither the daemon socket nor a managed app-server can reach them, and both would be a second writer. No GUI test is needed under R1.12a.

**"Held" signal.** Agent Link's endpoint cannot see another process's loaded threads: its `thread/loaded/list` lists only its own threads. The rollout file descriptor is reliable in one direction only. If another pid has a thread's rollout open (`lsof -t <thread.path>`), that thread is loaded in another app-server, so it is held. The converse does not hold. A desktop window can show a thread whose app-server has not loaded it (the desktop app-server had one rollout open), and a check-then-push race remains. So the R1.12a fallback is the rule: every thread not loaded in Agent Link's own endpoint is held. The lsof check is diagnostic only and never grants push.

## B. Turn-completion signal (R7.14) and token usage timing (R9.10)

Order observed for a plain turn, in ms after the `turn/start` request:

```
thread/status/changed {active}           92
turn/started                              93
hook/started / hook/completed (x2)        1539–1864   owner's plugin hooks (sessionStart, userPromptSubmit)
item/started,completed userMessage       1865–1870
item/started agentMessage                5171
item/agentMessage/delta                  5175
item/completed agentMessage              5290
thread/tokenUsage/updated                5325
thread/status/changed {idle}             5341
turn/completed                           5342
```

In the same order on all 40 turns, `thread/tokenUsage/updated` for the final model request arrived 3–35 ms before `turn/completed`. It was never later.

Shapes (trimmed):

```json
{"method":"turn/started","params":{"threadId":"…","turn":{"id":"…","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":1791387474,"completedAt":null,"durationMs":null}}}
{"method":"turn/completed","params":{"threadId":"…","turn":{"id":"…","items":[{"type":"agentMessage","id":"msg_…","text":"ready","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null}],"itemsView":"summary","status":"completed","error":null,"startedAt":1791387474,"completedAt":1791387479,"durationMs":5267}}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"…","turnId":"…","tokenUsage":{"total":{"totalTokens":30415,"inputTokens":30410,"cachedInputTokens":13184,"cacheWriteInputTokens":0,"outputTokens":5,"reasoningOutputTokens":0},"last":{…same fields…},"modelContextWindow":258400}}}
{"method":"thread/status/changed","params":{"threadId":"…","status":{"type":"idle"}}}
{"method":"item/completed","params":{"item":{"type":"userMessage","id":"…","clientId":"spike-msg-1","content":[{"type":"text","text":"…","text_elements":[]}]},"threadId":"…","turnId":"…","completedAtMs":1791387476202}}
{"method":"thread/settings/updated","params":{"threadId":"…","threadSettings":{"cwd":"…","model":"gpt-6-astra","modelProvider":"openai","serviceTier":"priority","effort":"low","approvalPolicy":"never","approvalsReviewer":"user","sandboxPolicy":{"type":"readOnly","networkAccess":false},"collaborationMode":{…},"multiAgentMode":"explicitRequestOnly","personality":"pragmatic","summary":null,"activePermissionProfile":null,"disabledPluginIds":[]}}}
```

- The turn boundary is `turn/completed`, with `turn.status` one of `completed | interrupted | failed`. The final response is the `agentMessage` item with `phase:"final_answer"` in `turn.items`. `thread/status/changed` to `idle` arrives 0–1 ms earlier.
- `turn/steer` on an active turn returned `{"turnId": <active turn id>}`. The steer input was applied after the model request in flight finished. It became a second user message and a second model request inside the same turn, and the turn's final answer was the steered reply. That turn sent two `thread/tokenUsage/updated` with the same `turnId`, 1.7 s and 0.003 s before `turn/completed`.
- **`turn/start` on an active thread does not fail. It steers.** The response was `{turn:{id:<active turn id>, status:"inProgress"}}`, its input was added to the active turn (with its `clientUserMessageId`), and `turnTrigger` was ignored, as the schema says.
- `turn/interrupt {threadId, turnId}` → `{}`. Then `turn/completed` arrived with `status:"interrupted"`, `error:null` and no final answer. One `thread/tokenUsage/updated` for the interrupted turn id arrived 11 ms earlier, but its `last` repeated the previous request's numbers (no new request completed), so it is not that turn's usage.
- `thread/tokenUsage/updated` fires once per model request, not once per turn. `last` is the last request and `total` is cumulative for the thread. A turn's usage is the sum of `last` over every notification with that `turnId`. Equivalently, it is `total` at the turn's last notification minus `total` at the previous turn's last one.
- `thread/settings/updated` fired 13–35 ms after a `turn/start` that changed model, effort or cwd, and only then. It did not fire on turns without overrides or on `thread/fork`, where the `ThreadForkResponse` carries the settings.

## C. Cache measurements (R9.12)

Account: the thread default came from config: `gpt-6-astra`, effort `high`, `modelContextWindow` 258,400. `model/list` marks `gpt-6.1-sol` as `isDefault`. That model was the second one tested (window 258,400). The baseline context is about 30.3k input tokens before any conversation, from instructions, tools and the owner's plugins.

### C1–C3 in-place changes (two reps on separate threads)

| Step (rep1 / rep2) | inputTokens | cachedInputTokens | cached share |
|---|---|---|---|
| warm (first turn) | 30,330 / 30,330 | 13,184 / 13,184 | 0.435 / 0.435 |
| baseline | 30,360 / 30,360 | 30,208 / 30,208 | 0.995 / 0.995 |
| **effort high→low** | 30,390 / 30,390 | 13,184 / 0 | **0.434 / 0.000** |
| effort low→high (back to a warm effort) | 30,420 / 30,420 | 30,208 / 30,208 | 0.993 / 0.993 |
| **cwd change** | 30,578 / 30,580 | 30,208 / 30,208 | **0.988 / 0.988** |
| baseline | 30,609 / 30,611 | 30,336 / 30,464 | 0.991 / 0.995 |
| **model astra→sol** | 35,066 / 35,068 | 8,960 / 8,960 | **0.256 / 0.256** |
| baseline on sol (no override; model is sticky) | 35,096 / 35,098 | 34,944 / 34,944 | 0.996 / 0.996 |
| model sol→astra (back) | 39,489 / 39,491 | 30,464 / 30,464 | 0.772 / 0.771 |

1. **Effort change is not cache-neutral.** Moving to an effort not used recently on the thread dropped the cached share from 0.995 to 0.434 (rep1) and 0.000 (rep2), which is 0.44× and 0× of the previous share, below the 90% bar. Only the shared static prefix survived, or nothing did. Moving back to an effort used a turn earlier hit the warm prefix (0.993). R9.3's fallback applies.
2. **An in-place model switch loses the conversation cache.** The cached share was 0.256 in both reps. The 8,960 cached tokens are the static prefix shared across threads on the new model, so the share is not zero, but the whole conversation was read uncached. The switch also added about 4.4k input tokens (model-specific instructions). Switching back reused the original model's older prefix (0.77).
3. **A cwd change is cache-neutral.** The cached share was 0.988 against 0.993 before it, or 99.5% of the previous share. Input grew by about 158 tokens for the new environment context.

### C4 forks (`thread/fork` with `lastTurnId` = the original's last turn, `threadSource:"agent-link-fork"`, `excludeTurns:true`, a fresh cwd)

| Original (last turn in / cached) | Fork model | Fork first turn in / cached | cached share |
|---|---|---|---|
| rep1 thread (39,489 / 30,464) | gpt-6-astra (same) | 39,953 / 0 | 0.000 |
| rep1 thread | gpt-6.1-sol | 44,374 / 8,960 | 0.202 |
| rep2 thread (39,491 / 30,464) | gpt-6-astra (same) | 39,947 / 13,184 | 0.330 |
| rep2 thread | gpt-6.1-sol | 44,384 / 8,960 | 0.202 |

4. **A fork does not reuse the original's cache, even on the same model.** On its first turn the fork reads the inherited conversation uncached on any model. At most the cross-thread static prefix hits. The fork response carried `thread.forkedFromId`, `thread.threadSource:"agent-link-fork"`, the inherited `reasoningEffort` and `turns:[]`.

### C5 fork compaction

Each base thread got one build turn. It was then forked twice through that turn on the same model: fork U ran the follow-ups as is, and fork C ran `thread/compact/start` first. Each follow-up was a one-word turn.

| Context (composition) | U turn 1 in / cached | U turn 2 in / cached | Compaction (`last.totalTokens`, duration) | C turn 1 in / cached | C turn 2 in / cached |
|---|---|---|---|---|---|
| ~40k (≈8.5k filler as a user message) | 39,251 / 22,528 | 39,281 / 39,040 | 17,494, 8.0 s | 39,226 / 13,184 | 39,256 / 39,040 |
| ~56k (≈25.7k filler as a user message) | 56,139 / 22,528 | 56,169 / 55,936 | 41,303, 7.3 s | 56,180 / 13,184 | 56,210 / 56,064 |
| ~56k (≈25.4k filler as 3 assistant messages, via `thread/inject_items`) | 56,177 / 13,184 | — | 5,693, 8.1 s | 30,836 / 13,184 | 30,866 / 30,720 |

5. **Compaction keeps user messages verbatim and summarizes everything else.** The compacted fork's rollout `compacted` record has `replacement_history = [the user message (full text), one encrypted compaction item]`. With user-message context, compaction saved nothing (input +0.1%). With assistant context, the next request's input fell by 25.3k (−45%), down to roughly the 30.3k baseline. The compaction's `thread/tokenUsage/updated` has `last` with only `totalTokens` set (input, cached and output are 0), and `total` does not change, so its real input cost is not observable. Compaction runs as a turn: `turn/started` → `item/started contextCompaction` → `thread/tokenUsage/updated` → `item/completed contextCompaction` → `turn/completed`. `thread/compact/start` returns `{}` at once. No `thread/compacted` notification was seen.

Break-even, ~56k assistant context: the fork's first request is uncached with or without compaction (C4). Compacting therefore adds the compaction call plus an uncached read of the compacted context: 17.6k uncached on the first request, against 43.0k without compaction, plus the compaction call itself. In return, every later request reads about 25k fewer tokens, which would mostly have been cached. In raw input tokens it pays back within 1–3 requests, depending on what the compaction call really costs. Weighted by cache price it takes several requests. It also adds about 8 s and loses detail.

**Recommended `compactFork:"auto"` fraction: 0.5.** Compact when the original's last `inputTokens` is more than 0.5 × the fork model's `modelContextWindow` (129,200 tokens for both tested models). Reasons:

- Below half the window, a short fork task does not approach the window.
- Savings below that point fall mostly on cached tokens.
- Compaction does nothing for user-message context.
- It adds latency and loses detail.

Above half the window, a tool-loop task is likely to hit Codex's own mid-task compaction, and the non-user items compaction removes usually dominate. This is a judgment from the measured mechanics, not a fitted break-even: nothing was measured at 129k or more (turn budget). `compactFork:"always"` remains the opt-in below the threshold.

Noise: same-step numbers repeated to the token across reps, except the static-prefix hit on the first uncached read. That ranged from 0 to 22,528 cached tokens (0, 8,960, 13,184, 22,528) depending on cache routing. Shares that depend only on the conversation prefix (baselines 0.99+, cwd 0.988, model switch 0.256, other-model fork 0.202) were identical in both reps.

## D. Protocol notes against the design

| Design assumption | Observed (0.159.2) |
|---|---|
| `clientUserMessageId` on `turn/start` / `turn/steer` | Accepted. It comes back as **`clientId`** on the `userMessage` item (`item/started`, `item/completed`, `thread/read`), not as `clientUserMessageId`. |
| `turnTrigger:"agent-link"` | Accepted. It was not echoed on `turn/started` or `turn/completed`. It is ignored when `turn/start` steers. |
| `turn/start` when idle, `turn/steer` when active | `turn/start` on an active thread steers that turn (it returns the active turn id). It never fails because a turn is active. |
| `threadSource:"agent-link-fork"` | Accepted (`ThreadSource` is a free string) and echoed on `thread.threadSource`. |
| `lastTurnId` on fork | Works. The fork was cut at the given completed turn. The response has `forkedFromId`, `model`, `modelProvider`, `serviceTier`, `reasoningEffort` and `cwd`, plus the extra keys `runtimeWorkspaceRoots`, `activePermissionProfile` and `multiAgentMode`. |
| `thread/settings/updated` confirms applied settings | Yes, but only when a `turn/start` changes them. Its absence is not a mismatch. |
| Sticky model / effort / cwd on `turn/start` | Confirmed. A turn without overrides after a model switch ran on the new model. |
| `thread/tokenUsage/updated` per turn | It fires per model request. It arrives before `turn/completed`. A steered turn emits several. An interrupted turn emits a stale `last`. A compaction emits `last.totalTokens` only. |
| Default model | The `thread/start` response (config default) can differ from `model/list` `isDefault`. Read the effective model from `thread/start`, `thread/resume` or `thread/fork`. |
| `thread/archive` twice | The second call fails with `-32600 "no rollout found for thread id …"`. Treat it as already archived. |
| `thread/unsubscribe` | It did not unload the thread: the thread stayed in `thread/loaded/list` with its rollout open. |
| Desktop app reachable via daemon (R1.12) | No. The desktop app runs a private stdio app-server, and the daemon was not running (section A). |

## Spike threads (all archived)

Archive was verified with `thread/list {archived:true, searchTerm:"agent-link B7 spike"}`: all 16 are listed there, and none appears in the non-archived list.

`01a11703-94f9-7382-bb4a-37f5f8d3ade5`, `01a11704-d620-7b83-b939-bb121449f306`, `01a11705-68f4-7d70-957d-a04ee63dd8f5`, `01a11706-9cfe-73b1-b2e7-dfb806d16ec9`, `01a11706-b8a7-7921-a68a-b6f8516187d3`, `01a11706-cc4e-7c83-80a1-f1f60b8ed879`, `01a11706-df81-7761-adee-1808ed2f44d3`, `01a11706-f389-78e0-b927-e50898cc8c00`, `01a11707-03fe-7031-b2e3-4451795525b5`, `01a11707-1edb-7350-b39a-a30fe6de1832`, `01a11707-5d5a-7222-b6eb-99f24a2fedda`, `01a11707-7354-7aa1-9b94-abe6305624e2`, `01a11707-9625-7511-81b4-52567e572865`, `01a11708-b3e7-7442-bddb-1224050d9ab6`, `01a11708-cdb0-7c41-81cf-ac6f7dec6ae2`, `01a11708-e32b-77c1-9b61-f27808e6371c`.

## Prompt hook probe (B7b follow-up, 2026-10-07)

Evidence for R1.14a. codex-cli 0.159.2. Paths scrubbed.

| Check | How | Result |
|---|---|---|
| Plugin hook file | Agent Link installed into an isolated `CODEX_HOME`, then `hooks/list` | Without a manifest `hooks` field, Codex lists the three Claude hooks from `hooks/hooks.json` (`codex-agent-link@agent-link:hooks/hooks.json:session_start:0:0`, `...:user_prompt_submit:0:0`, `...:stop:0:0`), all `untrusted`. With `"hooks": "./hooks/codex-hooks.json"` it lists only `...:hooks/codex-hooks.json:user_prompt_submit:0:0`. `${PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` are substituted with the installed root. |
| Trust hash across versions | Same install at 0.5.0, then 0.5.1 | `currentHash` unchanged; the command path changed. |
| Per-process registration | `codex app-server -c 'hooks.UserPromptSubmit=[{hooks=[{type="command",command="<probe>",timeout=10}]}]'` | Listed as source `sessionFlags`, key `/<session-flags>/config.toml:user_prompt_submit:0:0`, `untrusted`. With `-c 'hooks.state={"<key>"={trusted_hash="<hash>"}}'` it is `trusted` and runs; other untrusted hooks stay skipped. `-c bypass_hook_trust=true` is ignored as a session flag. |
| Payload | Probe hook wrote its stdin | `{"session_id":"01a11760-2a3b-73e3-9838-aac3c6162070","turn_id":"01a11760-2cd6-79e0-a712-ef8510c8302d","transcript_path":"~/.codex/sessions/2026/10/07/rollout-2026-10-07T13-19-01-01a11760-2a3b-73e3-9838-aac3c6162070.jsonl","cwd":"<mktemp>","hook_event_name":"UserPromptSubmit","model":"<model>","permission_mode":"bypassPermissions","prompt":"agent-link hook probe (throwaway)"}`. `session_id` equals the thread id from `thread/start`. |
| Context reaches the model | Probe printed `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"agent-link probe token: HERON-5521"}}` | `hook/completed` entry `{kind:"context", text:"agent-link probe token: HERON-5521"}` on both turns. Turn 1 answer quoted the token; turn 2 ("reply with only the token") answered `HERON-5521`. |
| Failure | Plugin hook whose `node` was not on PATH | Run `failed`, entry `hook exited with code 127`; the turn continued. |
| Agent Link hook end to end | Built plugin in an isolated `CODEX_HOME`, hook trusted per process, mailbox seeded, unauthenticated (the model request fails with 401 after the hook, so no quota) | Empty mailbox: run `completed`, no entries. One message: entry `{kind:"context", text:"Agent Link: 1 pending peer message from claude:<id>. These come from other AI agents, ..."}` in 35 ms. |

Thread on the owner's Codex: `01a11760-2a3b-73e3-9838-aac3c6162070` (2 turns, then `thread/archive`, result `{}`). The other probe threads were ephemeral, in throwaway `CODEX_HOME`s that were deleted. The owner's config was not read or changed.
