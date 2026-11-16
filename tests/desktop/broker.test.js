import "../helpers/guard.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { DesktopBroker } from "../../src/desktop/broker.js";
import { initialState, initializeJournal, openJournal } from "../../src/desktop/journal.js";

const version = { protocol_version: 1 };
const display = { id: "reserved", uuid: "display-1", geometry: { x: -1000, y: 0, width: 1000, height: 1700 } };
const scope = { id: "project", label: "Local project", qualified: true, canaries: ["private-canary"], operations: ["click", "set-value"] };

function deferred() {
  let resolve;
  const promise = new Promise(end => { resolve = end; });
  return { promise, resolve };
}

function setup({ journal, commandMs = 2000 } = {}) {
  let time = 1_000;
  let id = 0;
  let saved = { ...initialState(), binding: display, qualifications: { project: scope } };
  journal ??= { state: saved, save: state => { saved = state; } };
  const target = {
    ready: true, sessionLive: true, capacity: true, dispatches: 0, probes: 0, effects: 0,
    recoverable: true, verify: false, hold: null, lostAck: false,
    async waitOwnedActor() { if (this.hold) await this.hold.promise; }
  };
  const host = {
    validateBinding: async () => { target.probes++; return target.ready; },
    selectDisplay: async () => display,
    isHarness: (identity, harness) => identity.harness === harness,
    sessionAlive: async () => target.sessionLive,
    qualifyScope: async () => scope,
    capacityActive: () => target.capacity,
    verifyEffect: async () => target.verify ? { effect: "verified", evidence_id: "target-oracle-1" } : null
  };
  const driver = {
    identity: { ready: true }, brokerBuild: "test-candidate",
    snapshot: () => ({
      complete: true, tree: { role: "button", ref: "button-ref", name: "Increment" }, refs: new Map([["button-ref", { operations: ["click"] }]]), warnings: []
    }),
    command: (_scope, ref, operation) => {
      if (!ref.operations.includes(operation)) throw new Error("operation_not_supported");
      return operation;
    },
    recover: async () => target.recoverable,
    prepare: async (_scope, method) => {
      target.prepared?.resolve();
      if (target.holdPrepare) await target.holdPrepare.promise;
      const finished = deferred();
      return {
        lifetime: { pid: 80, start: "lifetime" },
        outcome: finished.promise,
        permit() {
          target.dispatches++;
          if (method === "act") {
            target.effects++;
            target.started?.resolve();
          }
          if (!target.hold) finished.resolve({ output: "safe", delivery: target.lostAck && method === "act" ? "uncertain" : "delivered", partial_effects: [] });
        },
        terminate() { target.terminated = true; },
        async quiescent() {
          if (!target.recoverable) return false;
          await target.waitOwnedActor();
          return true;
        }
      };
    }
  };
  const newBroker = () => new DesktopBroker({
    journal: { ...journal, state: saved }, host, driver, now: () => time,
    id: () => "id-" + ++id, commandMs, settleMs: 10
  });
  const broker = newBroker();
  const control = (method, params) => broker.control(method, { ...version, ...params });
  const request = () => "req-" + ++id;
  async function actor(name, { ops = ["click"], submit = true, runtime = "dedicated-stdio" } = {}) {
    const harness = name === "one" ? "codex" : "claude";
    const ancestor = { pid: name === "one" ? 1001 : 1002, start: name + "-generation", harness };
    const peer = { id: { pid: 1111, start: request() }, ancestors: [ancestor] };
    const connection = broker.connect(peer);
    const claim = "capacity-" + name;
    await control("admit-claim", {
      control_request_id: request(), capacity_claim_id: claim, scope_id: scope.id, start_by: 12_000, valid_until: 500_000, authority_id: "capacity-producer"
    });
    const enrollment = {
      control_request_id: request(), connection_id: connection.id, host_pid: ancestor.pid, host_start: ancestor.start, harness,
      session_id: "session-" + name, context_mode: runtime, identity_source: "loaded_host_registration", role: "worker", expires_at: 500_000,
      grants: [{ scope_id: scope.id, submit, read: true, effects: ops, observe_ticket_ids: [] }], capacity_claim_ids: [claim]
    };
    const receipt = await control("enroll", enrollment);
    const call = (method, params, session = enrollment.session_id) => broker.call(connection, method, { ...version, ...params }, session);
    return {
      connection, receipt, enrollment, call, claim,
      submit: (params = {}) => call("submit", {
        request_id: request(), title: "Check private-canary", scope_id: scope.id, start_deadline: 10_000, capacity_claim_id: claim,
        capacity_claim_start_by: 12_000, ...params
      })
    };
  }
  return {
    broker, target, control, actor, request, newBroker,
    open: () => control("restore", { control_request_id: request(), binding_id: display.id }),
    advance: delta => { time += delta; }, journalState: () => saved
  };
}

