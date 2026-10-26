# Collaboration memory: pointers, compact envelopes and obligations

Status: **design proposal, not adopted.** Nothing here changes behavior until the experiments below report and Routing picks the builders.

Spec: Factory amendment `FOS-COLLAB-MEMORY-AMEND-001` r1 (`~/Library/Application Support/Factory/controller/plans/FOS-COLLAB-MEMORY-AMEND-001-R1.md`, SHA-256 `6713a1d082e734c9d3301346159408a8c9c6c4fa7ea4774fc82d2f08112d2925`), requirements FOS-CMEM-01, -02, -04, -05, -06 and the transport side of -09.

Companion: `scrutable-native` branch `design/collab-memory-session-continuity`, which covers the dispatcher side.

## Why

Agent Link moves context between agents only as prose. A read-only pass over the live mailbox on 2026-10-26 (2,168 message bodies, 2,259 receipts) found:

| Observation | Value |
|---|---|
| Median / p90 / p99 body | 1,242 B / 2,554 B / 19,136 B |
| Bodies that embed file paths / 64-hex hashes as prose | 36% / 13% |
| Fixed envelope text per message (`<notice>` and attributes) | about 800 characters, roughly 40–60% of a median body |
| Messages that are the dependency-callback template | 315 (14.5%) |
| Messages needing reminders / reminders sent | 162 / 257 |
| Reply or action messages still unresolved | 197 of 817 |
| Receipts carrying `tokenUsage` / `durationMs` | 4 / 0 |

Owner direction (amendment §40 addendum):
- Pointers are the research priority for collaboration and model handoff.
- They become an implementation priority only after experiments establish the gains and tradeoffs.
- Fixed-budget waits are a nuisance, but budget logging must stay, for prediction.
- Actionable items should be handled one at a time and their ownership recorded outside model context.

## Order of work

1. **E1 baseline instrumentation (FOS-CMEM-01).** Nothing else is judged without it.
2. **E2 pointers and compact envelope experiment (FOS-CMEM-02, -04).**
3. **Wait and reminder changes (FOS-CMEM-05).** These are lower risk and independent of E2's result. They still need a Routing pick and review.
4. **Obligation states (FOS-CMEM-06).** These start once the ledger contract is agreed with the dispatcher side.

### 1. E1: instrumentation

Add to each receipt (`src/shared/receipt-index.js`, `src/delivery/message-status.js`):

- `envelopeBytes` and `bodyBytes` for every send.
- Stage timestamps: `sentAt`, `deliveredAt`, `acknowledgedAt`, `resolvedAt`, and derived durations.
- The tokens of the **consuming turn**: input, cache-read, cache-write, output and reasoning, kept as separate fields.
  - For Codex pushes, join through `clientUserMessageId = messageId` (`src/delivery/codex-push.js`) and the existing per-turn counter in `src/codex/token-usage.js`.
  - For Claude recipients, record null until a session-side reader exists.
- `waitedMs` for every wait, already returned. Persist it in the receipt.
- Drop null-only fields from new receipts, but never drop a field that carries a measurement. A missing value is recorded as `null` and never as zero.

Acceptance:
- Golden-replay tests (`tests/codex/golden-replay.test.js`) still pass.
- A WF fixture in `wf/agent-link/suite.json` produces receipts with every new field populated or explicitly null.

### 2. E2: pointers and the compact envelope

**Proposed `refs` field.** Add it to every send tool (`src/server/schemas.js`), rendered as a `<refs>` element by `src/shared/envelope.js`:

```json
{"refs": [{"kind": "file|commit|pr|thread-turn|record",
           "locator": "/abs/path or URI (human-readable)",
           "sha256": "…", "bytes": 1234,
           "originHost": "mac-mini|linux-…",
           "threadId": null, "turnId": null,
           "dataClass": "public|owner_approved_private|restricted"}]}
```

