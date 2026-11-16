import { randomUUID } from "node:crypto";
import { check, controls, digest, methods, OPERATIONS, refuse } from "./protocol.js";

const LEASE_MS = 90_000;
const SNAPSHOT_MS = 30_000;
const COMMAND_MS = 15_000;
const SETTLE_MS = 2_000;
const own = (table, key) => Object.hasOwn(table, key) ? table[key] : null;
const terminal = (ticket) => !["queued", "held", "settling"].includes(ticket.state);
const reasons = {
  released: "released",
  cancelled: "cancelled",
  queue_expired: "expired",
  requester_lost: "requester_lost",
  restarted: "blocked"
};

function dedup(table, key, hash) {
  const prior = own(table, key);
  if (prior && prior.hash !== hash) refuse("request_id_conflict", "Use a new request ID for a different intent.");
  return prior;
}

function textSafe(text, canaries) {
  return canaries.reduce((out, canary) => out.replaceAll(canary, "[redacted]"), text);
}

function sameScope(scope, ticket) {
  return scope && ticket.scope_fingerprint === digest(scope);
}

function checkedId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function matchedKeys(object, keys) {
  return object !== null && typeof object === "object" && !Array.isArray(object) &&
    Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
}

export class DesktopBroker {
  constructor({ journal, host, driver, now = Date.now, id = randomUUID, commandMs = COMMAND_MS, settleMs = SETTLE_MS }) {
    this.state = journal.state;
    this.journal = journal;
    this.host = host;
    this.driver = driver;
    this.now = now;
    this.id = id;
    this.commandMs = commandMs;
    this.settleMs = settleMs;
    this.pendingConnections = new Map();
    this.sessions = new Map();
    this.claims = new Map();
    this.snapshots = new Map();
    this.liveInvocation = null;
    this.recoveryCheck = null;
    this.storageFailure = false;
    this.commit(state => {
      state.epoch++;
      state.closed ||= "restart_requires_restore";
      if (state.lease) this.revokeIn(state, "restarted", "blocked");
      for (const ticket of Object.values(state.tickets)) {
        if (ticket.state === "queued") {
          ticket.state = "requester_lost";
          ticket.blocker = "controller_reenrollment_required";
        }
      }
      if (state.invocation) {
        state.invocation.stopped = "restarted";
        const action = state.invocation.action_id && own(state.actions, state.invocation.action_id);
        if (action) {
          action.delivery = state.invocation.lifetime ? "uncertain" : "not_dispatched";
          action.effect = state.invocation.lifetime ? "unknown" : "none";
        }
      }
    });
  }

  commit(update) {
    if (this.storageFailure) refuse("desktop_journal_invalid", "The journal stopped accepting durable writes. Admission is closed.");
    const next = structuredClone(this.state);
    const output = update(next);
    try {
      this.journal.save(next);
    } catch {
      this.storageFailure = true;
      this.liveInvocation?.terminate();
      refuse("desktop_journal_invalid", "The reserved-screen journal could not persist the change. Admission is closed.");
    }
    this.state = next;
    return output;
  }

  connect(peer) {
    if (!peer?.id || !peer.ancestors?.length) refuse("host_identity_unknown", "The loaded host connection could not be identified.");
    const connection = { id: this.id(), peer, connected: true };
    this.pendingConnections.set(connection.id, connection);
    return connection;
  }

  disconnect(connection) {
    connection.connected = false;
    this.pendingConnections.delete(connection.id);
  }

  async enroll(p) {
    const fields = ["protocol_version", "control_request_id", "connection_id", "host_pid", "host_start", "harness",
      "session_id", "identity_source", "context_mode", "role", "expires_at", "grants", "capacity_claim_ids"];
    if (!matchedKeys(p, fields) || p.protocol_version !== 1 || !checkedId(p.control_request_id) || !checkedId(p.session_id) ||
      !["claude", "codex"].includes(p.harness) || !["manager", "worker"].includes(p.role) ||
      !["loaded_host_registration", "controller_loaded_session"].includes(p.identity_source) ||
      !["host-injected-thread-id", "dedicated-stdio"].includes(p.context_mode) ||
      (p.context_mode === "dedicated-stdio" && p.identity_source !== "loaded_host_registration") ||
      !Number.isSafeInteger(p.host_pid) || typeof p.host_start !== "string" || !Number.isSafeInteger(p.expires_at) ||
      p.expires_at <= this.now() || !Array.isArray(p.grants) || p.grants.length < 1 || p.grants.length > 32 ||
      !Array.isArray(p.capacity_claim_ids) || !p.capacity_claim_ids.every(checkedId)) {
      refuse("invalid_enrollment", "The controller must attest a real loaded session and provide bounded scope and capacity grants.");
    }
    const hash = digest({ operation: "enroll", p });
    const prior = dedup(this.state.controls, p.control_request_id, hash);
    if (prior) return prior.result;
    const connection = this.pendingConnections.get(p.connection_id);
    const ancestor = connection?.peer.ancestors.find(item => item.pid === p.host_pid && item.start === p.host_start);
    if (!ancestor || !this.host.isHarness(ancestor, p.harness) || !await this.host.sessionAlive(connection.peer, ancestor)) {
      refuse("host_identity_unknown", "Enrollment requires the current socket peer, a recognized host ancestor and verified loaded-session evidence.");
    }
    const raced = dedup(this.state.controls, p.control_request_id, hash);
    if (raced) return raced.result;
    if (!connection.connected || !this.pendingConnections.has(connection.id) || connection.principal || p.expires_at <= this.now()) {
      refuse("connection_unavailable", "This connection is unavailable for enrollment.");
    }
    for (const grant of p.grants) {
      if (!matchedKeys(grant, ["scope_id", "submit", "read", "effects", "observe_ticket_ids"]) ||
        !checkedId(grant.scope_id) || typeof grant.submit !== "boolean" || typeof grant.read !== "boolean" ||
        !Array.isArray(grant.effects) || !grant.effects.every(effect => OPERATIONS.includes(effect)) ||
        !Array.isArray(grant.observe_ticket_ids) || !grant.observe_ticket_ids.every(checkedId) ||
        !own(this.state.qualifications, grant.scope_id)) {
        refuse("invalid_scope_grant", "The controller must grant exact registered scopes and explicit task, read and effect permissions.");
      }
    }
    const result = { principal_id: this.id(), connection_id: connection.id, harness: p.harness, identity_source: p.identity_source,
      session_id: p.session_id, context_mode: p.context_mode, peer: connection.peer.id, host_pid: p.host_pid, host_start: p.host_start, expires_at: p.expires_at };
    this.commit(state => {
      state.controls[p.control_request_id] = { hash, result };
    });
    const principal = { ...result, ancestor, connection, role: p.role, grants: p.grants.map(grant => ({ ...structuredClone(grant), fingerprint: digest(own(this.state.qualifications, grant.scope_id)) })), claims: new Set(p.capacity_claim_ids), revoked: false };
    connection.principal = principal;
    this.pendingConnections.delete(connection.id);
    this.sessions.set(principal.principal_id, principal);
    return result;
  }

