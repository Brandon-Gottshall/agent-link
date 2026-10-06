// src/server/registry.js
//
// The one list of tools (design doc section 3, R5.1). Each tool module exports
// entries of the form {definition, handler}; tools/list and tools/call are both
// derived from that list, so a tool cannot be listed without being callable or
// the reverse.
//
// tools/call goes through one wrapper:
//   1. unknown name            -> unknown_tool
//   2. lenient pass            -> optional nulls dropped; "5"/"true" read as 5/true (coerced_argument)
//   3. schema validation       -> invalid_arguments with details.errors (R3.12)
//   4. deprecated aliases      -> canonical argument + deprecated_argument warning (R3.6)
//   5. handler                 -> payload, or a thrown AgentLinkError
//   6. envelope               -> {ok:true, ...payload, warnings?} or {ok:false, error} (R3.1)
// and the MCP result carries the JSON in content[0].text and structuredContent,
// with isError exactly when ok is false (R3.2).

import { AgentLinkError, toErrorPayload } from "../shared/errors.js";
import { getLogger } from "../shared/log.js";
import { normalizeArguments, validateSchema } from "./validate.js";
import { ALIAS_REMOVAL_VERSION, envelopeOutput } from "./schemas.js";

/** @typedef {import("./validate.js").JsonSchema} JsonSchema */
/** @typedef {import("../shared/errors.js").ErrorPayload} ErrorPayload */

/**
 * @typedef {object} Warning
 * @property {string} code
 * @property {string} message
 * @property {string} [replacement]
 */

/**
 * A deprecated argument name kept for one minor version (R6.1).
 * @typedef {object} ArgumentAlias
 * @property {string} canonical     the argument name handlers read
 * @property {string[]} aliases     deprecated names accepted in its place
 * @property {boolean} [required]   the canonical value must be present after aliases are applied
 */

/**
 * @typedef {object} ToolAnnotations
 * @property {boolean} [readOnlyHint]
 * @property {boolean} [destructiveHint]
 * @property {boolean} [idempotentHint]
 * @property {boolean} [openWorldHint]
 */

/**
 * @typedef {object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {JsonSchema} inputSchema    canonical arguments only; alias properties are added by the registry
 * @property {Record<string, JsonSchema>} output   success payload keys (the envelope keys are added)
 * @property {ToolAnnotations} annotations
 * @property {ArgumentAlias[]} [aliases]
 */

/**
 * @typedef {object} ToolContext
 * @property {unknown} [callerContext]           runtime caller context from MCP _meta
 * @property {(warning: Warning) => void} warn    adds a warnings[] entry to the result
 */

/**
 * @typedef {(args: Record<string, any>, context: ToolContext) => Promise<Record<string, any>> | Record<string, any>} ToolHandler
 */

/**
 * @typedef {object} ToolEntry
 * @property {ToolDefinition} definition
 * @property {ToolHandler} handler
 */

/**
 * @typedef {object} McpTool
 * @property {string} name
 * @property {string} description
 * @property {JsonSchema} inputSchema
 * @property {JsonSchema} outputSchema
 * @property {ToolAnnotations} annotations
 */

/**
 * @typedef {object} McpCallResult
 * @property {boolean} isError
 * @property {{type: "text", text: string}[]} content
 * @property {Record<string, unknown>} structuredContent
 */

/**
 * @typedef {object} RegistryOptions
 * @property {(error: unknown) => string | null} [hintFor]   fallback hint for errors that carry none
 * @property {boolean} [strictOutput]   throw on undeclared output keys instead of dropping them (tests)
 * @property {import("../shared/log.js").Logger} [logger]
 */

/**
 * @param {string} alias
 * @param {string} canonical
 * @returns {Warning}
 */
export function deprecationWarning(alias, canonical) {
  return {
    code: "deprecated_argument",
    message: `${alias} is deprecated and will be removed in ${ALIAS_REMOVAL_VERSION}; use ${canonical}.`,
    replacement: canonical
  };
}

