import "../helpers/guard.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { DesktopBroker } from "../../src/desktop/broker.js";
import { createMacHost } from "../../src/desktop/host.js";
import { initializeJournal, openJournal } from "../../src/desktop/journal.js";
import { createDesktopClient, endpoint, ownerCall, serveDesktop } from "../../src/desktop/transport.js";
import { createVercelDriver, scopedSnapshot, VERCEL } from "../../src/desktop/vercel.js";
import { runtimeDesktopSession } from "../../src/desktop/tools.js";

const bounds = { x: -800, y: 100, width: 700, height: 700 };
const version = { protocol_version: 1 };
const chromeScope = {
  id: "demo", kind: "chrome-local", window: 20, target_geometry: bounds,
  canaries: ["redact-demo"], operations: ["close", "click", "set-value"],
  selectors: [{ operation: "click", role: "button", name: "Update counter" },
    { operation: "set-value", role: "textfield", name: "Label" }]
};
function chromeSnapshot() {
  const node = { role: "window", bounds, children: [
    { role: "webarea", bounds, children: [
      { role: "button", name: "Update counter", bounds, ref_id: "@sabc:e1", available_actions: ["Click", "RightClick"] },
      { role: "textfield", name: "Label", value: "contains redact-demo", bounds, ref_id: "@sabc:e2", available_actions: ["SetValue"] },
      { role: "menubutton", name: "Edit outside", bounds, ref_id: "@sabc:e3", available_actions: ["Click"] },
      { role: "button", name: "Browser permission", bounds, ref_id: "@sabc:e4", available_actions: ["Click"] }
    ] },
    { role: "button", name: "Close", bounds, ref_id: "@sabc:e5", available_actions: ["Click"] },
    { role: "button", name: "Full Screen", bounds, ref_id: "@sabc:e6", available_actions: ["Click"] }
  ] };
  return { version: "2.6", ok: true, command: "snapshot", data: { complete: true, window: { id: "w-20" }, snapshot_id: "sabc", tree: node } };
}

test("scoped snapshots redact canaries and expose opaque allowlisted refs only", () => {
  const snapshot = scopedSnapshot(chromeScope, JSON.stringify(chromeSnapshot()));
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.refs.size, 3);
  const text = JSON.stringify(snapshot.tree);
  assert.ok(text.includes("[redacted]"));
  for (const privateValue of ["@sabc:", "redact-demo", "Edit outside", "Full Screen"]) assert.ok(!text.includes(privateValue));
  const driver = createVercelDriver({ directory: os.tmpdir(), helper: "unused", driverHome: os.tmpdir(), brokerBuild: "test" });
  const [click, entry] = [...snapshot.refs.values()];
  assert.deepEqual(driver.command(chromeScope, click, "click", undefined), ["click", "@sabc:e1"]);
  assert.deepEqual(driver.command(chromeScope, entry, "set-value", "New label"), ["set-value", "@sabc:e2", "New label"]);
  for (const excluded of ["right-click", "press-key", "screenshot", "mouse-click", "clipboard", "batch"]) {
    assert.throws(() => driver.command(chromeScope, click, excluded, undefined), { code: "operation_unsupported" });
  }
  assert.throws(() => driver.command(chromeScope, entry, "set-value", "--headed"), { code: "operation_unsupported" });
  assert.equal(driver.identity.ready, false);
});

test("driver snapshot refuses incomplete, wrong window/geometry and nested web area", () => {
  for (const corrupt of [
    value => { value.data.complete = false; },
    value => { value.data.window.id = "w-21"; },
    value => { value.data.tree.bounds = { ...bounds, x: 36 }; },
    value => { value.data.tree.children[0].children.push({ role: "webarea", bounds }); },
    value => { value.data.tree.children[0].children[1].ref_id = "@sabc:e1"; }
  ]) {
    const input = chromeSnapshot();
    corrupt(input);
    assert.throws(() => scopedSnapshot(chromeScope, JSON.stringify(input)), { code: "snapshot_incomplete" });
  }
});