  async call(connection, method, p, runtimeSession = null) {
    check(methods[method]?.schema, p);
    const actor = connection.principal;
    if (!actor || actor.connection !== connection || !connection.connected || actor.revoked || actor.expires_at <= this.now()) {
      if (!actor && checkedId(runtimeSession)) connection.runtime_session_hint = runtimeSession;
      refuse("desktop_enrollment_required", "This loaded host connection needs an unexpired, scoped controller enrollment.");
    }
    if ((actor.context_mode === "host-injected-thread-id" && runtimeSession !== actor.session_id) ||
      (runtimeSession !== null && runtimeSession !== actor.session_id)) {
      refuse("desktop_session_unbound", "This request lacks the enrolled host session binding. Use the verified loaded session.");
    }
    if (!await this.host.sessionAlive(connection.peer, actor.ancestor)) {
      this.lose(actor, "requester_lost");
      refuse("requester_lost", "The enrolled requester is no longer live. Its tickets retain their outcomes.");
    }
    this.requireActor(actor);
    await this.expire();
    this.requireActor(actor);
    const hash = digest({ method, p });
    const key = p.request_id && [actor.principal_id, p.ticket_id || "_", p.request_id].join("/");
    const prior = key && dedup(this.state.receipts, key, hash);
    if (prior) return prior.result;
    const request = { key, hash };
    if (method === "capabilities") return this.capabilities(actor);
    if (method === "submit") return this.submit(actor, p, request);
    const ticket = this.allowedTicket(actor, p, method);
    if (method === "status") return this.status(ticket);
    if (method === "claim") return this.claim(actor, ticket, request);
    if (method === "cancel") return this.cancel(ticket, request);
    if (method === "verify") return this.verify(actor, ticket, p);
    const lease = this.assertHolder(ticket, p);
    if (method === "heartbeat") return this.heartbeat(ticket, actor, lease, request);
    if (method === "release") return this.release(ticket, p, request);
    if (method === "observe") return this.observe(actor, ticket, lease, p);
    if (method === "act") return this.act(actor, ticket, lease, p, request);
    refuse("invalid_desktop_request", "Unknown reserved-screen method.");
  }

  requireActor(actor) {
    if (actor.revoked || !actor.connection.connected || actor.expires_at <= this.now()) {
      refuse("desktop_enrollment_required", "The controller enrollment has closed.");
    }
  }

  grant(actor, scopeId) {
    const scope = own(this.state.qualifications, scopeId);
    return scope && actor.grants.find(grant => grant.scope_id === scopeId && grant.fingerprint === digest(scope));
  }

  scopeFor(ticket) {
    const scope = own(this.state.qualifications, ticket.scope_id);
    if (!sameScope(scope, ticket)) refuse("scope_changed", "The registered scope changed. The controller must bind a new task.");
    return scope;
  }

  allowedTicket(actor, p, method) {
    const ticket = own(this.state.tickets, p.ticket_id);
    const observer = ticket && method === "status" && this.grant(actor, ticket.scope_id)?.observe_ticket_ids.includes(ticket.id);
    if (!ticket || (ticket.principal_id !== actor.principal_id && !observer)) refuse("ticket_unavailable", "No ticket is available under this connection's authority.");
    return ticket;
  }

  admission() {
    if (this.storageFailure) return "desktop_journal_invalid";
    if (this.state.closed) return this.state.closed;
    if (!this.state.binding) return "display_unbound";
    return null;
  }

  capacity(actor, ticket) {
    const claim = this.claims.get(ticket.capacity_claim_id);
    if (!claim || !this.host.capacityActive(claim) || !actor?.claims.has(claim.id) || own(this.state.revoked_claims, claim.id) ||
      claim.scope_id !== ticket.scope_id || claim.start_by !== ticket.capacity_claim_start_by ||
      claim.valid_until <= this.now()) return "capacity_claim_unavailable";
    const used = own(this.state.started_claims, claim.id);
    if (used && used !== ticket.id) return "capacity_claim_consumed";
    if (!ticket.started_at && Math.min(ticket.start_deadline, claim.start_by) <= this.now()) return "start_deadline_expired";
    return null;
  }

  blocker(ticket) {
    if (ticket.state !== "queued") return ticket.blocker;
    const actor = this.sessions.get(ticket.principal_id);
    if (!actor || actor.revoked || actor.expires_at <= this.now()) return "requester_lost";
    if (!actor.connection.connected) return "requester_disconnected";
    if (!sameScope(own(this.state.qualifications, ticket.scope_id), ticket)) return "scope_changed";
    return this.capacity(actor, ticket) || this.admission();
  }

