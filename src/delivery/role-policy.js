// src/delivery/role-policy.js
//
// Role addressing between persistent agents (design doc section 1.9). B9
// ships the plumbing with enforcement `off` by default (R1.26); B10 wires
// the remaining send paths and turns `warn` on.
//
//   persistent agent  a session that holds at least one role
//   worker            any other session, including `external`
//   coordination      a new message (not a reply) between two persistent agents
//
// A coordination message is direct when its target was an address, id, or
// query rather than role:<name>. Modes (R1.25):
//   off      no check
//   warn     delivered; a direct_coordination warning and a receipt tag
//   enforce  permission_denied (role_address_required); nothing is written
//
// Enforcement keeps coordination consistent. It is not a security boundary
// (R1.27).

import { AgentLinkError } from "../shared/errors.js";
import { EXTERNAL_ADDRESS } from "../shared/identity.js";

export const DIRECT_COORDINATION_TAG = "direct-coordination";

/**
 * @typedef {{
 *   mode: string,
 *   senderAddress: string | null,
 *   targetAddress: string | null,
 *   via?: string | null,
 *   isReply?: boolean,
 *   rolesOf: (address: string) => string[],
 *   holdingsOf?: ((address: string) => {roles: string[], projectRoots: string[]}) | null
 * }} RoleAddressingInput
 *
 * @typedef {{
 *   action: "allow" | "warn",
 *   reason: string,
 *   senderRoles: string[],
 *   recipientRoles: string[],
 *   warning?: {code: string, message: string, replacement: string, details: {recipientRoles: string[]}},
 *   tag?: string
 * }} RoleAddressingResult
 */

/**
 * R1.23: the one check every send path runs. Returns allow or warn, or
 * throws permission_denied under `enforce`.
 * @param {RoleAddressingInput} input
 * @returns {RoleAddressingResult}
 */
export function checkRoleAddressing({ mode, senderAddress, targetAddress, via = null, isReply = false, rolesOf, holdingsOf = null }) {
  if (mode !== "warn" && mode !== "enforce") {
    return { action: "allow", reason: "enforcement_off", senderRoles: [], recipientRoles: [] };
  }
  const known = (/** @type {string | null} */ address) => typeof address === "string" && address !== EXTERNAL_ADDRESS && address !== "invalid";
  const senderRoles = known(senderAddress) ? rolesOf(/** @type {string} */ (senderAddress)) : [];
  const recipientRoles = known(targetAddress) ? rolesOf(/** @type {string} */ (targetAddress)) : [];
  if (isReply) return { action: "allow", reason: "reply", senderRoles, recipientRoles };
  if (senderRoles.length === 0 || recipientRoles.length === 0) {
    return { action: "allow", reason: "worker", senderRoles, recipientRoles };
  }
  if (typeof via === "string" && via.startsWith("role:")) {
    return { action: "allow", reason: "role_addressed", senderRoles, recipientRoles };
  }
  // A target that holds the orchestrator role only for some projects
  // (R1.21) is not what role:orchestrator resolves to; it is reached through
  // the orchestrator tools with that projectRoot.
  const holdings = holdingsOf ? holdingsOf(/** @type {string} */ (targetAddress)) : null;
  const projectOnly = holdings !== null && holdings.roles.length === 0 && holdings.projectRoots.length > 0;
  const replacement = projectOnly ? "message_project_orchestrator" : `role:${holdings?.roles[0] ?? recipientRoles[0]}`;
  const projectDetails = projectOnly ? { projectRoots: holdings.projectRoots } : {};
  const sendHint = projectOnly
    ? `Send through message_project_orchestrator with projectRoot=${JSON.stringify(holdings.projectRoots[0])}, which addresses the orchestrator role for that project.`
    : `Send to ${replacement} instead of the session address.`;
  if (mode === "enforce") {
    throw new AgentLinkError("permission_denied", `${targetAddress} holds role ${recipientRoles.join(", ")}; coordination between persistent agents must be addressed to the role.`, {
      details: { reason: "role_address_required", recipientRoles, replacement, ...projectDetails },
      hint: `${sendHint} Replies are exempt.`
    });
  }
  return {
    action: "warn",
    reason: "direct_coordination",
    senderRoles,
    recipientRoles,
    warning: {
      code: "direct_coordination",
      message: projectOnly
        ? `${targetAddress} holds role ${recipientRoles.join(", ")} for a project; ${sendHint}`
        : `${targetAddress} holds role ${recipientRoles.join(", ")}; address coordination to ${replacement} so it reaches the current holder with its procedure.`,
      replacement,
      details: { recipientRoles, ...projectDetails }
    },
    tag: DIRECT_COORDINATION_TAG
  };
}
