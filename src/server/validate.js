// src/server/validate.js
//
// The JSON Schema subset Agent Link's tool schemas use (design doc R3.11,
// R3.12): type (including integer and type lists), enum, required,
// properties, additionalProperties (false, true, or a schema), items, oneOf,
// anyOf, minimum, maximum, minLength, minItems, maxItems. Values are checked,
// never coerced or clamped: an out-of-range number is an error.

/**
 * @typedef {object} JsonSchema
 * @property {string | string[]} [type]
 * @property {unknown[]} [enum]
 * @property {string[]} [required]
 * @property {Record<string, JsonSchema>} [properties]
 * @property {boolean | JsonSchema} [additionalProperties]
 * @property {JsonSchema} [items]
 * @property {JsonSchema[]} [oneOf]
 * @property {JsonSchema[]} [anyOf]
 * @property {number} [minimum]
 * @property {number} [maximum]
 * @property {number} [minLength]
 * @property {number} [minItems]
 * @property {number} [maxItems]
 * @property {string} [description]
 * @property {unknown} [default]
 * @property {boolean} [deprecated]
 */

/**
 * @typedef {object} SchemaProblem
 * @property {string} path      dotted argument path, e.g. "receipt.tags[0]"
 * @property {string} rule      the failed keyword ("type", "range", "additionalProperties", ...)
 * @property {string} expected  what would have been accepted
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/**
 * @param {string} actual  result of typeOf
 * @param {string} wanted  a JSON Schema type name
 */
function typeMatches(actual, wanted) {
  if (wanted === actual) return true;
  return wanted === "number" && actual === "integer";
}

/**
 * @param {string} base
 * @param {string} key
 */
function join(base, key) {
  return base ? `${base}.${key}` : key;
}

/**
 * Validates `value` against `schema` and returns every problem found (empty
 * when valid). Unknown keywords are ignored.
 * @param {JsonSchema} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {SchemaProblem[]}
 */
export function validateSchema(schema, value, path = "") {
  /** @type {SchemaProblem[]} */
  const problems = [];
  if (!schema || typeof schema !== "object") return problems;
  const where = path || "(arguments)";

  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const options = /** @type {JsonSchema[]} */ (schema.oneOf ?? schema.anyOf);
    const matches = options.filter((option) => validateSchema(option, value, path).length === 0).length;
    const ok = schema.oneOf ? matches === 1 : matches >= 1;
    if (!ok) {
      problems.push({ path: where, rule: schema.oneOf ? "oneOf" : "anyOf", expected: options.map(describe).join(" or ") });
      return problems;
    }
  }

  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!wanted.some((type) => typeMatches(actual, type))) {
      problems.push({ path: where, rule: "type", expected: wanted.join(" or ") });
      return problems;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => Object.is(option, value))) {
    problems.push({ path: where, rule: "enum", expected: `one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}` });
    return problems;
  }

  if (typeof value === "number") {
    const min = schema.minimum;
    const max = schema.maximum;
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      problems.push({ path: where, rule: "range", expected: rangeText(schema) });
    }
  }

  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    problems.push({ path: where, rule: "minLength", expected: `at least ${schema.minLength} character(s)` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push({ path: where, rule: "minItems", expected: `at least ${schema.minItems} item(s)` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      problems.push({ path: where, rule: "maxItems", expected: `at most ${schema.maxItems} item(s)` });
    }
    if (schema.items) {
      value.forEach((item, index) => {
        problems.push(...validateSchema(/** @type {JsonSchema} */ (schema.items), item, `${path || ""}[${index}]`));
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = /** @type {Record<string, unknown>} */ (value);
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) {
        problems.push({ path: join(path, key), rule: "required", expected: describe(properties[key]) });
      }
    }
    for (const [key, item] of Object.entries(record)) {
      if (item === undefined) continue;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        problems.push(...validateSchema(properties[key], item, join(path, key)));
      } else if (schema.additionalProperties === false) {
        problems.push({ path: join(path, key), rule: "additionalProperties", expected: "no such property" });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        problems.push(...validateSchema(schema.additionalProperties, item, join(path, key)));
      }
    }
  }

  return problems;
}

/**
 * @param {JsonSchema} schema
 * @returns {string}
 */
function rangeText(schema) {
  const kind = schema.type === "integer" ? "integer" : "number";
  if (schema.minimum !== undefined && schema.maximum !== undefined) return `${kind} ${schema.minimum}..${schema.maximum}`;
  if (schema.minimum !== undefined) return `${kind} >= ${schema.minimum}`;
  return `${kind} <= ${schema.maximum}`;
}

/**
 * Short human description of what a schema accepts, for error messages.
 * @param {JsonSchema | undefined} schema
 * @returns {string}
 */
export function describe(schema) {
  if (!schema) return "a value";
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`;
  if (schema.minimum !== undefined || schema.maximum !== undefined) return rangeText(schema);
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map(describe).join(" or ");
  if (Array.isArray(schema.type)) return schema.type.join(" or ");
  if (schema.type === "array" && schema.items) return `array of ${describe(schema.items)}`;
  return schema.type ?? "a value";
}