test("native scope rejects stale qualification, ownership, origin and topology", async () => {
  const geometry = { x: -900, y: 0, width: 900, height: 1600 };
  const selected = { uuid: "left", geometry, rotation: 90, width_mm: 300, height_mm: 540, main: false, asleep: false, mirrored: false };
  const main = { uuid: "main", geometry: { x: 0, y: 0, width: 2048, height: 1366 }, main: true };
  const processIdentity = { pid: 77, start: "100:1", uid: 501, binary: "/Applications/Dedicated.app/Contents/MacOS/Browser" };
  const qualified = { status: "qualified", kind: "chrome-local", build: "qualified-build", cdhash: "app-hash", environment: "dedicated_single_origin_attested",
    driver_sha256: VERCEL.sha256, profile: VERCEL.profile, evidence_id: "independent-evidence",
    operations: chromeScope.operations, selectors: chromeScope.selectors };
  const ownership = { kind: "chrome-local", pid: 77, window: 20, process: processIdentity, profile: "dedicated-single-origin",
    location: "http://127.0.0.1:4915", scope_id: "demo", status: "owned", producer: "trusted-controller" };
  let probeResult = {
    bundle: "com.google.Chrome", build: qualified.build, cdhash: qualified.cdhash,
    window: 20, process: processIdentity, geometry: bounds, location: ownership.location + "/test"
  };
  let qualification = qualified;
  let mirror = false;
  const scopeDefinition = { id: "demo", label: "Scoped project preview", kind: "chrome-local", pid: 77, window: 20,
    location: ownership.location, canaries: [], qualification_id: "qualified-1", ownership_id: "owned-1", placement: null };
  const host = createMacHost({
    directory: "unused", helper: "unused",
    probe: (_helper, operation) => Promise.resolve(operation === "displays" ? [main, { ...selected, mirrored: mirror }] : probeResult),
    readRecord: (_dir, type) => type === "qualification" ? qualification : ownership
  });
  const binding = await host.selectDisplay();
  assert.equal(binding.uuid, selected.uuid);
  const scope = await host.qualifyScope(scopeDefinition, binding, { ...VERCEL, ready: true });
  assert.ok(scope?.qualified);
  assert.equal((await host.validateBinding(binding, scope)).contained, true);
  assert.equal(await host.qualifyScope({ ...scopeDefinition, location: "https://example.org" }, binding, { ...VERCEL, ready: true }), null);
  probeResult = { ...probeResult, location: "https://example.org/signed-in" };
  assert.equal(await host.validateBinding(binding, scope), false);
  probeResult = { ...probeResult, location: ownership.location + "/test", process: { ...processIdentity, start: "100:2" } };
  assert.equal(await host.validateBinding(binding, scope), false);
  probeResult = { ...probeResult, process: processIdentity };
  qualification = { ...qualified, evidence_id: "changed-record" };
  assert.equal(await host.validateBinding(binding, scope), false);
  mirror = true;
  assert.equal(await host.selectDisplay(), null);
  assert.equal(await host.validateBinding(binding, null), false);
});

test("protocol metadata is exact and never comes from caller arguments or MCP labels", () => {
  assert.equal(runtimeDesktopSession({ params: { arguments: { callerThreadId: "forged" }, clientInfo: { name: "codex" } } }), null);
  assert.equal(runtimeDesktopSession({ params: { _meta: { "openai/codex": { callerThreadId: "verified-thread" } } } }), "verified-thread");
  assert.equal(runtimeDesktopSession({ params: { _meta: { callerThreadId: "one", "claudecode/sessionId": "two" } } }), "");
});

test("private socket separates controller proof from fresh forged client", async () => {
  // Short state path even under macOS's fixed sockaddr_un.sun_path limit.
  const real = fs.realpathSync(os.tmpdir());
  const parent = fs.mkdtempSync(path.join(real, "b"));
  const directory = path.join(parent, "d");
  let service;
  try {
    initializeJournal(directory);
    // Probe is deterministic; tests here exercise the wire protocol. The
    // native kernel lock/peer probe is covered independently on macOS.
    const driver = { identity: { ready: true }, brokerBuild: "test" };
    const host = {
      peer: async () => ({ id: { pid: 1110, start: "fake", binary: "Node" }, ancestors: [{ pid: 2100, start: "fake", binary: "fake host" }] })
    };
    service = await serveDesktop({
      directory, helper: "unused",
      probe: async () => ({ locked: true }),
      createBroker: () => new DesktopBroker({ journal: openJournal(directory), host, driver })
    });
    const owner = await ownerCall(directory, "owner-status", version);
    assert.equal(owner.admission, "closed");
    const desktop = createDesktopClient(() => directory);
    try {
      await assert.rejects(desktop.call("capabilities", { ...version, role: "manager" }, "fake-session"), { code: "invalid_desktop_request" });
      await assert.rejects(desktop.call("capabilities", version, "fake-session"), { code: "desktop_enrollment_required" });
      await assert.rejects(desktop.call("stop", { ...version, control_request_id: "forged-stop" }), { code: "invalid_desktop_request" });
    } finally {
      desktop.close();
    }
    const raw = net.createConnection(endpoint(directory));
    try {
      raw.setEncoding("utf8");
      const [initial] = await once(raw, "data");
      assert.ok(JSON.parse(initial).challenge);
      raw.write(JSON.stringify({ id: randomUUID(), mode: "controller", proof: "0".repeat(64) }) + "\n");
      const [response] = await once(raw, "data");
      assert.equal(JSON.parse(response).error.code, "desktop_connection_refused");
    } finally {
      raw.destroy();
    }
    assert.equal((await ownerCall(directory, "owner-status", version)).blocker, "initial_setup_required");
  } finally {
    await service?.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
