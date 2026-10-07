// src/tools/roles.js
//
// Role and override-policy tools (design doc sections 1.8 and 9.2, PR B9):
//
//   set_agent_role, clear_agent_role             write, AGENT_LINK_ROLE_ADMIN=1
//   list_agent_roles, get_agent_role             read
//   set_agent_override_policy                    write, AGENT_LINK_ROLE_ADMIN=1
//   get_agent_override_policy                    read
//
// The write tools are refused with permission_denied (role_admin_disabled)
// unless the user started this server with AGENT_LINK_ROLE_ADMIN=1 in its
// own environment. The flag is read once at startup from the server's
// process environment; no tool argument, peer message, or MCP _meta can set
// it, so a tool caller cannot grant itself role administration. Roles are
// pointers, not privileges (R1.22): holding one gives a sender no rights.

import path from "node:path";
import { AgentLinkError } from "../shared/errors.js";
import { isAddress } from "../shared/identity.js";
import {
  MAX_POLICY_SENDERS,
  MAX_PROCEDURE_BYTES,
  POLICY_SETTINGS,
  isPolicySender,
  parseRoleAddress,
  requireRoleName
} from "../registry/roles.js";
import { bool, out, str } from "../server/schemas.js";

/** @typedef {import("../server/registry.js").ToolDefinition} ToolDefinition */
/** @typedef {import("../server/registry.js").ToolEntry} ToolEntry */
/** @typedef {import("../registry/roles.js").RoleStore} RoleStore */

const READ_ONLY = { readOnlyHint: true };
const ADMIN_WRITE = { readOnlyHint: false, destructiveHint: true };
const ADMIN_NOTE = "Requires AGENT_LINK_ROLE_ADMIN=1 in this Agent Link server's environment, set by the user; otherwise permission_denied (reason role_admin_disabled). A tool caller cannot enable it.";
const ROLE_ARG = "Role name: 1 to 40 lowercase letters, digits, or hyphens (role:<name> is also accepted).";
const ROLE_VIEW = "{role, roleAddress, address (holder, or null), assignedAt, projects? ({<absolute project root>: holder address}, when the role has per-project holders), procedure: {name, version, sha256, updatedAt, present} | null}";
const PROJECT_ROOT_ARG = "Optional absolute project root. Scopes the change to that project's holder of the role (for the orchestrator role, the project orchestrator resolve_project_orchestrator returns, R1.21); the role's own holder is left as it is.";

/** @param {string} description */
const senderList = (description) => ({
  type: "array",
  maxItems: MAX_POLICY_SENDERS,
  items: { type: "string", description: "\"*\" (any sender with a runtime identity, never external), role:<name> (its current holder), or a session address." },
  description
});