/**
 * The MCP tools/list entry for a definition: alias properties are added to
 * the input schema (marked deprecated), the output schema is the envelope,
 * and openWorldHint defaults to false (local machine only, section 3.6).
 * @param {ToolDefinition} definition
 * @returns {McpTool}
 */
export function toMcpTool(definition) {
  const input = /** @type {JsonSchema} */ (structuredClone(definition.inputSchema));
  input.properties ??= {};
  for (const alias of definition.aliases ?? []) {
    const canonicalSchema = input.properties[alias.canonical];
    if (!canonicalSchema) {
      throw new Error(`${definition.name}: alias target ${alias.canonical} is not an input property`);
    }
    for (const name of alias.aliases) {
      if (input.properties[name]) continue;
      const { description: _description, default: _default, ...rest } = canonicalSchema;
      input.properties[name] = {
        ...rest,
        description: `Deprecated alias of ${alias.canonical}; removed in ${ALIAS_REMOVAL_VERSION}.`,
        deprecated: true
      };
    }
  }
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: input,
    outputSchema: envelopeOutput(definition.output ?? {}),
    annotations: { openWorldHint: false, ...definition.annotations }
  };
}

/**
 * @param {ToolEntry[]} entries
 * @param {RegistryOptions} [options]
 */
export function createRegistry(entries, options = {}) {
  /** @type {Map<string, {entry: ToolEntry, tool: McpTool}>} */
  const byName = new Map();
  for (const entry of entries) {
    const name = entry.definition.name;
    if (byName.has(name)) throw new Error(`Duplicate tool definition: ${name}`);
    if (typeof entry.handler !== "function") throw new Error(`Tool ${name} has no handler`);
    byName.set(name, { entry, tool: toMcpTool(entry.definition) });
  }
  const logger = () => options.logger ?? getLogger();

  /** @returns {McpTool[]} */
  function listTools() {
    return [...byName.values()].map(({ tool }) => structuredClone(tool));
  }

  /**
   * Runs one tool and returns the section 3.1 envelope.
   * @param {string} name
   * @param {unknown} rawArgs
   * @param {{callerContext?: unknown}} [context]
   * @returns {Promise<Record<string, any>>}
   */
  async function invoke(name, rawArgs, context = {}) {
    /** @type {Warning[]} */
    const warnings = [];
    const found = byName.get(name);
    try {
      if (!found) {
        throw new AgentLinkError("unknown_tool", `No Agent Link tool is named ${JSON.stringify(String(name))}.`, {
          details: { name: String(name) },
          hint: "Call tools/list for the available tools."
        });
      }
      // null for an optional property means "not set"; exact-format scalar
      // strings are read as their type with a coerced_argument warning.
      const args = normalizeArguments(found.tool.inputSchema, rawArgs === undefined || rawArgs === null ? {} : rawArgs, warnings);
      const problems = validateSchema(found.tool.inputSchema, args);
      if (problems.length > 0) {
        throw new AgentLinkError("invalid_arguments", `Invalid arguments for ${name}: ${problems.map((p) => `${p.path} (${p.rule}: expected ${p.expected})`).join("; ")}.`, {
          details: { errors: problems }
        });
      }
      const resolved = applyAliases(found.entry.definition, /** @type {Record<string, any>} */ (args), warnings);
      const payload = await found.entry.handler(resolved, {
        callerContext: context.callerContext ?? null,
        warn: (warning) => warnings.push(warning)
      });
      return successEnvelope(payload, warnings);
    } catch (error) {
      return failureEnvelope(error, name);
    }
  }

  /**
   * Runs one tool and returns the MCP CallToolResult.
   * @param {string} name
   * @param {unknown} rawArgs
   * @param {{callerContext?: unknown}} [context]
   * @returns {Promise<McpCallResult>}
   */
  async function callTool(name, rawArgs, context = {}) {
    const envelope = await invoke(name, rawArgs, context);
    const found = byName.get(name);
    const structured = found ? declaredOnly(found.tool, envelope) : envelope;
    return {
      isError: envelope.ok === false,
      content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
      structuredContent: structured
    };
  }

  /**
   * structuredContent must satisfy the closed outputSchema, or MCP clients
   * that validate it reject the whole result. A key the schema does not
   * declare is a bug: it is logged and left out of structuredContent (the
   * text copy keeps it), or thrown when strictOutput is set.
   * @param {McpTool} tool
   * @param {Record<string, any>} envelope
   */
  function declaredOnly(tool, envelope) {
    const declared = tool.outputSchema.properties ?? {};
    const extra = Object.keys(envelope).filter((key) => !Object.prototype.hasOwnProperty.call(declared, key));
    if (extra.length === 0) return envelope;
    if (options.strictOutput) {
      throw new Error(`${tool.name} returned undeclared output keys: ${extra.join(", ")}`);
    }
    logger().error("tool.undeclared_output", { tool: tool.name, keys: extra.join(",") });
    return Object.fromEntries(Object.entries(envelope).filter(([key]) => !extra.includes(key)));
  }

  /**
   * @param {unknown} payload
   * @param {Warning[]} warnings
   */
  function successEnvelope(payload, warnings) {
    /** @type {Record<string, any>} */
    const body = payload && typeof payload === "object" && !Array.isArray(payload)
      ? { .../** @type {Record<string, any>} */ (payload) }
      : { result: payload };
    delete body.ok;
    const own = Array.isArray(body.warnings) ? body.warnings : [];
    delete body.warnings;
    const all = [...own, ...warnings];
    return { ok: true, ...body, ...(all.length > 0 ? { warnings: all } : {}) };
  }

  /**
   * @param {unknown} error
   * @param {string} name
   */
  function failureEnvelope(error, name) {
    const payload = toErrorPayload(error);
    if (!payload.hint && options.hintFor) {
      const hint = options.hintFor(error);
      if (hint) payload.hint = hint;
    }
    if (payload.code === "internal_error") {
      logger().error("tool.internal_error", {
        tool: String(name),
        error: error instanceof Error ? error : String(error)
      });
    }
    return { ok: false, error: payload };
  }

  return {
    listTools,
    callTool,
    invoke,
    /** @param {string} name */
    has: (name) => byName.has(name),
    names: () => [...byName.keys()]
  };
}

