import type { Json, JsonSchema } from "./types.js";

// Direct mode stays deliberately narrow. This file defines the COMPLETE
// subset it understands as explicit allowlists; any other validation
// keyword is unsupported and must delegate to the main model
// (forced/hint), never synthesize a direct call and never reject the
// client request.
//
// Supported top-level keys: type, properties, required,
// additionalProperties, description, $schema, title.
// Supported property keys: type, description, const, enum.
// All ownership checks use hasOwn (never `in`) so prototype-inherited
// names like "toString" cannot satisfy required/properties.

const ALLOWED_TOP = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "description",
  "$schema",
  "title",
]);

const ALLOWED_PROP = new Set(["type", "description", "const", "enum"]);

const KNOWN_TYPES = new Set(["string", "number", "integer", "boolean", "null", "array", "object"]);

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

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
    return ka.every((k) => hasOwn(b, k) && deepEqual((a as any)[k], (b as any)[k]));
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

/** Annotation keys are allowed but must be well-formed strings when present. */
function annotationsOk(schema: Record<string, unknown>): boolean {
  for (const k of ["description", "title", "$schema"] as const) {
    if (hasOwn(schema, k) && typeof (schema as any)[k] !== "string") return false;
  }
  return true;
}

/** Whether this schema is eligible for direct-mode planning at all. */
export function isDirectEligibleSchema(schema: JsonSchema | undefined): boolean {
  if (!isObject(schema)) return false;
  for (const k of Object.keys(schema)) if (!ALLOWED_TOP.has(k)) return false;
  if (!annotationsOk(schema)) return false;
  if (!hasOwn(schema, "type") || (schema as any).type !== "object") return false;
  if (hasOwn(schema, "properties") && !isObject((schema as any).properties)) return false;
  if (hasOwn(schema, "required")) {
    const req = (schema as any).required;
    if (!Array.isArray(req) || !req.every((r: unknown) => typeof r === "string")) return false;
  }
  if (hasOwn(schema, "additionalProperties") && typeof (schema as any).additionalProperties !== "boolean") return false;
  const props = (hasOwn(schema, "properties") ? (schema as any).properties : {}) as Record<string, unknown>;
  for (const prop of Object.values(props)) {
    if (!isObject(prop)) return false;
    for (const k of Object.keys(prop)) if (!ALLOWED_PROP.has(k)) return false;
    if (hasOwn(prop, "description") && typeof (prop as any).description !== "string") return false;
    if (hasOwn(prop, "type")) {
      const t = (prop as any).type;
      if (typeof t !== "string" || !KNOWN_TYPES.has(t)) return false;
    }
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
  for (const k of Object.keys(schema)) {
    if (!ALLOWED_TOP.has(k)) return { ok: false, reason: `unsupported:${k}` };
  }
  if (!annotationsOk(schema)) return { ok: false, reason: "malformed_annotation" };
  if (!hasOwn(schema, "type") || (schema as any).type !== "object") return { ok: false, reason: "non_object_schema" };
  if (hasOwn(schema, "properties") && !isObject((schema as any).properties))
    return { ok: false, reason: "malformed_properties" };
  if (hasOwn(schema, "required")) {
    const req = (schema as any).required;
    if (!Array.isArray(req) || !req.every((r: unknown) => typeof r === "string"))
      return { ok: false, reason: "malformed_required" };
  }
  if (hasOwn(schema, "additionalProperties") && typeof (schema as any).additionalProperties !== "boolean")
    return { ok: false, reason: "unsupported_additionalProperties" };

  const props = ((hasOwn(schema, "properties") ? (schema as any).properties : {}) as Record<string, JsonSchema>);
  const required: string[] = hasOwn(schema, "required") ? ((schema as any).required as string[]) : [];

  for (const name of required) {
    if (!hasOwn(args, name)) return { ok: false, reason: `missing_required:${name}` };
    if (!hasOwn(props, name)) return { ok: false, reason: `required_not_in_properties:${name}` };
  }
  if ((schema as any).additionalProperties === false) {
    for (const name of Object.keys(args)) {
      if (!hasOwn(props, name)) return { ok: false, reason: `additional_property:${name}` };
    }
  }
  for (const [name, value] of Object.entries(args)) {
    if (!hasOwn(props, name)) {
      if ((schema as any).additionalProperties === false) return { ok: false, reason: `additional_property:${name}` };
      continue;
    }
    const prop = props[name] as unknown;
    if (!isObject(prop)) return { ok: false, reason: `malformed_property:${name}` };
    for (const k of Object.keys(prop)) {
      if (!ALLOWED_PROP.has(k)) return { ok: false, reason: `unsupported_prop:${name}:${k}` };
    }
    if (hasOwn(prop, "description") && typeof (prop as any).description !== "string")
      return { ok: false, reason: `malformed_annotation:${name}` };
    if (hasOwn(prop, "const")) {
      if (!deepEqual(value, (prop as any).const as Json)) return { ok: false, reason: `const_mismatch:${name}` };
    }
    if (hasOwn(prop, "enum")) {
      const en = (prop as any).enum;
      if (!Array.isArray(en)) return { ok: false, reason: `malformed_enum:${name}` };
      if (!en.some((v) => deepEqual(value, v as Json))) return { ok: false, reason: `enum_mismatch:${name}` };
    }
    if (hasOwn(prop, "type")) {
      const t = (prop as any).type;
      if (typeof t !== "string" || !KNOWN_TYPES.has(t)) return { ok: false, reason: `unsupported_type:${name}` };
      if (!checkType(value, t)) return { ok: false, reason: `type_mismatch:${name}` };
    }
  }
  return { ok: true };
}