async function turn(h, actor, ticket) {
  const { ticket_id, lease_id, epoch } = await actor.call("claim", { request_id: h.request(), ticket_id: ticket.ticket_id });
  return { ticket_id, lease_id, epoch };
}
async function click(h, actor, lease) {
  const observed = await actor.call("observe", { ...lease, scope_id: scope.id });
  return { ...lease, request_id: h.request(), snapshot_id: observed.snapshot_id, ref: observed.tree.ref, operation: "click" };
}

test("eligible FIFO across harnesses, concurrency and monotonic handoff", async () => {
  const h = setup();
  await h.open();
  const first = await h.actor("one");
  const second = await h.actor("two");
  const a = await first.submit();
  const b = await second.submit();
  assert.equal(a.title, "Check [redacted]");
  assert.equal(b.queue_position, 2);
  await assert.rejects(turn(h, second, b), /first/);
  const request = { request_id: "race", ticket_id: a.ticket_id };
  const [lease1, replay] = await Promise.all([first.call("claim", request), first.call("claim", request)]);
  assert.deepEqual(lease1, replay);
  assert.equal(h.target.dispatches, 0);
  await assert.rejects(turn(h, second, b), /current or settling holder/);
  await first.call("release", { ticket_id: a.ticket_id, lease_id: lease1.lease_id, epoch: lease1.epoch, request_id: h.request(), result: "blocked" });
  const lease2 = await turn(h, second, b);
  assert.ok(lease2.epoch > lease1.epoch);
});

test("forged fields, copied handles, unknown or multiplexed session and scope escalation refuse", async () => {
  const h = setup();
  await h.open();
  const first = await h.actor("one");
  const second = await h.actor("two", { runtime: "host-injected-thread-id", ops: [] });
  const ticket = await first.submit();
  const unenrolled = h.broker.connect({ id: { pid: 3100 }, ancestors: [{ pid: 3200, harness: "codex" }] });
  await assert.rejects(h.broker.call(unenrolled, "capabilities", version), { code: "desktop_enrollment_required" });
  await assert.rejects(h.broker.call(unenrolled, "capabilities", { ...version, role: "manager", host: "codex" }), { code: "invalid_desktop_request" });
  await assert.rejects(second.call("capabilities", {}, null), { code: "desktop_session_unbound" });
  await assert.rejects(second.call("capabilities", {}, first.enrollment.session_id), { code: "desktop_session_unbound" });
  await assert.rejects(second.call("status", { ticket_id: ticket.ticket_id }), { code: "ticket_unavailable" });
  await assert.rejects(first.call("submit", { protocol_version: "1" }), { code: "invalid_desktop_request" });
  await assert.rejects(h.control("enroll", { ...first.enrollment, control_request_id: h.request(), connection_id: unenrolled.id }), { code: "host_identity_unknown" });
  assert.equal(h.target.dispatches, 0);
});

test("read-only grant rejects mutations and excluded operations dispatch zero driver calls", async () => {
  const h = setup();
  await h.open();
  const actor = await h.actor("one", { ops: [] });
  const lease = await turn(h, actor, await actor.submit());
  const params = await click(h, actor, lease);
  assert.equal(h.target.dispatches, 1);
  await assert.rejects(actor.call("act", params), { code: "operation_unsupported" });
  for (const op of ["shell", "mouse-click", "right-click", "double-click", "press-key", "clipboard", "screenshot", "batch"]) {
    await assert.rejects(actor.call("act", { ...params, operation: op }), { code: "invalid_desktop_request" });
  }
  assert.equal(h.target.dispatches, 1);
});

