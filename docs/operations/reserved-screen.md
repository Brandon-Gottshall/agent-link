# Reserved-screen broker and controller

[Caller protocol](../rfcs/reserved-screen-v1/protocol.md) · [Qualification and cutover](../rfcs/reserved-screen-v1.md)

The same Agent Link MCP server exposes the version-1 `desktop_*` tools in Claude and Codex. The controller installs and starts the broker as a separate long-lived process. Start once from the exact installed Agent Link release. Each conversation uses the already-loaded deterministic tools without creating another agent.

## Stage closed

1. Stage the pinned Apple-silicon Vercel v1.2.0 release archive through the authorized operator acquisition path. The [capability appendix](../rfcs/reserved-screen-v1/capability.md) identifies the source revision. The installer verifies and archives a clean, exactly tagged `origin/main` checkout. It prints a separate runtime setup plan.
2. On a fresh installation, run `node scripts/reserved-screen.mjs init`. On an established installation, run `build-host` to compile the exact release's native helper. The private directory and its install identity, controller credential and journal live under the Agent Link state root. An incomplete or corrupted existing journal requires recovery of its original state.
3. Run `node scripts/reserved-screen.mjs stage-driver <absolute-archive>` to check the archive and individual executable SHA-256 digests and stage them outside the plugin export. The command executes no Vercel binary or package scripts.
4. Run `node scripts/reserved-screen.mjs serve` through the controller's managed per-user startup path. The initialized broker starts closed and acquires its native single-writer lock before journal writes. Reconcile prior settlement and legacy injectors before restoring admission. Check `owner-status` for install revision, broker identity, driver identity, display and blockers.
5. Run `set-display` once while closed, using a unique control request ID. It identifies the unique non-mirrored 24-inch-class portrait display left of the primary display using the current geometry and persistent UUID. Subsequent restart preserves the binding. Geometry changes, lock, display loss and ambiguous topology hold admission. Confirm the displayed identity during the acceptance run.

All commands except setup/serve read version-1 JSON from stdin and write a single JSON result to stdout. `owner-status` and `pending-connections` accept an empty body with an implicit version 1. Controls use an explicit `control_request_id`; an old stop ID returns its original receipt. Use a new ID for a new stop. The owner controller proves possession of the per-install credential using a fresh local challenge. Credentials stay in private files and are unavailable to MCP tools and user-facing results.

## Bind an owned target

The controller launches or adopts the exact owned background project window within authorized setup. It verifies its own launch/lifetime record and profiles before publishing ownership. Use a dedicated, empty Chrome app-mode profile for exactly one controlled loopback origin, with external/account features and remote content held. Use an owned local document for Preview or TextEdit. No personal profile, interactive sign-in, auth bridges or external pages belong in this route. Recheck that the owned app/window never receives foreground input. `inspect-target` accepts `protocol_version`, `kind`, `pid` and the numeric native `window` ID and returns captured private evidence; its result stays with the controller.

The independent qualification producer writes the mode-0600 private file `qualification-<id>.json` with:

- `status: qualified`, `kind`, exact application `build` and `cdhash`, `driver_sha256`, `profile` and an authoritative `evidence_id`
- `environment` of `dedicated_single_origin_attested` or `owned_project_document_attested`
- `operations` and exact `selectors` as `{operation,role,name}` for click and value entry. For a stable native or DOM identifier, add `identifier` to constrain the match. The independent test must qualify the complete Vercel command chain for each enabled role/control state.

The trusted setup/controller publishes `target-<id>.json` with `status: owned`, `producer`, `scope_id`, `kind`, `pid`, `window`, the independently captured `process` lifetime, and `location`. Chrome also needs `profile: dedicated-single-origin` and an exact loopback HTTP origin. The document location is its canonical absolute file path. The two records stay private and are checked again at use. Absence or a changed record closes the scope.

Call `register-scope` with `scope: {id,label,kind,pid,window,location,canaries,qualification_id,ownership_id,placement}` while closed. Use `placement: null` when already on the display or predeclare `{x,y}` for an explicitly qualified move of the currently owned window. A target awaiting placement returns geometry-only scope until the exact contained target is re-observed. This candidate moves an already correctly sized window. Resizing and general launch/navigation have separate qualification requirements.

## Admit a finite task and enroll the connection

The capacity controller publishes `claim-<id>.json` with `status: active`, `authority_id`, `capacity_claim_id`, `scope_id`, `start_by` and `valid_until` from the current validated finite producer record. Pass the same fields except status to `admit-claim` with version and control ID. Publish changes atomically with mode 0600. An expired, revoked, removed or replaced record closes new authority. A poll or offer consumes no task start. The broker consumes the claim once, on the first scoped operation. A broker restart requires fresh session enrollment and a new finite producer claim.

The session's first `desktop_capabilities` creates one persistent, unenrolled local connection. `pending-connections` reports the kernel PID/start, same-user ancestors and a host metadata hint. Check the actual loaded registration, per-thread MCP process topology, host identity and session ID through the approved controller evidence path. Bind exact `connection_id`, `host_pid`, `host_start`, `harness`, `session_id`, `identity_source`, `context_mode`, `role` and `expires_at` with `enroll`; also supply `capacity_claim_ids` and `grants` as `{scope_id,submit,read,effects,observe_ticket_ids}`.

Choose `host-injected-thread-id` for any multiplexed surface. Each call must then carry the enrolled ID in trusted host transport metadata at `params._meta.callerThreadId`, `params._meta["openai/codex"].callerThreadId` or `params._meta["claudecode/sessionId"]`. Multiple supplied fields must agree. An exact loaded registration independently proven to be dedicated to one session may use `dedicated-stdio` and `identity_source: loaded_host_registration` without per-call metadata. Unknown exclusivity or an unavailable metadata path holds enrollment. Kernel peer identity is validated separately. Environment labels, MCP clientInfo and model-provided arguments do not grant authority.

## Operate and recover

GUI Queue uses `owner-status`, `stop`, `reclaim`, `restore` and `owner-cancel` over the authenticated controller CLI. Restore takes the current `binding_id`; owner cancel takes a `ticket_id`. The owner view reads `admission`, `blocker`, `handover`, `active_ticket_id`, `display` and ordered `tickets`. A stop receipt records `admission_closed_at` and `completion`. Poll current status until the handover clears. `last_owner_control` records the separate `quiescent_at` time when proven. Replaying the same stop ID returns its original receipt. `blocked_settling` holds the next holder. `recover-settling` rechecks owned process evidence without signalling a recovered PID. A new control ID issues a fresh check. Release and cancellation never erase partial or uncertain effects.

`desktop_verify` observes again under separate read permission, while settled and within the qualified read route. The independent result producer can write `effect-<action-id>.json` with `action_id`, `scope_id`, `effect` (verified or contradicted), `evidence_id` and `observation_sha256`. The digest is the canonical JSON SHA-256 of the redacted observation tree with opaque `ref` fields removed. The broker checks that exact observation before reporting a verified effect. An exact absent owned window uses a native absence observation for close. Without independent evidence the effect remains unknown and release can report partial. Keep action and observation artifacts required by the durable journal.

Use the [cutover phases](../rfcs/reserved-screen-v1/lifecycle.md) for initial activation, restart and rollback. This source has no legacy shutdown or loaded-host attestation automation. The controller and GUI Queue integration must deliver those separate pieces and prove the actual deployed route. The signal-deny/fork-deny seatbelt bounds the supported subprocess path. Exact Vercel fallback, macOS permissions, native quiescence, owner input isolation and real Claude/Codex handoff remain release verification.
