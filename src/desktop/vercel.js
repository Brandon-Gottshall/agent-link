import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { geometry, inside, invokeNative } from "./host.js";
import { digest, refuse } from "./protocol.js";

export const VERCEL = Object.freeze({
  version: "1.2.0",
  revision: "2b0a7334fc111730454b726e6800aa41cdafc093",
  archive_sha256: "219813428bb1ad8decae172faed05c5964a2415170df402e2786ccfa6452ba82",
  sha256: "dec75e0bba0d1f9b589bdb88188770ad1a199cde9e02cf0a5b94175491f738e9",
  helper_sha256: "4a795a40ba7fc93b726b0834342f0225779c30d83e28f1f219db479860c38a78",
  profile: "headless-signal-deny-fork-deny-v1"
});

const MAX_OUTPUT = 768 * 1024;
const REF_PATTERN = /^@(s[a-z0-9]+):e[1-9][0-9]*$/;
const SAFE_ROLES = new Set([
  "window", "webarea", "group", "heading", "statictext", "status", "text", "button", "textfield", "textarea",
  "incrementor", "switch", "radiobutton", "dialog", "alert", "scrollarea", "toolbar", "list", "listitem",
  "table", "row", "cell", "grid", "article", "paragraph", "checkbox", "document"
]);
const STEPS = new Set(["AXPress", "AXOpen", "activate_descendant", "select_within_container", "AXConfirm", "AXValue", "window_move", "window_resize", "IncrementToDynamic"]);
const DENIED_ROLES = new Set(["menubar", "menu", "menuitem", "menubutton", "sheet", "popover", "systemdialog"]);

function hashFile(file, cap = 16 * 1024 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > cap || (stat.mode & 0o022) !== 0) return null;
    return createHash("sha256").update(fs.readFileSync(fd)).digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

export function authenticDriver(directory) {
  try {
    return hashFile(path.join(directory, "agent-desktop")) === VERCEL.sha256 &&
      hashFile(path.join(directory, "agent-desktop-macos-helper")) === VERCEL.helper_sha256;
  } catch {
    return false;
  }
}

function sanitized(text, canaries) {
  if (typeof text !== "string") return undefined;
  return canaries.reduce((out, canary) => out.replaceAll(canary, "[redacted]"), text).slice(0, 320);
}

function outputEnvelope(childOutput) {
  try {
    const parsed = JSON.parse(childOutput);
    return parsed?.version === "2.6" ? parsed : null;
  } catch {
    return null;
  }
}

function candidateOperations(scope, node, { insideWeb, directWindowChild }) {
  const available = Array.isArray(node.available_actions) ? node.available_actions : [];
  if (node.role === "button" && directWindowChild && node.name === "Close" && available.includes("Click") &&
    scope.operations.includes("close")) return ["close"];
  if (scope.kind === "chrome-local" && !insideWeb) return [];
  if (scope.kind === "preview-document" && node.role !== "switch" && node.role !== "radiobutton") return [];
  return scope.selectors.filter(selector => scope.operations.includes(selector.operation) &&
    node.role === selector.role && node.name === selector.name &&
    (!selector.identifier || selector.identifier === node.native_id?.value) &&
    (selector.operation === "click" ? available.includes("Click") && ["button", "switch", "radiobutton", "checkbox"].includes(node.role)
      : available.includes("SetValue") && ["textfield", "textarea", "incrementor"].includes(node.role)))
    .map(selector => selector.operation);
}

