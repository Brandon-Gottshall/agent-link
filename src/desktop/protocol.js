import { createHash } from "node:crypto";
import { validateSchema } from "../server/validate.js";

export const VERSION = 1;
export const OPERATIONS = ["click", "set-value", "close", "place-window"];
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
const text = { type: "string", maxLength: 4096 };
const timestamp = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const protocol = { type: "integer", enum: [VERSION], description: "Reserved-screen protocol version. Use 1." };
const descriptions = {
  request_id: "Immutable ID for this request. Reuse only for the identical payload.",
  control_request_id: "Immutable ID for this control request.",
  ticket_id: "Ticket ID from submission.",
  scope_id: "Scope ID from your current controller grant.",
  lease_id: "Current lease ID from claim.",
  epoch: "Current lease epoch from claim.",
  title: "Short task title visible in GUI Queue.",
  start_deadline: "Absolute epoch milliseconds for the latest start permitted by the task.",
  capacity_claim_id: "Finite, validated capacity claim ID for this scope.",
  capacity_claim_start_by: "Absolute epoch milliseconds for the capacity start deadline from capabilities.",
  snapshot_id: "Fresh scoped observation ID.",
  ref: "Opaque reference from this exact observation.",
  operation: "Single operation allowed on this reference.",
  value: "Text value for set-value. Omit for click, close and placement.",
  action_id: "Action ID to reconcile.",
  result: "Requested terminal disposition. Unknown effects remain partial.",
  binding_id: "Currently selected display binding ID.",
  principal_id: "Enrolled connection principal ID."
};
const scoped = { scope_id: id };
const ticket = { ticket_id: id };
const lease = { ...ticket, lease_id: id, epoch: timestamp };
const request = { request_id: id };
const control = { control_request_id: id };

export const methods = Object.freeze({
  capabilities: {
    schema: schema({}),
    description: "Discover the shared reserved-screen queue, your qualified scopes and capacity claims.",
    readOnly: true
  },
  submit: {
    schema: schema({ ...request, ...scoped, title: { ...text, minLength: 1, maxLength: 120 }, start_deadline: timestamp, capacity_claim_id: id, capacity_claim_start_by: timestamp }),
    description: "Queue one scoped desktop task with the deadline and finite capacity claim issued by the controller."
  },
  status: {
    schema: schema(ticket),
    description: "Read your ticket's queue, authority, delivery, effect and settlement state.",
    readOnly: true
  },
  claim: {
    schema: schema({ ...request, ...ticket }),
    description: "Claim your ticket's turn when it is the first eligible ticket. A claim performs no desktop action."
  },
  heartbeat: {
    schema: schema({ ...request, ...lease }),
    description: "Renew your current lease while working. Use a fresh request ID for each renewal."
  },
  observe: {
    schema: schema({ ...lease, ...scoped }),
    description: "Observe your owned window and obtain fresh, scoped element references.",
    readOnly: true
  },
  act: {
    schema: schema({ ...request, ...lease, snapshot_id: id, ref: id, operation: { type: "string", enum: OPERATIONS }, value: text }, ["value"]),
    description: "Issue one qualified semantic operation. Use a new request ID for a new intent and verify effect separately."
  },
  verify: {
    schema: schema({ ...ticket, ...scoped, action_id: id }),
    description: "Reconcile an action using its scoped observation and independent effect evidence. Never repeats the action.",
    readOnly: true
  },
  cancel: {
    schema: schema({ ...request, ...ticket }),
    description: "Cancel your queued ticket or stop new work on your active ticket while its driver settles."
  },
  release: {
    schema: schema({ ...request, ...lease, result: { type: "string", enum: ["finished", "partial", "blocked"] } }),
    description: "Release the current turn after your work. Uncertain effects remain visible."
  }
});

export const controls = Object.freeze({
  "owner-status": schema({}),
  stop: schema(control),
  reclaim: schema(control),
  restore: schema({ ...control, binding_id: id }),
  "owner-cancel": schema({ ...control, ...ticket }),
  "recover-settling": schema(control),
  "pending-connections": schema({}),
  "revoke-claim": schema({ ...control, capacity_claim_id: id }),
  "revoke-session": schema({ ...control, principal_id: id })
});

/** @param {Record<string, import("../server/validate.js").JsonSchema>} props */
export function schema(props, optional = []) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      protocol_version: protocol,
      ...Object.fromEntries(Object.entries(props).map(([key, value]) => [key, { description: descriptions[key], ...value }]))
    },
    required: ["protocol_version", ...Object.keys(props).filter(key => !optional.includes(key))]
  };
}

export class DesktopError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function refuse(code, message) {
  throw new DesktopError(code, message);
}

export function check(schema, params) {
  if (!schema || validateSchema(schema, params).length > 0 ||
    Object.entries(params ?? {}).some(([key, value]) => {
      const constraint = schema.properties[key];
      return typeof value === "string" && (
        (constraint.pattern && !new RegExp(constraint.pattern).test(value)) ||
        (constraint.maxLength && value.length > constraint.maxLength) ||
        value.includes("\0"));
    })) {
    refuse("invalid_desktop_request", "Use protocol version 1 and only the documented fields and values.");
  }
}

export function success(result) {
  return { ok: true, protocol_version: VERSION, result };
}

export function failure(error) {
  const expected = error instanceof DesktopError;
  return {
    ok: false, protocol_version: VERSION,
    error: {
      code: expected ? error.code : "desktop_internal_error",
      message: expected ? error.message : "The reserved-screen service could not safely complete this request."
    }
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