Rules:
- **Hash checks.** The receiver fetches on demand and checks `sha256`. A mismatch is reported as `stale` and the content is not used.
- **Readable references.** Locators stay readable, so an evaluator can expand any reference.
- **Cross-host.** A locator that the receiving host cannot resolve falls back to a content-addressed copy. If no copy exists, the ref is reported `unresolved`.
- **Data class.** Restricted refs are never rendered to a host that may not hold them.
- **Structured worker results.** `return_project_work_result` (`src/codex/project-orchestrator.js`, currently `"Project worker result\n\n" + JSON`) carries its fields as refs and structured attributes instead of JSON in the body.
- **Dependency handoffs.** `register_dependency_handoff` (`src/codex/dependency-handoff.js`) sends structured fields (producer, consumer, readiness condition, evidence ref, due) instead of the prose template.

**Notice once per session and version.** `PEER_NOTICE` (`src/shared/envelope.js`) is sent in full on the first delivery to a recipient session for a given notice version, then referenced by version. This reuses the role-procedure "first delivery of a version carries the full text" pattern (`src/registry/roles.js`).

**Experiment design** (criteria frozen before execution):
- **Arms:**
  - inline content with the per-message notice (today);
  - refs with the per-message notice;
  - refs with notice-once.
- **Ablations:**
  - perturbed hash: must be reported stale;
  - refs swapped between two tasks: must be detected or must hurt the outcome measurably;
  - refs stripped: tests causal reliance.
- **Metrics:**
  - resolution correctness;
  - turns to resolve;
  - tokens per resolved message, by unit;
  - extra fetch calls;
  - refs the receiver never fetched;
  - stale or unresolved refs, including cross-host;
  - data-class leaks.
- **Decision.** The thresholds that make refs an implementation priority are set in the research and review stage.

### 3. Waits and reminders

- **Incremental mailbox reads.** `view()` in `src/claude/mailbox.js` re-reads the whole `mailbox.jsonl` (5.6 MB) on every poll. That is about 22 MB/s per waiter at the 250 ms default (`src/delivery/message-wait.js:19`). Keep a cached view with a byte offset and parse only appended lines. Wake on `fs.watch` with the poll as fallback. Add mailbox rotation.
- **Early held/unreachable outcome.** A wait on a desktop-held Codex thread that cannot be woken, or on a target that is unreachable, returns `held` or `unreachable` immediately with the reason, instead of running to the timeout.
- **Cheap reminders.** Where the recipient harness supports it, a reminder is a hook note, not a full Codex model turn (`src/delivery/reminders.js`).
- **Send-key dedup (AL-SEND-KEY-01).** This is already specified in the PM requirements: `sendKey` and a payload hash, with `replayed: true` on duplicates. Implement it here.
- **Keep every wait log.** `waitedMs`, timeouts and outcomes stay in receipts as estimator input (FOS-CMEM-05; spec §49).

### 4. Obligation states

Mailbox states today are `message → delivered → acknowledged → resolved` (`src/claude/mailbox.js`). Proposed additions, aligned with the dispatcher's obligation ledger:
- **New states.**
  - `claimed`: owner named.
  - `acted`: needs an evidence ref.
  - `handed_off`: names the new owner.
  - `held`: names the blocker and recovery condition.
- **No inference from acknowledgment.** Acknowledgment never implies `acted`.
- **Structured check.** `check_coordination_obligations` (`src/codex/dependency-handoff.js`, regex scoring over prose) is replaced by a structured query over these states.
- **External watcher.** The watcher runs outside Agent Link (FOS-CMEM-08). Agent Link only exposes the states and evidence refs it needs.

## Non-goals

- No change to delivery authority, role policy, override policy, or who may message whom.
- No change to the Grok transport requirements (GT-1..GT-7). Refs must be compatible with GT-2 mailbox write-back.
- No new dependency beyond Node's standard library.

## Open questions for research

1. Where content-addressed copies live for cross-host refs, and who may write them.
2. Whether Claude-session consuming-turn tokens can be read without a model call.
3. Backlog threshold and batch/fork policy belong to the dispatcher. Agent Link needs only to expose queue depth.