export function scopedSnapshot(scope, output) {
  const envelope = outputEnvelope(output);
  const data = envelope?.data;
  if (envelope?.ok !== true || envelope.command !== "snapshot" || data?.complete !== true ||
    data.window?.id !== "w-" + scope.window || data.tree?.role !== "window" ||
    !geometry(data.tree.bounds) || digest(data.tree.bounds) !== digest(scope.target_geometry) ||
    !/^s[a-z0-9]+$/.test(data.snapshot_id ?? "")) {
    refuse("snapshot_incomplete", "The exact-window snapshot did not prove complete scoped coverage. Observe again after revalidation.");
  }
  let budget = 1_800;
  let chromeWebAreas = 0;
  const refs = new Map();
  const vendorRefs = new Set();
  function project(node, depth = 0, insideWeb = false) {
    if (!node || typeof node !== "object" || --budget < 0 || depth > 48 ||
      (depth > 0 && node.role === "window") || !Array.isArray(node.children ?? [])) {
      refuse("snapshot_incomplete", "The snapshot exceeded the supported scoped tree shape.");
    }
    if (node.role === "webarea") {
      chromeWebAreas++;
      insideWeb = true;
    }
    if (DENIED_ROLES.has(node.role)) return null;
    const children = (node.children ?? []).map(child => project(child, depth + 1, insideWeb)).filter(Boolean);
    const output = {
      role: SAFE_ROLES.has(node.role) ? node.role : "group",
      name: sanitized(node.name, scope.canaries),
      value: node.role === "passwordfield" ? undefined : sanitized(node.value, scope.canaries),
      children
    };
    const ops = candidateOperations(scope, node, { insideWeb, directWindowChild: depth === 1 });
    if (scope.kind === "chrome-local" && !insideWeb && depth > 0 && !ops.includes("close")) {
      output.name = undefined;
      output.value = undefined;
    }
    const refMatch = typeof node.ref_id === "string" && REF_PATTERN.exec(node.ref_id);
    if (refMatch && refMatch[1] === data.snapshot_id && inside(scope.target_geometry, node.bounds) && ops.length > 0) {
      if (vendorRefs.has(node.ref_id)) refuse("snapshot_incomplete", "The driver returned a duplicate scoped reference.");
      vendorRefs.add(node.ref_id);
      const ref = randomUUID();
      refs.set(ref, { operations: ops, vendorRef: node.ref_id });
      output.ref = ref;
      output.operations = ops;
    }
    return output;
  }
  const tree = project(data.tree);
  if (scope.kind === "chrome-local" && chromeWebAreas !== 1) refuse("snapshot_incomplete", "Only a single scoped web area is supported in the dedicated browser window.");
  return { complete: true, tree, refs, warnings: [] };
}

export function placementSnapshot() {
  const ref = randomUUID();
  return {
    complete: true, tree: { role: "window", ref, operations: ["place-window"] },
    refs: new Map([[ref, { operations: ["place-window"], vendorRef: null }]]),
    warnings: ["The owned window must be placed on the reserved display before reading its content."]
  };
}

function allowedCommand(scope, ref, operation, value) {
  if (!ref.operations.includes(operation)) refuse("operation_unsupported", "This scoped reference does not permit that operation.");
  if (operation === "place-window") {
    if (value !== undefined || !scope.placement_from) refuse("operation_unsupported", "Only controller-configured window placement is supported.");
    const { x, y } = scope.target_geometry;
    return ["move-window", "--app", scope.bundle, "--window-id", "w-" + scope.window, "--x=" + x, "--y=" + y];
  }
  if (typeof ref.vendorRef !== "string" || !REF_PATTERN.test(ref.vendorRef)) refuse("stale_reference", "The scoped reference expired. Observe again.");
  if (operation === "set-value") {
    if (typeof value !== "string" || value.length > 4096 || value.includes("\0") || value.startsWith("-")) {
      refuse("operation_unsupported", "Provide a text value of up to 4096 characters without a leading flag marker.");
    }
    return ["set-value", ref.vendorRef, value];
  }
  if (value !== undefined || !["click", "close"].includes(operation)) refuse("operation_unsupported", "This operation takes only the scoped reference.");
  return ["click", ref.vendorRef];
}