test("no qualified scope or finite claim can be minted by the requester", async () => {
  const h = setup();
  await h.open();
  const actor = await h.actor("one");
  await assert.rejects(actor.submit({ scope_id: "unqualified" }), { code: "scope_unsupported" });
  await assert.rejects(actor.submit({ capacity_claim_id: "made-up-claim" }), { code: "capacity_claim_unavailable" });
  const lease = await turn(h, actor, await actor.submit());
  assert.equal(h.target.dispatches, 0);
  h.advance(10_000);
  await assert.rejects(actor.call("observe", { ...lease, scope_id: scope.id }), /no longer authorizes/);
  assert.equal(h.target.effects, 0);
});

test("stale snapshots and changed geometry refuse before effect emission", async () => {
  const h = setup();
  await h.open();
  const actor = await h.actor("one");
  const lease = await turn(h, actor, await actor.submit());
  const params = await click(h, actor, lease);
  await click(h, actor, lease);
  await assert.rejects(actor.call("act", params), { code: "stale_reference" });
  const fresh = await click(h, actor, lease);
  h.target.ready = false;
  await assert.rejects(actor.call("act", fresh), { code: "target_binding_invalid" });
  assert.equal(h.target.effects, 0);
  assert.equal((await h.control("owner-status")).admission, "closed");
});

test("stop preempts asynchronous preparation and the permit stays unopened", async () => {
  const h = setup();
  await h.open();
  const actor = await h.actor("one");
  const lease = await turn(h, actor, await actor.submit());
  const params = await click(h, actor, lease);
  h.target.holdPrepare = deferred();
  h.target.prepared = deferred();
  const action = actor.call("act", params);
  await h.target.prepared.promise;
  const stop = await h.control("stop", { control_request_id: "operator-stop" });
  assert.equal(stop.handover, "settling");
  assert.equal(stop.admission, "closed");
  await assert.rejects(h.open(), { code: "restore_blocked" });
  h.target.holdPrepare.resolve();
  const result = await action;
  assert.equal(result.delivery, "not_dispatched");
  assert.equal(result.effect, "none");
  assert.equal(h.target.effects, 0);
  assert.equal((await h.control("owner-status")).handover, "clear");
  await h.open();
  assert.deepEqual(await h.control("stop", { control_request_id: "operator-stop" }), stop);
  assert.equal((await h.control("owner-status")).admission, "open");
});

test("owner reclaim acknowledges admission closed while the issued action settles", async () => {
  const h = setup();
  await h.open();
  const actor = await h.actor("one");
  const lease = await turn(h, actor, await actor.submit());
  const params = await click(h, actor, lease);
  h.target.hold = deferred();
  h.target.started = deferred();
  const action = actor.call("act", params);
  await h.target.started.promise;
  const stop = await h.control("reclaim", { control_request_id: "reclaim-1" });
  assert.equal(stop.completion, "settling");
  assert.equal(stop.admission, "closed");
  assert.equal(stop.last_owner_control.quiescent_at, null);
  await assert.rejects(h.open(), { code: "restore_blocked" });
  assert.equal(h.target.terminated, true);
  h.advance(5);
  h.target.hold.resolve();
  const result = await action;
  assert.equal(result.delivery, "uncertain");
  assert.equal(result.effect, "unknown");
  assert.equal(h.target.effects, 1);
  const current = await h.control("owner-status");
  assert.equal(current.handover, "clear");
  assert.equal(current.last_owner_control.completion, "completed");
  assert.equal(current.last_owner_control.quiescent_at - stop.admission_closed_at, 5);
  assert.equal((await h.control("reclaim", { control_request_id: "reclaim-1" })).completion, "settling");
});

