// src/delivery/override-policy.js
//
// Who may change an existing Codex thread's model, effort, or cwd (design doc
// section 9.2, PR B9). The decision is target-side:
//
//   - a value equal to the thread's own is not a change and is forwarded;
//   - the launcher of the thread may change its effort (R9.3);
//   - every other change needs an entry in the target's override policy
//     (roles.json overridePolicy, R9.4), keyed by the target's address or a
//     role it holds, listing the senders allowed to change each setting;
//   - an allowed change persists (Agent Link never sends a revert) and is
//     reported with its expected cost;
//   - a cwd change must stay inside the target's workspace, the git top level
//     of the thread's cwd (or the cwd itself outside a repository), after
//     symlinks are resolved, even when the policy allows it (R9.5);
//   - Claude targets accept no turn overrides (R9.6);
//   - allowTargetOverride grants nothing from 0.7.0 (R9.13).
//
// `model` in the policy covers modelProvider and serviceTier.

import fs from "node:fs";
import path from "node:path";
import { AgentLinkError } from "../shared/errors.js";
import { EXTERNAL_ADDRESS, isAddress } from "../shared/identity.js";
import { parseRoleAddress } from "../registry/roles.js";

/** Requested field -> policy setting. */
export const OVERRIDE_FIELDS = Object.freeze({
  cwd: "cwd",
  model: "model",
  modelProvider: "model",
  serviceTier: "model",
  effort: "effort"
});

/** Field order, so results and errors are stable. */
const FIELD_ORDER = /** @type {const} */ (["cwd", "model", "modelProvider", "serviceTier", "effort"]);

/** permission_denied reason per policy setting (section 3.2). */
export const DENIAL_REASONS = Object.freeze({
  model: "model_switch_requires_fork_or_opt_in",
  effort: "effort_not_permitted",
  cwd: "cwd_change_not_permitted"
});

/** Receipt kind per policy setting (R9.10). */
export const SWITCH_KINDS = Object.freeze({
  model: "model-switch",
  effort: "effort-change",
  cwd: "cwd-change"
});

/** The release in which allowTargetOverride becomes invalid_arguments (R9.13). */
export const ALLOW_TARGET_OVERRIDE_REMOVAL = "0.8.0";

/**
 * @typedef {{senderAddress: string | null, senderRoles: string[], targetAddress: string, targetRoles: string[]}} Parties
 * @typedef {{key: string, sender: string}} PolicyMatch
 */

/**
 * The policy entry and sender pattern that allow `setting`, or null.
 * `"*"` matches any sender with a runtime identity, never `external`.
 * @param {Record<string, Record<string, string[]>>} policy
 * @param {"model" | "effort" | "cwd"} setting
 * @param {Parties} parties
 * @returns {PolicyMatch | null}
 */
export function policyAllows(policy, setting, { senderAddress, senderRoles, targetAddress, targetRoles }) {
  if (!isAddress(senderAddress)) return null;
  const keys = [targetAddress, ...targetRoles.map((role) => `role:${role}`)];
  for (const key of keys) {
    const senders = policy?.[key]?.[setting];
    if (!Array.isArray(senders)) continue;
    for (const sender of senders) {
      if (sender === "*" && senderAddress !== EXTERNAL_ADDRESS) return { key, sender };
      if (sender === senderAddress) return { key, sender };
      const role = parseRoleAddress(sender);
      if (role && senderRoles.includes(role)) return { key, sender };
    }
  }
  return null;
}

/**
 * Real path of `target`, resolving symlinks in the longest existing prefix
 * when the path itself does not exist yet.
 * @param {string} target
 */