  capabilities(actor) {
    return {
      broker_id: this.state.installation, broker_build: this.driver.brokerBuild, driver: this.driver.identity,
      display: this.state.binding,
      admission: this.admission() || "open",
      scopes: actor.grants.filter(grant => this.grant(actor, grant.scope_id)).map(grant => {
        const scope = own(this.state.qualifications, grant.scope_id);
        return { scope_id: grant.scope_id, title: scope?.label, read: grant.read && scope?.qualified === true, submit: grant.submit && scope?.qualified === true,
          operations: grant.effects.filter(operation => scope?.qualified && scope.operations.includes(operation)) };
      }),
      capacity_claims: [...actor.claims].map(id => this.claims.get(id)).filter(claim => claim && !own(this.state.revoked_claims, claim.id))
        .map(claim => ({ capacity_claim_id: claim.id, scope_id: claim.scope_id, capacity_claim_start_by: claim.start_by, valid_until: claim.valid_until })),
      limitations: ["cooperative_same_user", "headless_semantic_only", "authenticated_browser_requires_Antechamber"],
      heartbeat_ms: 30_000, lease_ms: LEASE_MS
    };
  }

  submit(actor, p, request) {
    const scope = own(this.state.qualifications, p.scope_id);
    const grant = this.grant(actor, p.scope_id);
    if (!scope?.qualified || !grant?.submit) refuse("scope_unsupported", "No qualified task grant for this scope. Ask the responsible controller for a supported local target.");
    const actorCapacity = this.capacity(actor, p);
    if (actorCapacity) refuse(actorCapacity, "Provide this scope's current validated finite capacity claim and deadline.");
    const ticket = {
      id: this.id(), principal_id: actor.principal_id, scope_id: p.scope_id, scope_fingerprint: digest(scope),
      title: textSafe(p.title, scope.canaries),
      start_deadline: p.start_deadline, capacity_claim_id: p.capacity_claim_id, capacity_claim_start_by: p.capacity_claim_start_by,
      state: "queued", blocker: null, created_at: this.now(), started_at: null, actions: []
    };
    return this.commit(state => {
      state.tickets[ticket.id] = { ...ticket, sequence: ++state.last_sequence };
      const result = this.status(state.tickets[ticket.id], state);
      return this.remember(state, request, result);
    });
  }

  status(ticket, state = this.state) {
    const ordered = Object.values(state.tickets).filter(row => row.state === "queued").sort((a, b) => a.sequence - b.sequence);
    const actions = ticket.actions.map(id => state.actions[id]).map(action => this.publicAction(action));
    const lease = state.lease?.ticket_id === ticket.id ? state.lease : null;
    const settling = state.invocation?.ticket_id === ticket.id && state.invocation.stopped;
    return {
      ticket_id: ticket.id, title: ticket.title, scope_id: ticket.scope_id, state: ticket.state,
      queue_position: ticket.state === "queued" ? ordered.findIndex(row => row.id === ticket.id) + 1 : null,
      blocker: this.blocker(ticket) ?? null,
      authority: lease?.phase ?? "none",
      handover: settling ? state.invocation.settle_blocked ? "blocked_settling" : "settling" : lease ? "held" : "clear",
      started_at: ticket.started_at, result: ticket.result ?? null, actions,
      next_action: ticket.state === "queued" ? "poll_status_then_claim" : ticket.state === "held" ? "observe_or_release" : ticket.state === "settling" ? "poll_status" : "read_terminal_outcome"
    };
  }

  publicAction(action) {
    const { id, epoch, operation, delivery, effect, partial_effects, verification, observation_id, issued_at, finished_at, blocker } = action;
    return { action_id: id, epoch, operation, delivery, effect, partial_effects, verification, observation_id, issued_at, finished_at, blocker: blocker ?? null };
  }

  remember(state, request, result) {
    if (request?.key) state.receipts[request.key] = { hash: request.hash, result };
    return result;
  }

  async claim(actor, ticket, request) {
    if (ticket.state !== "queued") refuse("not_queued", "This ticket is no longer waiting for a turn.");
    if (this.state.lease || this.state.invocation) refuse("turn_unavailable", "A current or settling holder has the screen. Poll status.");
    const first = Object.values(this.state.tickets).filter(row => row.state === "queued" && !this.blocker(row)).sort((a, b) => a.sequence - b.sequence)[0];
    if (first?.id !== ticket.id) refuse("turn_unavailable", "The ticket is blocked or another eligible ticket is first. Poll status.");
    const epoch = this.state.epoch;
    const scope = this.scopeFor(ticket);
    await this.validateBinding(scope, { allowPlacement: scope.operations.includes("place-window") });
    this.requireActor(actor);
    const prior = dedup(this.state.receipts, request.key, request.hash);
    if (prior) return prior.result;
    if (this.state.epoch !== epoch || this.state.lease || this.state.invocation || this.blocker(this.state.tickets[ticket.id]) ||
      this.state.tickets[ticket.id].state !== "queued") refuse("turn_unavailable", "Admission changed while checking the selected display. Poll status.");
    const earlier = Object.values(this.state.tickets).some(row => row.state === "queued" && row.sequence < ticket.sequence && !this.blocker(row));
    if (earlier) refuse("turn_unavailable", "An earlier eligible ticket is first. Poll status.");
    return this.commit(state => {
      const lease = { lease_id: this.id(), epoch: ++state.epoch, ticket_id: ticket.id, expires_at: Math.min(actor.expires_at, this.now() + LEASE_MS), phase: "held" };
      state.lease = lease;
      state.tickets[ticket.id].state = "held";
      return this.remember(state, request, { ...lease, next_action: "observe" });
    });
  }

