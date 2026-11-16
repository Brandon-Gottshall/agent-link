# Lifecycle, cutover and recovery

The per-user journal has one writer, private permissions, atomic durable updates and initialization/install identity. Corruption or missing established state closes admission. Preserve tickets, epochs, idempotency receipts, stop latch and unresolved intents across restart. Restart closes admission and requires trusted restore. Terminal records persist. Observation artifacts may be discarded only when no retained unresolved intent or receipt refers to them.

Eligible tickets are FIFO. Queue status explains skips and blockers. One live or settling lease and one in-flight driver invocation globally. Epochs advance on grant, revocation and restoration. Intent precedes spawn. Stop/reclaim linearizes at the durable latch and epoch advance. Owner controls run outside driver waits, return visible settling immediately and preserve old idempotent receipts across deliberate restore.

The normal driver budget is 15 seconds, with 2 additional seconds for owned termination and quiescence checking before reporting blocked settling. A wrapper exit or signal receipt is insufficient. Use exact process lifetime and account for all effect-capable children/helpers. Unprovable quiescence remains visibly blocked. Release and restoration cannot bypass it. Earlier effects may appear later and remain attributed to the earlier action. The supported fence is command admission. Runtime verification must demonstrate the limits of stock Vercel fallbacks.

| Stage | Legacy | Broker | Evidence |
|---|---|---|---|
| Prepare | Preserve admissions and existing work | Isolated closed candidate | Consumer/writer inventory, staged configuration and rollback |
| Drain | Close admissions, terminally reconcile old goals without relabeling them as executed tickets | Closed | All prior holders and claims accounted for |
| Promote | Closed | Install exact clean-main commit, closed | Build identity and loaded copies reconciled |
| Activate | Runtime refusal or explicitly verified shim | Trusted restore | Real Claude and Codex positive and negative challenges |
| Rollback | Closed until separately proven and authorized | Stop, settle, preserve journals | Both gates closed first |

Inventory actual Claude Desktop/CLI, Codex app/CLI, Cursor, Antigravity and Grok routes without invoking a Grok model. Label effective paths runtime-disabled, broker-mediated, instruction-only or unknown. Unknown effect-capable routes block activation. Preserve legacy records; hold stale sessions from driving. Antechamber remains available through its own controls.