function disposition(result, requestedCommand) {
  if (result?.command !== requestedCommand) return { delivery: "uncertain", partial_effects: [] };
  if (result.ok && result.command === "snapshot") return { delivery: "delivered", partial_effects: [] };
  const data = result.data;
  const delivery = data?.disposition?.delivery;
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  const partial_effects = steps.filter(step => step.outcome === "succeeded" && STEPS.has(step.label))
    .map(step => ({ step: step.label, mechanism: "semantic", verified: false }));
  if (steps.some(step => step.mechanism?.startsWith("physical"))) return { delivery: "uncertain", partial_effects, routeViolation: true };
  if (["delivered_unverified", "delivered_verified"].includes(delivery)) return { delivery: "delivered", partial_effects };
  if (delivery === "not_delivered" && partial_effects.length === 0) return { delivery: "not_delivered", partial_effects };
  return { delivery: "uncertain", partial_effects };
}

export function createVercelDriver({ directory, helper, driverHome, brokerBuild, probe = invokeNative }) {
  const binary = path.join(directory, "agent-desktop");
  const inspect = (lifetime, timeout) => probe(helper, "inspect-injector", { payload: lifetime, timeout });
  const identity = Object.freeze({ ...VERCEL, ready: authenticDriver(directory) });

  return {
    identity, brokerBuild,
    command: allowedCommand,
    snapshot: scopedSnapshot,
    placementSnapshot,
    async recover(lifetime) {
      // A recovered PID is never signalled. If it or its group remains live
      // (or evidence is unavailable), admission stays visibly closed.
      return (await inspect(lifetime, 1_000))?.quiescent === true;
    },
    async prepare(scope, method, command) {
      if (!identity.ready || scope.driver_sha256 !== identity.sha256 || !authenticDriver(directory)) {
        refuse("driver_identity_invalid", "The installed Vercel executable pair does not match the pinned artifact.");
      }
      const args = method === "observe"
        ? ["snapshot", "--app", scope.bundle, "--window-id", "w-" + scope.window, "--compact", "--include-bounds", "--timeout-ms", "8000"]
        : command;
      const child = spawn(helper, ["supervise", binary, ...args], {
        env: { PATH: "/usr/bin:/bin", AGENT_DESKTOP_HOME: driverHome, HOME: driverHome, LC_ALL: "C" },
        cwd: driverHome, detached: true, stdio: ["pipe", "pipe", "ignore"]
      });
      let output = "";
      let overflow = false;
      child.stdout.setEncoding("utf8").on("data", chunk => {
        if (overflow) return;
        output += chunk;
        if (output.length > MAX_OUTPUT) {
          overflow = true;
          output = "";
          terminate();
        }
      });
      child.stdin.on("error", () => { /* Broken launch pipe is reflected in uncertain delivery. */ });
      const outcome = new Promise(resolve => {
        child.on("error", () => resolve({ output: null, delivery: "uncertain", partial_effects: [] }));
        child.on("close", () => {
          const result = !overflow && outputEnvelope(output);
          resolve({ output, ...disposition(result, args[0]) });
        });
      });
      function terminate() {
        child.stdin.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      try {
        const captured = child.pid && await probe(helper, "identity", { args: [String(child.pid)], timeout: 750 });
        if (!captured || captured.pgid !== child.pid || captured.uid !== process.getuid?.() || captured.binary !== helper) {
          refuse("driver_lifetime_unknown", "The owned launch gate did not produce a reliable process lifetime.");
        }
        const lifetime = { pid: captured.pid, start: captured.start };
        return {
          lifetime, outcome, terminate,
          permit() { child.stdin.end("R"); },
          async quiescent(ms) {
            const deadline = Date.now() + ms;
            do {
              const remaining = deadline - Date.now();
              if (remaining <= 0) break;
              if ((await inspect(lifetime, Math.min(remaining, 500)))?.quiescent === true) return true;
              if (deadline > Date.now()) await delay(Math.min(deadline - Date.now(), 40));
            } while (Date.now() < deadline);
            return false;
          }
        };
      } catch (error) {
        terminate();
        throw error;
      }
    }
  };
}