  assertHolder(ticket, p) {
    const lease = this.state.lease;
    if (!lease || lease.phase !== "held" || lease.ticket_id !== ticket.id ||
      lease.lease_id !== p.lease_id || lease.epoch !== p.epoch || lease.epoch !== this.state.epoch ||
      lease.expires_at <= this.now() || this.admission()) refuse("stale_lease", "This lease no longer authorizes desktop actions. Read ticket status.");
    return lease;
  }

  heartbeat(ticket, actor, lease, request) {
    const expires_at = Math.min(actor.expires_at, this.now() + LEASE_MS);
    return this.commit(state => {
      state.lease.expires_at = expires_at;
      return this.remember(state, request, { ticket_id: ticket.id, lease_id: lease.lease_id, epoch: lease.epoch, expires_at });
    });
  }

  async validateBinding(scope, { allowPlacement = false, requireUnedited = false } = {}) {
    const binding = this.state.binding;
    const epoch = this.state.epoch;
    if (!binding) refuse("display_unbound", "The controller must prebind the reserved display.");
    try {
      const result = await this.host.validateBinding(binding, scope, { allowPlacement, requireUnedited });
      if (!result) throw new Error("invalid binding");
      return result;
    } catch {
      if (this.state.epoch === epoch) this.closeForInvalidBinding();
      refuse("target_binding_invalid", "The selected display, process, window or target scope changed. The controller must revalidate.");
    }
  }

  closeForInvalidBinding() {
    this.commit(state => {
      state.closed ||= "target_binding_invalid";
      this.revokeIn(state, "target_binding_invalid", "blocked");
    });
    this.liveInvocation?.terminate();
  }

  cancel(ticket, request) {
    const result = this.commit(state => {
      const current = state.tickets[ticket.id];
      if (!terminal(current)) {
        if (state.lease?.ticket_id === ticket.id || state.invocation?.ticket_id === ticket.id) this.revokeIn(state, "cancelled", "cancelled");
        else current.state = "cancelled";
      }
      return this.remember(state, request, this.status(current, state));
    });
    if (this.state.invocation?.ticket_id === ticket.id && this.state.invocation.stopped) this.liveInvocation?.terminate();
    return result;
  }

  release(ticket, p, request) {
    const result = this.commit(state => {
      this.revokeIn(state, "released", "released");
      state.tickets[ticket.id].result = p.result === "finished" && ticket.actions.some(id => {
        const effect = state.actions[id].effect;
        return effect !== "verified" && effect !== "none";
      }) ? "partial" : p.result;
      return this.remember(state, request, this.status(state.tickets[ticket.id], state));
    });
    if (this.state.invocation?.ticket_id === ticket.id && this.state.invocation.stopped) this.liveInvocation?.terminate();
    return result;
  }

  revokeIn(state, reason, outcome = reasons[reason] ?? "blocked") {
    state.epoch++;
    const id = state.lease?.ticket_id ?? state.invocation?.ticket_id;
    if (state.lease) state.lease.phase = "closed";
    const ticket = id && own(state.tickets, id);
    if (state.invocation) {
      state.invocation.stopped ||= reason;
      if (ticket && !terminal(ticket)) {
        ticket.state = "settling";
        ticket.blocker = reason;
        ticket.terminal_after_settle = outcome;
      }
    } else {
      state.lease = null;
      if (ticket && !terminal(ticket)) {
        ticket.state = outcome;
        ticket.blocker = outcome === "released" ? null : reason;
      }
    }
    this.snapshots.clear();
  }

  lose(actor, reason) {
    actor.revoked = true;
    if (!Object.values(this.state.tickets).some(t => t.principal_id === actor.principal_id && !terminal(t))) return;
    this.commit(state => {
      for (const ticket of Object.values(state.tickets)) {
        if (ticket.principal_id !== actor.principal_id || terminal(ticket)) continue;
        if (state.lease?.ticket_id === ticket.id || state.invocation?.ticket_id === ticket.id) this.revokeIn(state, reason);
        else {
          ticket.state = "requester_lost";
          ticket.blocker = reason;
        }
      }
    });
    if (this.state.invocation?.stopped) this.liveInvocation?.terminate();
  }

  async expire({ checkRequester = false } = {}) {
    const lease = this.state.lease;
    const ticket = lease && this.state.tickets[lease.ticket_id];
    const principal = ticket && this.sessions.get(ticket.principal_id);
    if (lease?.phase === "held" && principal && checkRequester && !await this.host.sessionAlive(principal.connection.peer, principal.ancestor)) {
      this.lose(principal, "requester_lost");
    }
    if (this.state.lease?.phase === "held") {
      const row = this.state.tickets[this.state.lease.ticket_id];
      const reason = this.state.lease.expires_at <= this.now() ? "requester_lost" : this.capacity(this.sessions.get(row.principal_id), row);
      if (reason) {
        this.commit(state => this.revokeIn(state, reason));
        this.liveInvocation?.terminate();
      }
    }
    const expired = Object.values(this.state.tickets).filter(row => row.state === "queued" &&
      (Math.min(row.start_deadline, row.capacity_claim_start_by) <= this.now() || this.sessions.get(row.principal_id)?.expires_at <= this.now()));
    if (expired.length) this.commit(state => {
      for (const row of expired) {
        state.tickets[row.id].state = "expired";
        state.tickets[row.id].blocker = "start_deadline_or_enrollment_expired";
      }
    });
  }

  async tick() {
    if (this.storageFailure) return;
    await this.expire({ checkRequester: true });
    if (!this.state.lease || this.state.lease.phase !== "held") return;
    const ticket = this.state.tickets[this.state.lease.ticket_id];
    const scope = this.scopeFor(ticket);
    // Read-only topology and scope probes run independently of the driver's
    // command wait. An expected close or placement may change the window.
    const issuing = this.state.actions[this.state.invocation?.action_id]?.operation;
    const lastAction = this.state.actions[ticket.actions.at(-1)];
    const expectedClosed = lastAction?.operation === "close" && Boolean(lastAction.issued_at) && await this.host.verifyAbsent(scope);
    const changing = ["close", "place-window"].includes(issuing) || expectedClosed;
    await this.validateBinding(changing ? null : scope, { allowPlacement: !changing && scope.operations.includes("place-window") });
  }

