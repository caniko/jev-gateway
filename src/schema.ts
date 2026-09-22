import type { Json, JsonSchema } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isJson(value: unknown, depth = 0): value is Json {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJson(item, depth + 1));
}

const TYPES = new Set(["null", "boolean", "string", "number", "integer", "array", "object"]);

/** JSON Schema compares object values without key order and treats negative zero as zero. */
function valueKey(value: Json): string {
  return JSON.stringify(value, (_key, item: unknown) => isRecord(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
}

function validType(type: unknown): boolean {
  return type === undefined || (typeof type === "string" && TYPES.has(type))
    || (Array.isArray(type) && type.length > 0 && new Set(type).size === type.length
      && type.every((item) => typeof item === "string" && TYPES.has(item)));
}

export function matchesType(value: Json, type: JsonSchema["type"]): boolean {
  if (type === undefined) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((item) => item === "null" ? value === null
    : item === "integer" ? typeof value === "number" && Number.isInteger(value)
    : item === "array" ? Array.isArray(value)
    : item === "object" ? isRecord(value)
    : typeof value === item);
}

/** Only known annotations are ignored; unimplemented validation keywords must delegate. */
export function supportedSchema(value: unknown, keys: string[]): value is JsonSchema {
  if (!isRecord(value) || !validType(value.type)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (["title", "description", "$comment"].includes(key)) return typeof item === "string";
    if (["deprecated", "readOnly", "writeOnly"].includes(key)) return typeof item === "boolean";
    if (key === "default") return isJson(item);
    if (key === "examples") return Array.isArray(item) && item.every((example) => isJson(example));
    return keys.includes(key);
  });
}

/** Validate every value the closed-set planner can synthesize, before asking Jev. */
export function closedValues(schema: JsonSchema): boolean {
  let values: Set<string> | undefined;
  if (Object.hasOwn(schema, "enum")) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || !schema.enum.every((item) => isJson(item))) return false;
    values = new Set(schema.enum.map(valueKey));
    if (values.size !== schema.enum.length) return false;
  }
  if (Object.hasOwn(schema, "const")) {
    return isJson(schema.const) && matchesType(schema.const, schema.type)
      && (!values || values.has(valueKey(schema.const)));
  }
  return !schema.enum || schema.enum.every((item) => matchesType(item, schema.type));
}