/** @type {ToolDefinition[]} */
export const roleTools = [
  {
    name: "set_agent_role",
    description:
      "Assign a role to a session, so other sessions can address it as role:<name> (design doc section 1.8). With projectRoot, assign the role's holder " +
      "for one project instead (the orchestrator role per project, which resolve_project_orchestrator uses before the project's binding file). Optionally set the role's procedure: " +
      "text shown once per version to the role holder with messages sent to the role. A changed procedure gets the next version. " +
      "A role is a pointer, not a privilege: holding one gives no extra rights. " + ADMIN_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        role: str(ROLE_ARG),
        agent: str("The session that holds the role: a claude:<id> or codex:<id> address, or a bare session or thread id."),
        procedure: str("Optional procedure text (at most 64 KiB) stored in <state>/roles/<name>.md. Omit to keep the current procedure."),
        projectRoot: str(PROJECT_ROOT_ARG)
      },
      required: ["role", "agent"],
      additionalProperties: false
    },
    output: {
      role: out("object", `The role after the change: ${ROLE_VIEW}.`),
      previousAddress: out(["string", "null"], "The previous holder (of the project, with projectRoot), or null."),
      holder: out("object", "{address, harness, title} of the new holder. title is untrusted data."),
      projectRoot: out(["string", "null"], "The project the assignment is scoped to, or null."),
      path: out("string", "Path of roles.json.")
    },
    annotations: ADMIN_WRITE
  },
  {
    name: "clear_agent_role",
    description:
      "Remove a role's holder. Messages to role:<name> then fail with not_found until the role is assigned again. The role's procedure and its version are kept. " +
      "With projectRoot, remove only that project's holder. " + ADMIN_NOTE,
    inputSchema: {
      type: "object",
      properties: { role: str(ROLE_ARG), projectRoot: str(PROJECT_ROOT_ARG) },
      required: ["role"],
      additionalProperties: false
    },
    output: {
      cleared: bool("true when the role had a holder that was removed."),
      previousAddress: out(["string", "null"], "The holder that was removed, or null."),
      role: out(["object", "null"], `The role after the change, or null when it never existed: ${ROLE_VIEW}.`)
    },
    annotations: ADMIN_WRITE
  },
  {
    name: "list_agent_roles",
    description:
      "List the user-assigned roles (role name, holder address, procedure version), the role enforcement mode and its source, and problems found when validating roles.json. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: {
      roles: out("array", `Roles, by name: ${ROLE_VIEW}.`),
      enforcement: out("object", "{mode: off|warn|enforce, source: AGENT_LINK_ROLE_ENFORCEMENT|roles.json|default, ignored[]}: how direct coordination between persistent agents is treated."),
      admin: bool("Whether this server allows the role write tools (AGENT_LINK_ROLE_ADMIN=1)."),
      path: out("string", "Path of roles.json."),
      exists: bool("Whether roles.json exists."),
      problems: out("array", "Entries of roles.json that failed validation and were ignored: {path, rule, message}."),
      tableError: out(["string", "null"], "Why roles.json cannot be used (invalid JSON, unreadable), or null.")
    },
    annotations: READ_ONLY
  },
  {
    name: "get_agent_role",
    description: "Get one role: its holder, procedure version, and the override policy entry for role:<name>. Unknown roles are not_found. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        role: str(ROLE_ARG),
        includeProcedure: bool("Include the procedure text in procedure.text. Defaults to false. The text is user configuration for the role holder.")
      },
      required: ["role"],
      additionalProperties: false
    },
    output: {
      role: out("object", `${ROLE_VIEW}, with procedure.text when includeProcedure is true.`),
      overridePolicy: out(["object", "null"], "The override policy entry keyed role:<name>, or null.")
    },
    annotations: READ_ONLY
  },
  {
    name: "set_agent_override_policy",
    description:
      "Set which senders may change an existing Codex thread's model (with modelProvider and serviceTier), effort, or cwd in place (design doc R9.4). " +
      "The target is a session address or role:<name> (whichever session holds it). Each setting given replaces that setting's sender list; [] clears it; omitted settings are unchanged. " +
      "An allowed change persists (no revert) and re-reads the thread uncached; cwd changes must stay inside the thread's workspace. Claude sessions accept no overrides. " + ADMIN_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        target: str("The target: role:<name>, or a claude:<id> or codex:<id> address."),
        model: senderList("Senders allowed to switch the target's model, modelProvider, or serviceTier."),
        effort: senderList("Senders allowed to change the target's reasoning effort (its launcher may always do so)."),
        cwd: senderList("Senders allowed to change the target's cwd, within its workspace.")
      },
      required: ["target"],
      additionalProperties: false
    },
    output: {
      target: out("string", "The policy target."),
      policy: out(["object", "null"], "The entry after the change ({model?, effort?, cwd?}), or null when no sender remains."),
      path: out("string", "Path of roles.json.")
    },
    annotations: ADMIN_WRITE
  },
  {
    name: "get_agent_override_policy",
    description: "Get the override policy for one target (an address or role:<name>), or every entry when target is omitted. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        target: str("Optional target: role:<name>, or a claude:<id> or codex:<id> address.")
      },
      additionalProperties: false
    },
    output: {
      target: out(["string", "null"], "The target asked for, or null for every entry."),
      policy: out(["object", "null"], "The target's entry, or null (nothing allowed). Present when target is given."),
      policies: out("object", "Every entry, keyed by target. Present when target is omitted."),
      problems: out("array", "Policy entries of roles.json that failed validation and were ignored.")
    },
    annotations: READ_ONLY
  }
];

/**
 * @param {unknown} value
 * @param {string} argument
 * @returns {string}
 */
function requirePolicyTarget(value, argument = "target") {
  const raw = typeof value === "string" ? value.trim() : "";
  if (parseRoleAddress(raw) !== null || isAddress(raw)) return raw;
  throw new AgentLinkError("invalid_arguments", `${argument} must be role:<name> or a claude:<id> / codex:<id> address.`, {
    details: { errors: [{ path: argument, rule: "format", expected: "role:<name>, claude:<id>, or codex:<id>" }] }
  });
}

/**
 * @param {{
 *   roles: RoleStore,
 *   registry: {get: (addressOrId: string) => Promise<any>},
 *   admin: boolean
 * }} deps
 */