  async observe(actor, ticket, lease, p, verify = false) {
    const scope = this.scopeFor(ticket);
    if (p.scope_id !== ticket.scope_id || !this.grant(actor, p.scope_id)?.read) refuse("read_scope_required", "The controller did not grant this observation scope.");
    const invocationEpoch = this.state.epoch;
    const placement = !verify && scope.operations.includes("place-window");
    const before = await this.validateBinding(scope, { allowPlacement: placement });
    const placeOnly = before.placement_pending === true && placement;
    this.assertInvocationAuthority({ actor, ticket, lease, epoch: invocationEpoch, verify });
    if (this.state.invocation) refuse("driver_busy", "An invocation is active. Observe again after it settles.");
    const raw = placeOnly ? null : await this.run({ actor, ticket, lease, scope, method: "observe", verify, epoch: invocationEpoch });
    if (!placeOnly) await this.validateBinding(scope);
    this.requireActor(actor);
    if (this.state.epoch !== invocationEpoch || this.state.invocation) refuse("stale_observation", "Authority changed during observation. The data was discarded.");
    const snapshot = placeOnly ? this.driver.placementSnapshot() : this.driver.snapshot(scope, raw.output);
    const id = this.id();
    this.commit(state => {
      const filed = state.tickets[ticket.id];
      if (placeOnly && !filed.started_at) {
        filed.started_at = this.now();
        state.started_claims[filed.capacity_claim_id] = ticket.id;
      }
      state.observations[id] = { ticket_id: ticket.id, epoch: invocationEpoch, scope_id: ticket.scope_id, tree: snapshot.tree, captured_at: this.now() };
    });
    if (!verify) {
      this.snapshots.clear();
      this.snapshots.set(id, { ticket_id: ticket.id, lease_id: lease.lease_id, epoch: lease.epoch, captured_at: this.now(), refs: snapshot.refs });
    }
    return { snapshot_id: id, scope_id: ticket.scope_id, complete: snapshot.complete, tree: snapshot.tree, warnings: snapshot.warnings };
  }

  async act(actor, ticket, lease, p, request) {
    const scope = this.scopeFor(ticket);
    if (ticket.actions.some(id => {
      const action = this.state.actions[id];
      return action.delivery === "uncertain" && action.effect === "unknown";
    })) {
      refuse("uncertain_action_unresolved", "Reconcile the uncertain action before issuing another mutation on this ticket.");
    }
    if (!this.grant(actor, ticket.scope_id)?.effects.includes(p.operation) || !scope.operations.includes(p.operation)) {
      refuse("operation_unsupported", "The exact scope and build are not qualified for this operation.");
    }
    const snapshot = this.snapshots.get(p.snapshot_id);
    const ref = snapshot?.refs.get(p.ref);
    if (!snapshot || !ref || snapshot.ticket_id !== ticket.id || snapshot.lease_id !== lease.lease_id ||
      snapshot.epoch !== lease.epoch || this.now() - snapshot.captured_at >= SNAPSHOT_MS) {
      refuse("stale_reference", "Observe the exact owned window again and use a current reference.");
    }
    const command = this.driver.command(scope, ref, p.operation, p.value);
    await this.validateBinding(scope, { allowPlacement: p.operation === "place-window", requireUnedited: p.operation === "close" });
    const prior = dedup(this.state.receipts, request.key, request.hash);
    if (prior) return prior.result;
    if (this.snapshots.get(p.snapshot_id) !== snapshot || this.now() - snapshot.captured_at >= SNAPSHOT_MS) refuse("stale_reference", "The observation changed or expired. Observe again.");
    return this.run({ actor, ticket, lease, scope, method: "act", command, request, epoch: lease.epoch, observationId: p.snapshot_id, operation: p.operation });
  }

  async verify(actor, ticket, p) {
    const action = own(this.state.actions, p.action_id);
    if (!action || action.ticket_id !== ticket.id || p.scope_id !== ticket.scope_id || !this.grant(actor, p.scope_id)?.read) {
      refuse("action_unavailable", "No action is available under this ticket and observation scope.");
    }
    if (this.state.invocation || (this.state.lease && this.state.lease.ticket_id !== ticket.id)) refuse("actor_still_settling", "Wait for the current holder to settle before scoped reconciliation.");
    if (["not_dispatched", "not_delivered"].includes(action.delivery)) return { ...this.publicAction(action), effect: "none", observation: null };
    const epoch = this.state.epoch;
    const scope = this.scopeFor(ticket);
    const observation = action.operation === "close" && await this.host.verifyAbsent(scope)
      ? await this.observeAbsence(actor, ticket, scope, epoch)
      : await this.observe(actor, ticket, this.state.lease, p, true);
    const verdict = await this.host.verifyEffect(scope, this.publicAction(action), observation);
    if (this.state.epoch !== epoch) refuse("stale_observation", "Authority changed during reconciliation. Verify again after it settles.");
    const effect = ["verified", "contradicted"].includes(verdict?.effect) && checkedId(verdict.evidence_id) ? verdict.effect : "unknown";
    this.requireActor(actor);
    const current = this.commit(state => {
      const row = state.actions[action.id];
      const check = { effect, evidence_id: effect === "unknown" ? null : verdict.evidence_id, observation_id: observation.snapshot_id };
      row.verification_history ??= [];
      row.verification_history.push(check);
      if (effect !== "unknown" || !row.verification) {
        row.effect = effect;
        row.verification = check;
      }
      return this.publicAction(row);
    });
    return { ...current, observation };
  }