export function resolveRealPath(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The workspace of a thread cwd (R9.5): the git top level that contains it,
 * or the cwd itself outside a repository. Real paths.
 * @param {string} cwd
 */
export function workspaceRoot(cwd) {
  const start = resolveRealPath(cwd);
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * True when `candidate` (after symlinks) is `root` or inside it.
 * @param {string} candidate
 * @param {string} root
 */
export function isWithinWorkspace(candidate, root) {
  const relative = path.relative(root, resolveRealPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Same directory by real path (macOS /tmp is /private/tmp), else lexically.
 * @param {string} a
 * @param {string} b
 */
function sameDirectory(a, b) {
  return resolveRealPath(a) === resolveRealPath(b);
}

/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * The thread's own value of a field as the app-server reports it.
 * @param {any} thread
 * @param {string} field
 */
function ownValue(thread, field) {
  if (field === "effort") return text(thread?.reasoningEffort ?? thread?.effort);
  return text(thread?.[field]);
}

/**
 * @typedef {{
 *   field: string,
 *   setting: "model" | "effort" | "cwd",
 *   kind: string,
 *   previous: string | null,
 *   current: string,
 *   grantedBy: "launcher" | "policy",
 *   policy: PolicyMatch | null,
 *   expectedCost: {uncachedInputTokens: number | null, basis: string} | null
 * }} OverrideSwitch
 *
 * @typedef {{
 *   forward: Record<string, string>,
 *   switches: OverrideSwitch[],
 *   warnings: any[],
 *   denied: {reason: string, conflicts: Array<{field: string, requested: string, threadValue: string | null}>, workspace?: string | null} | null
 * }} OverrideDecision
 */

/**
 * Decides which requested overrides reach an existing Codex thread.
 * @param {{
 *   thread: any,
 *   args: Record<string, any>,
 *   steering?: boolean,
 *   parties: Parties,
 *   policy: Record<string, Record<string, string[]>>,
 *   launcher?: string | null,
 *   expectedCost?: {uncachedInputTokens: number | null, basis: string}
 * }} input
 * @returns {OverrideDecision}
 */
export function decideTargetOverrides({ thread, args, steering = false, parties, policy, launcher = null, expectedCost = { uncachedInputTokens: null, basis: "unknown" } }) {
  /** @type {Record<string, string>} */
  const forward = {};
  /** @type {OverrideSwitch[]} */
  const switches = [];
  const warnings = [];
  /** @type {Array<{field: string, requested: string, threadValue: string | null, reason: string}>} */
  const conflicts = [];
  let workspace = null;

  if (args.allowTargetOverride === true) {
    warnings.push({
      code: "ignored_argument",
      message: `allowTargetOverride grants nothing since 0.7.0 and becomes invalid_arguments in ${ALLOW_TARGET_OVERRIDE_REMOVAL}. Changing an existing thread's model, effort, or cwd needs its launcher (effort only) or the target's override policy (set_agent_override_policy, by the user).`,
      argument: "allowTargetOverride"
    });
  }

  for (const field of FIELD_ORDER) {
    const requested = text(args[field]);
    if (!requested) continue;
    const setting = /** @type {"model" | "effort" | "cwd"} */ (OVERRIDE_FIELDS[field]);
    const own = ownValue(thread, field);
    if (own && (field === "cwd" ? sameDirectory(own, requested) : own === requested)) {
      forward[field] = requested;
      continue;
    }
    if (steering) {
      // turn/steer ignores these fields: nothing changes, so nothing is checked.
      warnings.push(own
        ? { code: "target-override-ignored-steer", severity: "warning", field, requested, threadValue: own, message: `Steering an active turn does not change ${field}; the requested value was ignored.` }
        : unverifiedWarning(field, requested));
      continue;
    }
    if (field === "cwd") {
      workspace = own ? workspaceRoot(own) : null;
      if (own && workspace && !isWithinWorkspace(requested, workspace)) {
        conflicts.push({ field, requested, threadValue: own, reason: "cwd_outside_workspace" });
        continue;
      }
    }
    /** @type {"launcher" | "policy" | null} */
    let grantedBy = null;
    /** @type {PolicyMatch | null} */
    let match = null;
    if (setting === "effort" && isAddress(launcher) && launcher === parties.senderAddress) {
      grantedBy = "launcher";
    } else {
      match = policyAllows(policy, setting, parties);
      if (match) grantedBy = "policy";
    }
    if (field === "cwd" && grantedBy && !own) {
      // No reported cwd means no workspace to check against: never applied.
      conflicts.push({ field, requested, threadValue: null, reason: "cwd_outside_workspace" });
      continue;
    }
    if (!grantedBy) {
      if (!own) {
        // The thread does not report this value, so it is unknown whether the
        // request is a change; it is not applied (0.4.0 behavior).
        warnings.push(unverifiedWarning(field, requested));
        continue;
      }
      conflicts.push({ field, requested, threadValue: own, reason: DENIAL_REASONS[setting] });
      continue;
    }
    forward[field] = requested;
    switches.push({
      field,
      setting,
      kind: SWITCH_KINDS[setting],
      previous: own || null,
      current: requested,
      grantedBy,
      policy: match,
      expectedCost: setting === "effort" ? null : expectedCost
    });
  }

  if (conflicts.length > 0) {
    const first = conflicts.find((conflict) => conflict.reason === "cwd_outside_workspace") ?? conflicts[0];
    return {
      forward,
      switches,
      warnings,
      denied: {
        reason: first.reason,
        conflicts: conflicts.map(({ field, requested, threadValue }) => ({ field, requested, threadValue })),
        ...(first.reason === "cwd_outside_workspace" ? { workspace } : {})
      }
    };
  }
  return { forward, switches, warnings, denied: null };
}

/**
 * @param {string} field
 * @param {string} requested
 */
function unverifiedWarning(field, requested) {
  return {
    code: "target-override-unverified",
    severity: "warning",
    field,
    requested,
    message: `The app-server does not report this thread's ${field}, so the requested value was not applied. Changing it needs the thread's launcher (effort) or the target's override policy.`
  };
}

const DENIAL_HINTS = Object.freeze({
  model_switch_requires_fork_or_opt_in: "An existing thread keeps its model. Launch a new thread with the model you want, or ask the user to allow you in the target's override policy (set_agent_override_policy). A model switch persists and the next turn re-reads the whole thread uncached.",
  effort_not_permitted: "Only the thread's launcher may change its effort, unless the target's override policy allows you (set_agent_override_policy, by the user).",
  cwd_change_not_permitted: "Changing an existing thread's cwd needs the target's override policy (set_agent_override_policy, by the user). Omit cwd to run in the thread's own directory.",
  cwd_outside_workspace: "A thread's cwd can only move inside its workspace (the git top level of its current cwd, or that cwd outside a repository), after symlinks are resolved."
});

/**
 * The permission_denied error for a denied decision.
 * @param {NonNullable<OverrideDecision["denied"]>} denied
 * @param {string} threadId
 */
export function overrideDeniedError(denied, threadId) {
  const fields = denied.conflicts.map((conflict) => conflict.field).join(", ");
  return new AgentLinkError("permission_denied", `Refusing to change ${fields} of existing thread ${threadId} (${denied.reason}).`, {
    details: { reason: denied.reason, conflicts: denied.conflicts, ...(denied.workspace !== undefined ? { workspace: denied.workspace } : {}) },
    hint: DENIAL_HINTS[/** @type {keyof typeof DENIAL_HINTS} */ (denied.reason)] ?? "Omit cwd/model/effort to run the turn with the thread's own settings."
  });
}

/**
 * R9.6: any turn override aimed at a Claude session is unsupported.
 * @param {Record<string, any>} args
 * @param {string} address
 */
export function assertNoClaudeOverrides(args, address) {
  const given = FIELD_ORDER.filter((field) => text(args[field]));
  if (given.length === 0) return;
  throw new AgentLinkError("unsupported", `Claude sessions accept no turn overrides (${given.join(", ")}); ${address} is a Claude session.`, {
    details: { capability: "turn_overrides", fields: given, address },
    hint: "Omit cwd, model, effort, modelProvider, and serviceTier when messaging a Claude session."
  });
}
