import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { controllerKey, privateFile } from "./journal.js";
import { digest, OPERATIONS } from "./protocol.js";

const BUNDLES = {
  "chrome-local": "com.google.Chrome",
  "preview-document": "com.apple.Preview",
  "textedit-document": "com.apple.TextEdit"
};
const MAX_PROBE_BYTES = 48 * 1024;

export function invokeNative(binary, operation, { args = [], payload = null, fd = null, timeout = 1_500 } = {}) {
  return new Promise(resolve => {
    const child = spawn(binary, [operation, ...args], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "ignore", ...(fd === null ? [] : [fd])]
    });
    let output = "";
    let ended = false;
    function finish(result) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      resolve(result);
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeout);
    child.stdout.setEncoding("utf8").on("data", chunk => {
      output += chunk;
      if (output.length > MAX_PROBE_BYTES) {
        child.kill("SIGKILL");
        finish(null);
      }
    });
    child.stdin.on("error", () => { /* Failed probe is reported via exit. */ });
    child.on("error", () => finish(null));
    child.on("close", code => {
      if (code !== 0) return finish(null);
      try {
        return finish(JSON.parse(output));
      } catch {
        return finish(null);
      }
    });
    child.stdin.end(payload === null ? "" : JSON.stringify(payload));
  });
}

export function geometry(rect) {
  return rect && ["x", "y", "width", "height"].every(key => Number.isFinite(rect[key])) &&
    rect.width > 0 && rect.height > 0;
}

export function inside(outer, inner) {
  return geometry(outer) && geometry(inner) && inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function proofForLocation(target, expected) {
  try {
    if (target.bundle !== BUNDLES["chrome-local"] && path.isAbsolute(target.location)) return fs.realpathSync(target.location) === expected;
    const url = new URL(target.location);
    if (target.bundle === BUNDLES["chrome-local"]) return !url.password && !url.username && url.origin === expected;
    return url.protocol === "file:" && fs.realpathSync(fileURLToPath(url)) === expected;
  } catch {
    return false;
  }
}

function localOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

function sameProcess(left, right) {
  return left && right && left.pid === right.pid && left.start === right.start &&
    left.uid === right.uid && left.binary === right.binary;
}

function exact(object, fields) {
  return object && typeof object === "object" && Object.keys(object).length === fields.length &&
    fields.every(field => Object.hasOwn(object, field));
}

function nonempty(value, max = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function controllerRecord(directory, kind, id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id)) return null;
  try {
    return JSON.parse(privateFile(path.join(directory, kind + "-" + id + ".json"), { max: 64 * 1024 }));
  } catch {
    return null;
  }
}

function withoutHandles(node) {
  const { ref: _ref, ...stable } = node;
  if (Array.isArray(stable.children)) stable.children = stable.children.map(withoutHandles);
  return stable;
}

