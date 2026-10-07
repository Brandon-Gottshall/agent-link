// Role addressing between persistent agents (design doc T-1.10, R1.23-R1.26):
// for each mode and each sender/recipient pair, the check allows, warns, or
// rejects as specified. B9 ships the plumbing with `off` as the default.
import assert from "node:assert/strict";
import test from "node:test";
import { checkRoleAddressing } from "../../src/delivery/role-policy.js";
import { DEFAULT_ENFORCEMENT } from "../../src/registry/roles.js";

const ROUTER = "codex:019d9000-0000-7000-8000-0000000000r1";
const BUILDER = "claude:0b5e7c1a-3f2d-4a6e-9c8b-0000000000b1";
const WORKER = "codex:019d9000-0000-7000-8000-0000000000w1";
const roles = { [ROUTER]: ["router"], [BUILDER]: ["builder"] };
const rolesOf = (/** @type {string} */ address) => roles[address] ?? [];

const PAIRS = [
  { name: "persistent to persistent, direct", sender: ROUTER, target: BUILDER, via: null, isReply: false, coordination: true },
  { name: "persistent to persistent, via role", sender: ROUTER, target: BUILDER, via: "role:builder", isReply: false, coordination: false },
  { name: "persistent to worker", sender: ROUTER, target: WORKER, via: null, isReply: false, coordination: false },
  { name: "worker to persistent", sender: WORKER, target: BUILDER, via: null, isReply: false, coordination: false },
  { name: "external to persistent", sender: "external", target: BUILDER, via: null, isReply: false, coordination: false },
  { name: "reply between persistent agents", sender: BUILDER, target: ROUTER, via: null, isReply: true, coordination: false }
];

test("B9 ships with enforcement off", () => {
  assert.equal(DEFAULT_ENFORCEMENT, "off");
});

for (const mode of ["off", "warn", "enforce"]) {
  for (const pair of PAIRS) {
    test(`T-1.10 ${mode}: ${pair.name}`, () => {
      const run = () => checkRoleAddressing({ mode, senderAddress: pair.sender, targetAddress: pair.target, via: pair.via, isReply: pair.isReply, rolesOf });
      if (mode === "off" || !pair.coordination) {
        const result = run();
        assert.equal(result.action, "allow");
        assert.equal(result.warning, undefined);
        assert.equal(result.tag, undefined);
        return;
      }
      if (mode === "warn") {
        const result = run();
        assert.equal(result.action, "warn");
        assert.equal(result.tag, "direct-coordination");
        assert.deepEqual(result.warning.details.recipientRoles, ["builder"]);
        assert.equal(result.warning.replacement, "role:builder");
        assert.equal(result.warning.code, "direct_coordination");
        return;
      }
      assert.throws(run, (error) => error.errorCode === "permission_denied"
        && error.details.reason === "role_address_required"
        && error.details.recipientRoles[0] === "builder"
        && /role:builder/.test(error.hint));
    });
  }
}