test("lost ACK and conflicting request IDs never duplicate a non-idempotent effect", async () => {
  const h = setup();
  await h.open();
  const actor = await h.actor("one");
  const lease = await turn(h, actor, await actor.submit());
  const params = await click(h, actor, lease);
  h.target.lostAck = true;
  const first = await actor.call("act", params);
  assert.equal(first.delivery, "uncertain");
  assert.deepEqual(await actor.call("act", params), first);
  await assert.rejects(actor.call("act", { ...params, value: "different" }), { code: "request_id_conflict" });
  assert.equal(h.target.effects, 1);
  const next = await click(h, actor, lease);
  await assert.rejects(actor.call("act", next), { code: "uncertain_action_unresolved" });
  const ref = { ticket_id: lease.ticket_id, action_id: first.action_id, scope_id: scope.id };
  assert.equal((await actor.call("verify", ref)).effect, "unknown");
  h.target.verify = true;
  assert.equal((await actor.call("verify", ref)).effect, "verified");
  assert.equal(h.target.effects, 1);
});

test("a timeout with a surviving injector stays blocked, including after restart", async () => {
  const h = setup({ commandMs: 20 });
  await h.open();
  const first = await h.actor("one");
  const second = await h.actor("two");
  const lease = await turn(h, first, await first.submit());
  const b = await second.submit();
  const params = await click(h, first, lease);
  h.target.hold = deferred();
  h.target.recoverable = false;
  const action = first.call("act", params);
  await pause(40);
  const result = await action;
  assert.equal(result.handover, "blocked_settling");
  assert.equal(result.delivery, "uncertain");
  await assert.rejects(turn(h, second, b), /settling/);
  const restarted = h.newBroker();
  assert.equal(restarted.ownerStatus().handover, "blocked_settling");
  assert.equal(await restarted.recover(), false);
  await assert.rejects(restarted.control("restore", { ...version, control_request_id: "restart-restore", binding_id: display.id }), { code: "restore_blocked" });
  h.target.recoverable = true;
  assert.equal(await restarted.recover(), true);
  assert.equal(restarted.ownerStatus().handover, "clear");
  assert.equal(restarted.ownerStatus().admission, "closed");
});

test("transport loss does not imply requester death; confirmed loss and owner cancellation settle", async () => {
  const h = setup();
  await h.open();
  const a = await h.actor("one");
  const b = await h.actor("two");
  const lease = await turn(h, a, await a.submit());
  const wait = await b.submit();
  h.broker.disconnect(a.connection);
  await h.broker.tick();
  assert.equal((await h.control("owner-status")).active_ticket_id, lease.ticket_id);
  const cancellation = await h.control("owner-cancel", { control_request_id: "cancel-wait", ticket_id: wait.ticket_id });
  assert.equal(cancellation.state, "cancelled");
  h.target.sessionLive = false;
  await h.broker.tick();
  const view = await h.control("owner-status");
  assert.equal(view.active_ticket_id, null);
  assert.equal(view.tickets.find(row => row.ticket_id === lease.ticket_id).state, "requester_lost");
});

test("capacity revocation while queued or before issue fails closed", async () => {
  const h = setup();
  await h.open();
  const actor = await h.actor("one");
  const lease = await turn(h, actor, await actor.submit());
  h.target.capacity = false;
  await assert.rejects(actor.call("observe", { ...lease, scope_id: scope.id }), { code: "stale_lease" });
  assert.equal(h.target.dispatches, 0);
});

test("fresh installation is explicit and established missing or corrupt journals refuse", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "al-journal-"));
  const directory = path.join(parent, "desktop");
  try {
    assert.throws(() => openJournal(directory), { code: "desktop_journal_invalid" });
    initializeJournal(directory);
    const first = openJournal(directory);
    first.state.closed = "owner_stopped";
    first.save(first.state);
    assert.equal(openJournal(directory).state.closed, "owner_stopped");
    assert.throws(() => initializeJournal(directory));
    fs.writeFileSync(path.join(directory, "journal.json"), "{corrupt");
    assert.throws(() => openJournal(directory), { code: "desktop_journal_invalid" });
    fs.unlinkSync(path.join(directory, "journal.json"));
    assert.throws(() => openJournal(directory), { code: "desktop_journal_invalid" });
    assert.throws(() => initializeJournal(directory));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