export function createMacHost({ directory, helper, probe = invokeNative, readRecord = controllerRecord }) {
  const request = (operation, options) => probe(helper, operation, options);
  const identify = pid => request("identity", { args: [String(pid)] });
  const capture = scope => request("target", { payload: { pid: scope.pid, window: scope.window, kind: scope.kind } });

  function sameDisplay(display, binding) {
    return display && !display.mirrored && !display.asleep && geometry(display.geometry) &&
      display.uuid === binding.uuid && display.rotation === binding.rotation && digest(display.geometry) === digest(binding.geometry);
  }

  return {
    peer: fd => request("peer", { fd }),
    identify,
    isHarness(ancestor, harness) {
      const executable = path.basename(ancestor.binary || "");
      return harness === "claude" ? executable === "claude" : harness === "codex" && executable === "codex";
    },
    async sessionAlive(peer, ancestor) {
      const [caller, host] = await Promise.all([identify(peer.id.pid), identify(ancestor.pid)]);
      return sameProcess(caller, peer.id) && sameProcess(host, ancestor) && caller.ppid === peer.id.ppid;
    },
    async selectDisplay() {
      const displays = await request("displays");
      if (!Array.isArray(displays)) return null;
      const primary = displays.find(display => display.main);
      const candidates = displays.filter(display => !display.main && !display.mirrored && !display.asleep &&
        geometry(display.geometry) && display.geometry.height > display.geometry.width &&
        display.geometry.x + display.geometry.width <= primary?.geometry.x &&
        Math.hypot(display.width_mm, display.height_mm) / 25.4 >= 22 &&
        Math.hypot(display.width_mm, display.height_mm) / 25.4 <= 26);
      if (candidates.length !== 1) return null;
      const [display] = candidates;
      return { uuid: display.uuid, geometry: display.geometry, rotation: display.rotation, label: "Left portrait display" };
    },
    async validateBinding(binding, scope, { allowPlacement = false, requireUnedited = false } = {}) {
      if (!binding?.uuid || !geometry(binding.geometry)) return false;
      const displays = await request("displays");
      if (!Array.isArray(displays) || !sameDisplay(displays.find(display => display.uuid === binding.uuid), binding)) return false;
      if (!scope) return true;
      const qualification = readRecord(directory, "qualification", scope.qualification_id);
      const owner = readRecord(directory, "target", scope.ownership_id);
      if (!qualification || !owner || digest(qualification) !== scope.qualification_digest ||
        digest(owner) !== scope.ownership_digest) return false;
      const target = await capture(scope);
      if (!target || target.bundle !== scope.bundle || target.build !== scope.build || target.cdhash !== scope.cdhash || !sameProcess(target.process, scope.process) ||
        target.window !== scope.window || !proofForLocation(target, scope.location) ||
        (requireUnedited && scope.kind !== "chrome-local" && target.edited !== false)) return false;
      const contained = inside(binding.geometry, target.geometry);
      const expected = digest(target.geometry) === digest(scope.target_geometry);
      const beforePlacement = scope.placement_from && digest(target.geometry) === digest(scope.placement_from);
      if (contained && expected) return { contained: true, placement_pending: false, geometry: target.geometry };
      if (allowPlacement && beforePlacement) return { contained, placement_pending: true, geometry: target.geometry };
      return false;
    },
    async qualifyScope(scope, binding, driver) {
      const keys = ["id", "label", "kind", "pid", "window", "location", "canaries", "qualification_id", "ownership_id", "placement"];
      if (!exact(scope, keys) || !nonempty(scope.label) || !nonempty(scope.qualification_id) || !nonempty(scope.ownership_id) ||
        !Object.hasOwn(BUNDLES, scope.kind) || !Number.isSafeInteger(scope.pid) || scope.pid < 2 ||
        !Number.isSafeInteger(scope.window) || scope.window < 1 || !nonempty(scope.location, 2048) ||
        !Array.isArray(scope.canaries) || scope.canaries.length > 32 || !scope.canaries.every(value => nonempty(value, 256))) return null;
      const record = readRecord(directory, "qualification", scope.qualification_id);
      const owner = readRecord(directory, "target", scope.ownership_id);
      if (!driver?.ready || !owner || owner.kind !== scope.kind || owner.pid !== scope.pid || owner.window !== scope.window ||
        owner.location !== scope.location || owner.scope_id !== scope.id || owner.status !== "owned" || !nonempty(owner.producer) ||
        !record || record.status !== "qualified" || record.kind !== scope.kind || record.driver_sha256 !== driver?.sha256 ||
        record.profile !== driver?.profile || !nonempty(record.evidence_id) ||
        !Array.isArray(record.operations) || record.operations.length > OPERATIONS.length ||
        !record.operations.every(operation => OPERATIONS.includes(operation)) || !Array.isArray(record.selectors) ||
        record.selectors.length > 64 || !record.selectors.every(selector => {
          const fields = ["operation", "role", "name"];
          if (selector?.identifier !== undefined) fields.push("identifier");
          return exact(selector, fields) && ["click", "set-value"].includes(selector.operation) && nonempty(selector.role) &&
            nonempty(selector.name) && (selector.identifier === undefined || nonempty(selector.identifier, 256));
        })) return null;
      if (scope.kind === "chrome-local") {
        if (!localOrigin(scope.location) || owner.profile !== "dedicated-single-origin" ||
          record.environment !== "dedicated_single_origin_attested") return null;
      } else {
        try {
          if (!path.isAbsolute(scope.location) || fs.realpathSync(scope.location) !== scope.location || !fs.statSync(scope.location).isFile() ||
            record.environment !== "owned_project_document_attested") return null;
        } catch {
          return null;
        }
      }
      const target = await capture(scope);
      if (!target || !sameProcess(target.process, owner.process) || target.bundle !== BUNDLES[scope.kind] || target.build !== record.build || target.cdhash !== record.cdhash ||
        !proofForLocation(target, scope.location) ||
        !geometry(target.geometry) || !binding) return null;
      let targetGeometry = target.geometry;
      if (scope.placement !== null) {
        if (!record.operations.includes("place-window") || !exact(scope.placement, ["x", "y"]) ||
          !Number.isSafeInteger(scope.placement.x) || !Number.isSafeInteger(scope.placement.y)) return null;
        targetGeometry = { ...targetGeometry, ...scope.placement };
      }
      if (!inside(binding.geometry, targetGeometry)) return null;
      return {
        id: scope.id, kind: scope.kind, label: scope.canaries.reduce((label, canary) => label.replaceAll(canary, "[redacted]"), scope.label), pid: scope.pid, window: scope.window,
        bundle: target.bundle, build: target.build, cdhash: target.cdhash, process: target.process, location: scope.location,
        target_geometry: targetGeometry, placement_from: scope.placement && target.geometry, canaries: scope.canaries,
        qualification_id: scope.qualification_id, qualification_digest: digest(record), evidence_id: record.evidence_id,
        ownership_id: scope.ownership_id, ownership_digest: digest(owner), driver_sha256: driver.sha256,
        operations: record.operations.filter(op => op !== "place-window" || scope.placement !== null),
        selectors: record.selectors, qualified: true
      };
    },
    capacityActive(claim) {
      const record = readRecord(directory, "claim", claim.id);
      return record?.status === "active" && record.authority_id === claim.authority_id && record.capacity_claim_id === claim.id &&
        record.scope_id === claim.scope_id && record.start_by === claim.start_by && record.valid_until === claim.valid_until;
    },
    async verifyAbsent(scope) {
      const result = await request("target-presence", { payload: { pid: scope.pid, window: scope.window, start: scope.process.start } });
      return result?.present === false;
    },
    verifyEffect(scope, action, observation) {
      const record = readRecord(directory, "effect", action.action_id);
      if (record?.action_id === action.action_id && record.scope_id === scope.id &&
        record.observation_sha256 === digest(withoutHandles(observation.tree)) && nonempty(record.evidence_id)) return record;
      return null;
    },
    controllerKey: () => controllerKey(directory)
  };
}