  async observeAbsence(actor, ticket, scope, epoch) {
    this.assertInvocationAuthority({ actor, ticket, epoch, verify: true });
    await this.validateBinding(null);
    if (!await this.host.verifyAbsent(scope)) refuse("stale_observation", "The expected closed-window state could not be confirmed.");
    this.assertInvocationAuthority({ actor, ticket, epoch, verify: true });
    if (this.state.invocation) refuse("actor_still_settling", "Wait for the active invocation to settle.");
    const snapshot_id = this.id();
    const tree = { role: "window", presence: "absent" };
    this.commit(state => {
      state.observations[snapshot_id] = { ticket_id: ticket.id, epoch, scope_id: ticket.scope_id, tree, captured_at: this.now() };
    });
    return { snapshot_id, scope_id: ticket.scope_id, complete: true, tree, warnings: [] };
  }

  assertInvocationAuthority({ actor, ticket, lease = null, epoch, verify }) {
    this.requireActor(actor);
    if (this.state.epoch !== epoch) refuse("stale_lease", "Authority changed before the command issued.");
    this.scopeFor(ticket);
    if (verify) {
      if (this.admission() || (this.state.lease && this.state.lease.ticket_id !== ticket.id) || !ticket.started_at) {
        refuse("read_scope_unavailable", "Scoped verification cannot run under the current holder or journal state.");
      }
      return;
    }
    this.assertHolder(ticket, lease);
    const reason = this.capacity(actor, this.state.tickets[ticket.id]);
    if (reason) refuse(reason, "The capacity claim or start deadline no longer authorizes new work.");
  }

