import type { Json, JsonSchema } from "./types.js";

// Direct mode stays deliberately narrow. This is the complete subset it
// understands; anything else is unsupported and must delegate to the main
// model (forced/hint), never synthesize a direct call and never reject the
// client request.
//
// Supported top-level: { type: "object", properties, required,
// additionalProperties?: false|true, description?, $schema? }.
// Supported property: boolean, const, or string/number/integer enum with
// non-object values and collision-free labels. Any $ref, composition
// (allOf/anyOf/oneOf/not/if/then/else), patternProperties,
// dependentSchemas, or numeric/string constraints beyond the closed set
// makes the schema unsupported for direct mode.

const UNSUPPORTED_TOP = [
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "patternProperties",
  "propertyNames",
] as const;

const UNSUPPORTED_PROP = [
  "$ref",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "properties",
  "items",
  "prefixItems",
  "additionalProperties",
  "patternProperties",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "formatMinimum",
  "formatMaximum",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: Json | unknown, b: Json | unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

function checkType(value: Json, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      return false;
  }
}

/** Whether this schema is eligible for direct-mode planning at all. */
export function isDirectEligibleSchema(schema: JsonSchema | undefined): boolean {
  if (!isObject(schema)) return false;
  if (schema.type !== "object") return false;
  for (const k of UNSUPPORTED_TOP) if (k in schema) return false;
  if (schema.properties !== undefined && !isObject(schema.properties)) return false;
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === "string")) return false;
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    // Object-valued additionalProperties carries constraints planner ignores.
    return false;
  }
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  for (const [, prop] of Object.entries(props)) {
    if (!isObject(prop)) return false;
    for (const k of UNSUPPORTED_PROP) if (k in prop) return false;
  }
  return true;
}

/**
 * Validate synthesized direct args against the complete schema.
 * Returns ok:false for missing/malformed/unsupported schemas (caller must
 * delegate via forced/hint, never direct, never reject).
 * Never coerces, injects defaults, fetches remote refs, or drops constraints.
 */
export function validateDirectArgs(
  schema: JsonSchema | undefined,
  args: Record<string, Json>,
): { ok: true } | { ok: false; reason: string } {
  if (!isObject(schema)) return { ok: false, reason: "missing_schema" };
  if (schema.type !== "object") return { ok: false, reason: "non_object_schema" };
  for (const k of UNSUPPORTED_TOP) if (k in schema) return { ok: false, reason: `unsupported:${k}` };
  if (schema.properties !== undefined && !isObject(schema.properties)) return { ok: false, reason: "malformed_properties" };
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === "string"))
      return { ok: false, reason: "malformed_required" };
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean")
    return { ok: false, reason: "unsupported_additionalProperties" };

  const props = ((schema.properties ?? {}) as Record<string, JsonSchema>);
  const required = new Set<string>(Array.isArray(schema.required) ? (schema.required as string[]) : []);

  for (const name of required) {
    if (!(name in args)) return { ok: false, reason: `missing_required:${name}` };
    if (!(name in props)) return { ok: false, reason: `required_not_in_properties:${name}` };
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(args)) {
      if (!(name in props)) return { ok: false, reason: `additional_property:${name}` };
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const prop = props[name];
    if (!prop || !isObject(prop)) {
      if (schema.additionalProperties === false) return { ok: false, reason: `additional_property:${name}` };
      continue;
    }
    for (const k of UNSUPPORTED_PROP) if (k in prop) return { ok: false, reason: `unsupported_prop:${name}:${k}` };
    if ("const" in prop) {
      if (!deepEqual(value, prop.const as Json)) return { ok: false, reason: `const_mismatch:${name}` };
    }
    if (Array.isArray((prop as any).enum)) {
      const en = (prop as any).enum as unknown[];
      if (!en.some((v) => deepEqual(value, v as Json))) return { ok: false, reason: `enum_mismatch:${name}` };
    }
    const t = (prop as any).type;
    if (typeof t === "string") {
      if (!checkType(value, t)) return { ok: false, reason: `type_mismatch:${name}` };
    } else if (Array.isArray(t)) {
      // Union types are unsupported for direct synthesis: refuse rather than guess.
      return { ok: false, reason: `unsupported_union_type:${name}` };
    }
  }
  return { ok: true };
}