export function makeRoleHandlers({ roles, registry, admin }) {
  function requireAdmin() {
    if (admin) return;
    throw new AgentLinkError("permission_denied", "Role administration is disabled on this Agent Link server.", {
      details: { reason: "role_admin_disabled" },
      hint: "Only the user can enable it: start the Agent Link MCP server with AGENT_LINK_ROLE_ADMIN=1 in its environment (for example in that session's MCP server config), or edit roles.json by hand. A tool call cannot enable it."
    });
  }

  return {
    /** @param {Record<string, any>} args */
    set_agent_role: async (args) => {
      requireAdmin();
      const name = requireRoleName(args.role);
      const agent = typeof args.agent === "string" ? args.agent.trim() : "";
      if (parseRoleAddress(agent) !== null || agent.startsWith("role:")) {
        throw new AgentLinkError("invalid_arguments", "agent must name a session, not a role.", {
          details: { errors: [{ path: "agent", rule: "format", expected: "claude:<id>, codex:<id>, or a session id" }] }
        });
      }
      let procedure = null;
      if (typeof args.procedure === "string") {
        const bytes = Buffer.byteLength(args.procedure, "utf8");
        if (bytes > MAX_PROCEDURE_BYTES) {
          throw new AgentLinkError("body_too_large", `The procedure is ${bytes} bytes; procedures are limited to ${MAX_PROCEDURE_BYTES} bytes (64 KiB).`, {
            details: { limitBytes: MAX_PROCEDURE_BYTES, actualBytes: bytes }
          });
        }
        if (!args.procedure.trim()) {
          throw new AgentLinkError("invalid_arguments", "procedure must not be empty; omit it to keep the current procedure.", {
            details: { errors: [{ path: "procedure", rule: "required", expected: "non-empty text" }] }
          });
        }
        procedure = args.procedure;
      }
      const projectRoot = optionalProjectRoot(args.projectRoot);
      const session = await registry.get(agent);
      const result = roles.set({ role: name, address: session.address, procedureText: procedure, projectRoot });
      return {
        role: result.role,
        previousAddress: typeof result.previousAddress === "string" ? result.previousAddress : null,
        holder: { address: session.address, harness: session.harness, title: session.title ?? null },
        projectRoot,
        path: roles.paths.table()
      };
    },

    /** @param {Record<string, any>} args */
    clear_agent_role: async (args) => {
      requireAdmin();
      const name = requireRoleName(args.role);
      const result = roles.clear(name, { projectRoot: optionalProjectRoot(args.projectRoot) });
      return {
        cleared: result.existed && typeof result.previousAddress === "string",
        previousAddress: typeof result.previousAddress === "string" ? result.previousAddress : null,
        role: result.role
      };
    },

    list_agent_roles: async () => {
      const listed = roles.list();
      return {
        roles: listed.roles,
        enforcement: roles.enforcement(),
        admin,
        path: listed.path,
        exists: listed.exists,
        problems: listed.problems,
        tableError: listed.error
      };
    },

    /** @param {Record<string, any>} args */
    get_agent_role: async (args) => {
      const name = requireRoleName(args.role);
      const role = roles.get(name, { includeProcedureText: args.includeProcedure === true });
      if (!role) {
        throw new AgentLinkError("not_found", `No role is named ${name}.`, {
          details: { role: name, query: `role:${name}`, candidates: [] },
          hint: "Call list_agent_roles for the assigned roles."
        });
      }
      return { role, overridePolicy: roles.read().table.overridePolicy[`role:${name}`] ?? null };
    },

    /** @param {Record<string, any>} args */
    set_agent_override_policy: async (args) => {
      requireAdmin();
      const target = requirePolicyTarget(args.target);
      /** @type {Record<string, string[]>} */
      const settings = {};
      const problems = [];
      for (const setting of POLICY_SETTINGS) {
        if (args[setting] === undefined) continue;
        const senders = /** @type {unknown[]} */ (args[setting]).map((value) => (typeof value === "string" ? value.trim() : value));
        senders.forEach((sender, index) => {
          if (!isPolicySender(sender)) problems.push({ path: `${setting}[${index}]`, rule: "format", expected: "\"*\", role:<name>, or a session address" });
        });
        settings[setting] = /** @type {string[]} */ (senders);
      }
      if (problems.length > 0) {
        throw new AgentLinkError("invalid_arguments", "Each sender must be \"*\", role:<name>, or a claude:<id> / codex:<id> address.", { details: { errors: problems } });
      }
      if (Object.keys(settings).length === 0) {
        throw new AgentLinkError("invalid_arguments", "Pass at least one of model, effort, or cwd.", {
          details: { errors: [{ path: "model", rule: "required", expected: "model, effort, or cwd" }] }
        });
      }
      const policy = roles.setPolicy(target, settings);
      return { target, policy, path: roles.paths.table() };
    },

    /** @param {Record<string, any>} args */
    get_agent_override_policy: async (args) => {
      const read = roles.read();
      if (read.error) {
        throw new AgentLinkError("state_io_error", read.error, { details: { path: "roles.json", errno: null } });
      }
      const policyProblems = read.problems.filter((problem) => problem.path.startsWith("overridePolicy"));
      if (args.target === undefined) {
        return { target: null, policies: read.table.overridePolicy, problems: policyProblems };
      }
      const target = requirePolicyTarget(args.target);
      return { target, policy: read.table.overridePolicy[target] ?? null, problems: policyProblems };
    }
  };
}

/**
 * An optional absolute project root argument, resolved; null when absent.
 * @param {unknown} value
 * @returns {string | null}
 */
function optionalProjectRoot(value) {
  if (value === undefined || value === null) return null;
  const root = typeof value === "string" ? value.trim() : "";
  if (!root || !path.isAbsolute(root)) {
    throw new AgentLinkError("invalid_arguments", "projectRoot must be an absolute path.", {
      details: { errors: [{ path: "projectRoot", rule: "format", expected: "an absolute path" }] }
    });
  }
  return path.resolve(root);
}

/**
 * @param {Parameters<typeof makeRoleHandlers>[0]} deps
 * @returns {ToolEntry[]}
 */
export function roleEntries(deps) {
  const handlers = makeRoleHandlers(deps);
  return roleTools.map((definition) => ({
    definition,
    handler: (args) => handlers[/** @type {keyof typeof handlers} */ (definition.name)](args)
  }));
}