  async run(context) {
    const { ticket, scope, method, command, epoch, request, observationId, operation } = context;
    this.assertInvocationAuthority(context);
    if (this.state.invocation) refuse("driver_busy", "One invocation is already active or settling. Poll status.");
    const id = this.id();
    const actionId = method === "act" ? this.id() : null;
    const base = { id, ticket_id: ticket.id, epoch, action_id: actionId, lifetime: null, stopped: null, settle_blocked: false };
    this.commit(state => {
      state.invocation = base;
      if (actionId) {
        state.actions[actionId] = {
          id: actionId, ticket_id: ticket.id, epoch, operation, observation_id: observationId, delivery: "intent",
          effect: "unknown", partial_effects: [], verification: null, issued_at: null, finished_at: null, request
        };
        state.tickets[ticket.id].actions.push(actionId);
        this.remember(state, request, { ...this.publicAction(state.actions[actionId]), handover: "in_flight" });
      }
    });
    if (method === "act") this.snapshots.clear();

    let handle;
    let interrupt;
    const interrupted = new Promise(resolve => { interrupt = resolve; });
    this.liveInvocation = {
      terminate() {
        handle?.terminate();
        interrupt({ output: null, delivery: "uncertain", partial_effects: [] });
      }
    };
    let permitted = false;
    let blocker = null;
    let outcome = { output: null, delivery: "not_dispatched", partial_effects: [] };
    try {
      // The prepared child has no emission authority until permit() writes
      // one byte. A parent that dies before the durable lifetime record
      // closes the pipe and leaves the launcher powerless.
      handle = await this.driver.prepare(scope, method, command);
      if (!this.state.invocation.stopped) {
        await this.validateBinding(scope, { allowPlacement: operation === "place-window", requireUnedited: operation === "close" });
        if (!await this.host.sessionAlive(context.actor.connection.peer, context.actor.ancestor)) refuse("requester_lost", "The requester is no longer live.");
        this.assertInvocationAuthority(context);
        this.commit(state => {
          const current = state.tickets[ticket.id];
          state.invocation.lifetime = handle.lifetime;
          if (!context.verify && !current.started_at) {
            current.started_at = this.now();
            state.started_claims[current.capacity_claim_id] = ticket.id;
          }
          if (actionId) {
            const action = state.actions[actionId];
            action.delivery = "issued";
            action.issued_at = this.now();
            this.remember(state, request, { ...this.publicAction(action), handover: "in_flight" });
          }
        });
        permitted = true;
        handle.permit();
      } else {
        handle.terminate();
      }
      if (permitted) {
        const timer = setTimeout(() => {
          try {
            this.commit(state => this.revokeIn(state, "command_timeout"));
          } catch {
            // Commit failure already closed all new admissions.
          }
          this.liveInvocation?.terminate();
        }, this.commandMs);
        timer.unref?.();
        try {
          outcome = await Promise.race([handle.outcome, interrupted]);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (error) {
      blocker = typeof error?.code === "string" ? error.code : "driver_preparation_failed";
      handle?.terminate();
      if (permitted) outcome = { output: null, delivery: "uncertain", partial_effects: [] };
    }

    let quiescent = false;
    try {
      // A prepare failure leaves no permitted child. Recovery of a persisted
      // lifetime is used if the live handle failed after issuing.
      quiescent = handle ? await handle.quiescent(this.settleMs) : !permitted;
    } catch {
      // Unknown remains settling. A later validated owner recheck may recover.
    }
    if (quiescent && !permitted && handle?.lifetime && this.state.invocation.lifetime) {
      // A durable launch authority record without a permit is conservative on restart.
      outcome.delivery = "not_dispatched";
    }
    const stopped = this.state.invocation.stopped;
    const delivery = permitted && (stopped || !quiescent) && !["delivered", "not_dispatched", "not_delivered"].includes(outcome.delivery) ? "uncertain" : outcome.delivery;
    const result = this.commit(state => {
      if (actionId) {
        const action = state.actions[actionId];
        action.delivery = delivery;
        action.effect = ["not_dispatched", "not_delivered"].includes(delivery) ? "none" : "unknown";
        action.blocker = stopped || blocker || outcome.blocker || null;
        action.finished_at = this.now();
        action.partial_effects = outcome.partial_effects ?? [];
      }
      if (outcome.routeViolation) {
        state.closed = "driver_route_violation";
        this.revokeIn(state, state.closed);
      }
      if (quiescent) this.finishIn(state);
      else {
        if (!stopped) this.revokeIn(state, "driver_quiescence_unknown");
        state.invocation.settle_blocked = true;
        for (const settlement of Object.values(state.control_settlements)) {
          if (settlement.invocation_id === id) settlement.completion = "blocked_settling";
        }
      }
      if (!actionId) return null;
      return this.remember(state, request, {
        ...this.publicAction(state.actions[actionId]),
        handover: quiescent ? "clear" : "blocked_settling"
      });
    });
    this.liveInvocation = null;
    if (actionId) return result;
    if (stopped || !quiescent || delivery !== "delivered") refuse(blocker || "observation_unavailable", "No complete scoped observation is available. Check the ticket and desktop status.");
    return outcome;
  }

  finishIn(state) {
    const { ticket_id: id, stopped, id: invocationId } = state.invocation;
    for (const settlement of Object.values(state.control_settlements)) {
      if (settlement.invocation_id === invocationId && settlement.quiescent_at === null) {
        settlement.quiescent_at = this.now();
        settlement.completion = "completed";
      }
    }
    state.invocation = null;
    const ticket = own(state.tickets, id);
    if (ticket && stopped && state.lease?.ticket_id === id) state.lease = null;
    if (ticket?.state === "settling") {
      ticket.state = ticket.terminal_after_settle;
      delete ticket.terminal_after_settle;
    }
  }

  async recover() {
    if (!this.state.invocation || this.liveInvocation || this.recoveryCheck) return false;
    const invocation = this.state.invocation;
    this.recoveryCheck = invocation.id;
    try {
      // With no recorded lifetime the fail-closed launch gate could never
      // have been opened. With a recorded lifetime, require kernel evidence.
      const quiescent = !invocation.lifetime || await this.driver.recover(invocation.lifetime);
      if (this.state.invocation?.id !== invocation.id) return false;
      this.commit(state => {
        if (quiescent) {
          const action = invocation.action_id && own(state.actions, invocation.action_id);
          this.finishIn(state);
          if (action) {
            const recovered = state.actions[action.id];
            recovered.finished_at ||= this.now();
            this.remember(state, recovered.request, { ...this.publicAction(recovered), handover: "clear" });
          }
        } else {
          state.invocation.settle_blocked = true;
        }
      });
      return quiescent;
    } finally {
      this.recoveryCheck = null;
    }
  }

  ownerStatus(state = this.state) {
    const admission = this.storageFailure ? "desktop_journal_invalid" : state.closed;
    return {
      broker_id: state.installation, broker_build: this.driver.brokerBuild, driver: this.driver.identity,
      display: state.binding, admission: admission ? "closed" : "open", blocker: admission,
      epoch: state.epoch,
      last_owner_control: state.last_owner_control_id ? structuredClone(state.control_settlements[state.last_owner_control_id]) : null,
      handover: state.invocation?.stopped ? state.invocation.settle_blocked ? "blocked_settling" : "settling"
        : state.lease ? "held" : "clear",
      active_ticket_id: state.lease?.ticket_id ?? state.invocation?.ticket_id ?? null,
      tickets: Object.values(state.tickets).sort((a, b) => a.sequence - b.sequence).map(ticket => this.status(ticket, state))
    };
  }

  controlReceipt(state, p, hash, result) {
    state.controls[p.control_request_id] = { hash, result };
    return result;
  }

  async control(method, p) {
    if (method === "enroll") return this.enroll(p);
    if (method === "set-display") return this.setDisplay(p);
    if (method === "register-scope") return this.registerScope(p);
    if (method === "admit-claim") return this.admitClaim(p);
    check(controls[method], p);
    if (method === "owner-status") return this.ownerStatus();
    if (method === "pending-connections") return { connections: [...this.pendingConnections.values()]
      .map(connection => ({ connection_id: connection.id, peer: connection.peer, runtime_session_hint: connection.runtime_session_hint ?? null })) };

    const hash = digest({ operation: method, p });
    const prior = dedup(this.state.controls, p.control_request_id, hash);
    if (prior) return prior.result;
    if (method === "stop" || method === "reclaim") {
      const result = this.commit(state => {
        state.closed = method === "stop" ? "owner_stopped" : "owner_reclaimed";
        this.revokeIn(state, state.closed);
        const admission_closed_at = this.now();
        const completion = state.invocation ? (state.invocation.settle_blocked ? "blocked_settling" : "settling") : "completed";
        state.last_owner_control_id = p.control_request_id;
        state.control_settlements[p.control_request_id] = {
          control_request_id: p.control_request_id,
          control: method,
          admission_closed_at,
          invocation_id: state.invocation?.id ?? null,
          quiescent_at: state.invocation ? null : admission_closed_at,
          completion
        };
        return this.controlReceipt(state, p, hash, { ...this.ownerStatus(state), admission_closed_at, control: method, completion });
      });
      this.liveInvocation?.terminate();
      return result;
    }
    if (method === "restore") {
      const epoch = this.state.epoch;
      const binding = this.state.binding;
      if (!this.driver.identity.ready || !binding || binding.id !== p.binding_id || this.state.invocation || this.state.lease ||
        !await this.host.validateBinding(binding, null)) refuse("restore_blocked", "Restore requires the currently bound display, no unresolved injector and a fresh usable session.");
      const raced = dedup(this.state.controls, p.control_request_id, hash);
      if (raced) return raced.result;
      if (this.state.epoch !== epoch || this.state.invocation || this.state.lease || !this.state.closed) refuse("restore_blocked", "Admission changed during restore. Read current status.");
      return this.commit(state => {
        state.closed = null;
        state.epoch++;
        return this.controlReceipt(state, p, hash, this.ownerStatus(state));
      });
    }
    if (method === "owner-cancel") {
      const ticket = own(this.state.tickets, p.ticket_id);
      if (!ticket) refuse("ticket_unavailable", "Select an existing ticket.");
      const result = this.commit(state => {
        const row = state.tickets[ticket.id];
        if (!terminal(row)) {
          if (state.lease?.ticket_id === ticket.id || state.invocation?.ticket_id === ticket.id) this.revokeIn(state, "cancelled", "cancelled");
          else row.state = "cancelled";
        }
        return this.controlReceipt(state, p, hash, this.status(row, state));
      });
      if (this.state.invocation?.ticket_id === ticket.id && this.state.invocation.stopped) this.liveInvocation?.terminate();
      return result;
    }
    if (method === "revoke-claim") {
      const result = this.commit(state => {
        state.revoked_claims[p.capacity_claim_id] = true;
        const current = state.tickets[state.lease?.ticket_id ?? state.invocation?.ticket_id];
        if (current?.capacity_claim_id === p.capacity_claim_id) this.revokeIn(state, "capacity_claim_revoked");
        return this.controlReceipt(state, p, hash, { capacity_claim_id: p.capacity_claim_id, revoked: true });
      });
      if (this.state.invocation?.stopped) this.liveInvocation?.terminate();
      return result;
    }
    if (method === "revoke-session") {
      const actor = this.sessions.get(p.principal_id);
      if (actor) this.lose(actor, "requester_lost");
      return this.commit(state => this.controlReceipt(state, p, hash, { principal_id: p.principal_id, revoked: true }));
    }
    if (method === "recover-settling") {
      await this.recover();
      const raced = dedup(this.state.controls, p.control_request_id, hash);
      if (raced) return raced.result;
      return this.commit(state => this.controlReceipt(state, p, hash, this.ownerStatus(state)));
    }
    refuse("invalid_desktop_request", "Unknown reserved-screen control method.");
  }

  assertSetup() {
    if (!this.state.closed || this.state.invocation || this.state.lease) refuse("setup_blocked", "Stop and settle the broker before updating a binding or scope.");
  }

  async setDisplay(p) {
    check(controls["recover-settling"], p);
    const hash = digest({ operation: "set-display", p });
    const prior = dedup(this.state.controls, p.control_request_id, hash);
    if (prior) return prior.result;
    this.assertSetup();
    const epoch = this.state.epoch;
    const binding = await this.host.selectDisplay();
    if (!binding) refuse("display_unbound", "The selected left portrait display could not be identified unambiguously.");
    const raced = dedup(this.state.controls, p.control_request_id, hash);
    if (raced) return raced.result;
    this.assertSetup();
    if (this.state.epoch !== epoch) refuse("setup_changed", "Admission changed during binding. Retry with current status.");
    return this.commit(state => {
      state.binding = { ...binding, id: digest(binding) };
      state.epoch++;
      return this.controlReceipt(state, p, hash, { display: state.binding });
    });
  }

  async registerScope(p) {
    if (!matchedKeys(p, ["protocol_version", "control_request_id", "scope"]) || p.protocol_version !== 1 || !checkedId(p.control_request_id)) {
      refuse("invalid_scope", "A trusted scope definition is required.");
    }
    const hash = digest({ operation: "register-scope", p });
    const prior = dedup(this.state.controls, p.control_request_id, hash);
    if (prior) return prior.result;
    this.assertSetup();
    const epoch = this.state.epoch;
    const scope = await this.host.qualifyScope(p.scope, this.state.binding, this.driver.identity);
    this.assertSetup();
    const raced = dedup(this.state.controls, p.control_request_id, hash);
    if (raced) return raced.result;
    if (this.state.epoch !== epoch || !scope || !checkedId(scope.id) || !scope.qualified) refuse("scope_unqualified", "The exact app, build, actuator and scope must pass qualification before registration.");
    return this.commit(state => {
      state.qualifications[scope.id] = scope;
      return this.controlReceipt(state, p, hash, { scope_id: scope.id, label: scope.label, qualification_id: scope.qualification_id });
    });
  }

  admitClaim(p) {
    const fields = ["protocol_version", "control_request_id", "capacity_claim_id", "scope_id", "start_by", "valid_until", "authority_id"];
    if (!matchedKeys(p, fields) || p.protocol_version !== 1 || !checkedId(p.control_request_id) ||
      !checkedId(p.capacity_claim_id) || !checkedId(p.authority_id) || !checkedId(p.scope_id) ||
      !Number.isSafeInteger(p.start_by) || !Number.isSafeInteger(p.valid_until) ||
      p.start_by <= this.now() || p.valid_until < p.start_by ||
      !own(this.state.qualifications, p.scope_id)) {
      refuse("capacity_claim_unavailable", "Provide a current, bounded start allowance from the accountable capacity producer.");
    }
    const hash = digest({ operation: "admit-claim", p });
    const prior = dedup(this.state.controls, p.control_request_id, hash);
    if (prior) return prior.result;
    // Claims never survive a broker restart as active authority. A fresh
    // producer claim must have a new identifier and expiry.
    if (this.claims.has(p.capacity_claim_id) || own(this.state.started_claims, p.capacity_claim_id) || own(this.state.revoked_claims, p.capacity_claim_id)) {
      refuse("capacity_claim_conflict", "This finite claim is already registered, consumed or revoked.");
    }
    if (!this.host.capacityActive({ ...p, id: p.capacity_claim_id })) {
      refuse("capacity_claim_unavailable", "The current capacity producer record does not validate this claim.");
    }
    const result = { capacity_claim_id: p.capacity_claim_id, scope_id: p.scope_id, capacity_claim_start_by: p.start_by, valid_until: p.valid_until };
    this.commit(state => this.controlReceipt(state, p, hash, result));
    this.claims.set(p.capacity_claim_id, { ...p, id: p.capacity_claim_id });
    return result;
  }
}
