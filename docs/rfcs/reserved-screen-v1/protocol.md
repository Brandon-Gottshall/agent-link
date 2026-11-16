# Protocol and enrollment · version 1

Every method requires integer protocol_version 1 and rejects unknown fields. On success return {ok, protocol_version, result}; errors carry code and user-readable recovery. Mutations carry immutable request IDs and are deduplicated by principal and ticket (owner controls by control request ID). Canonical payload digests reject conflicting reuse. A receipt records the disposition at that time; status is current.

| Desktop tool suffix | Inputs in addition to protocol_version | Scope and result |
|---|---|---|
| capabilities | — | Enrolled connection; qualified scopes, capacity references, selected display, limits and broker/driver identity |
| submit | request_id, title, scope_id, start_deadline, capacity_claim_id, capacity_claim_start_by | Scoped task grant plus validated claim; durable ticket, eligibility and next action |
| status | ticket_id | Own ticket or explicit observer; task, authority, delivery, effect and handover |
| claim | request_id, ticket_id | First eligible ticket; lease, epoch and expiry if admitted |
| heartbeat | ticket_id, lease_id, epoch | Live-holder proof; renewed expiry. Cannot mint authority |
| observe | ticket_id, lease_id, epoch, scope_id | Current read scope; redacted tree, scoped refs and snapshot |
| act | request_id, ticket_id, lease_id, epoch, snapshot_id, ref, operation, allowed value | Current effect grant; intent before issuance, delivery and effect state |
| verify | ticket_id, action_id, scope_id | Fresh separately authorized observation and known/unknown outcome. No action replay |
| cancel | request_id, ticket_id | Own ticket; durable cancellation and active settlement |
| release | request_id, ticket_id, lease_id, epoch, result | Current holder; terminal outcome only after quiescence; partial or uncertain state persists |

Epoch milliseconds express deadlines; 30-second heartbeats and 90-second expiry are initial policies. Admission rechecks both start deadlines and current capacity authority at first invocation. Polling and ticket offers spend no claim. A validated finite claim references the external accountable producer. Tools cannot enroll, acquire additional grants, launch another agent, accept caller credentials or declare their own identity.

The installation/controller uses a mode-0600 local secret and a private socket. The broker binds the actual socket peer and inspected host ancestor to process start identities and a server-issued principal. Controller attestation ties that binding to a verified loaded Claude/Codex session and explicitly grants task, read and effect scope. Missing reliable session evidence holds enrollment. Grants live on the enrolled connection and are unavailable to the model; MCP labels, peer-supplied IDs and ordinary task fields carry no authority. A disconnect may make the grant unusable immediately, while the task's authority settles only on confirmed loss, expiry or revoke. Expose stop, reclaim, restore and cancel for the separately authenticated GUI Queue/controller; stop never trusts a displayed lease epoch.

This is a cooperative same-user boundary. Local credentials and the operator path do not establish protection from a hostile shell running as the same macOS user.
