import { AgentLinkError } from "../shared/errors.js";
import { DesktopError, methods, VERSION } from "./protocol.js";

// Read only the host-generated protocol metadata outside model tool args.
// An independently verified, dedicated stdio connection can be enrolled
// without metadata. Unknown or multiplexed connections fail without it.
export function runtimeDesktopSession(request) {
  const meta = request?.params?._meta;
  const fields = [meta?.callerThreadId, meta?.["openai/codex"]?.callerThreadId, meta?.["claudecode/sessionId"]];
  const supplied = fields.filter(value => value !== undefined);
  if (!supplied.length) return null;
  const [value] = supplied;
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) &&
    supplied.every(field => field === value) ? value : "";
}

/** @returns {import("../server/registry.js").ToolEntry[]} */
export function desktopEntries(client) {
  return Object.entries(methods).map(([method, spec]) => ({
    definition: {
      name: "desktop_" + method,
      description: spec.description,
      inputSchema: spec.schema,
      protocolVersion: VERSION,
      output: {
        protocol_version: { type: "integer", enum: [VERSION], description: "Reserved-screen protocol version." },
        result: { type: "object", description: "Scoped reserved-screen result." }
      },
      annotations: { readOnlyHint: "readOnly" in spec && spec.readOnly === true, destructiveHint: method === "act", idempotentHint: !["act", "observe", "verify"].includes(method) }
    },
    async handler(params, context) {
      try {
        return { protocol_version: VERSION, result: await client.call(method, params, context.desktopSession ?? null) };
      } catch (error) {
        if (error instanceof DesktopError) throw new AgentLinkError("unsupported", error.message, { details: { desktop_code: error.code } });
        throw error;
      }
    }
  }));
}