/**
 * Applies a definition's deprecated aliases (R3.6): the canonical name gets
 * the value, the alias is removed, and each alias used adds a warning. An
 * alias that disagrees with the canonical value (or another alias) is
 * invalid_arguments.
 * @param {ToolDefinition} definition
 * @param {Record<string, any>} args
 * @param {Warning[]} warnings
 * @returns {Record<string, any>}
 */
export function applyAliases(definition, args, warnings) {
  const out = { ...args };
  /** @type {import("./validate.js").SchemaProblem[]} */
  const problems = [];
  for (const { canonical, aliases, required } of definition.aliases ?? []) {
    let source = out[canonical] !== undefined ? canonical : null;
    for (const alias of aliases) {
      if (out[alias] === undefined) continue;
      warnings.push(deprecationWarning(alias, canonical));
      if (source === null) {
        out[canonical] = out[alias];
        source = alias;
      } else if (JSON.stringify(out[alias]) !== JSON.stringify(out[canonical])) {
        problems.push({ path: alias, rule: "alias_conflict", expected: `the same value as ${source}, or only ${canonical}` });
      }
      delete out[alias];
    }
    if (required && out[canonical] === undefined) {
      problems.push({ path: canonical, rule: "required", expected: `${canonical} (or its deprecated alias ${aliases.join(", ")})` });
    }
  }
  if (problems.length > 0) {
    throw new AgentLinkError("invalid_arguments", `Invalid arguments for ${definition.name}: ${problems.map((p) => `${p.path} (${p.rule})`).join("; ")}.`, {
      details: { errors: problems }
    });
  }
  return out;
}
