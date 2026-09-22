import type { Questions } from "@typesafe-ai/sdk";
import { truncate } from "./state.js";
import type { Json, JsonSchema, RouterTool } from "./types.js";

/** Choice label meaning "reply in text, call nothing". */
export const NO_TOOL = "no_tool_needed";
/** Choice label a shard uses to say "the right tool is not in this group". */
export const NONE_OF_THESE = "none_of_these";
/**
 * Most tools one tool question may offer. A Choice accepts 255 options, but state plus the longest
 * question must also fit Jev's 32k-token window, and below ~400 characters a description stops
 * telling similar tools apart — so big rosters (Claude Code sends ~280) are shortlisted first.
 */
export const MAX_TOOLS = 120;
export const SHORTLIST_PER_SHARD = 3;
/** Cap on speculative argument questions fanned out in the same Jev call. */
const MAX_ARG_QUESTIONS = 96;
const MAX_DESCRIPTION_CHARS = 1024;
/** Characters one tool question may spend on descriptions (~12k tokens). */
const QUESTION_CHAR_BUDGET = 48_000;

export const TOOL_KEY = "tool";
export const NEEDS_TOOL_KEY = "needs_tool";

/** A parameter whose value comes from a fixed set, so Jev can fill it. */
export type ClosedParam =
  | { name: string; required: boolean; kind: "const"; value: Json }
  | { name: string; required: boolean; kind: "boolean"; description?: string }
  | { name: string; required: boolean; kind: "enum"; description?: string; values: Map<string, Json> };

export interface ToolPlan {
  name: string;
  /** Present only when every parameter is closed-set: Jev can then produce the whole call. */
  closedParams?: ClosedParam[];
}

/** Own-property plain object: a schema built with `Object.create` must not inherit assertions. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

const TYPES = new Set(["null", "boolean", "string", "number", "integer", "array", "object"]);

function validType(type: unknown): boolean {
  return type === undefined || (typeof type === "string" && TYPES.has(type))
    || (Array.isArray(type) && type.length > 0 && new Set(type).size === type.length
      && type.every((item) => typeof item === "string" && TYPES.has(item)));
}

function matchesType(value: Json, type: JsonSchema["type"]): boolean {
  if (type === undefined) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((item) => item === "null" ? value === null
    : item === "integer" ? typeof value === "number" && Number.isInteger(value)
    : item === "array" ? Array.isArray(value)
    : item === "object" ? isRecord(value)
    : typeof value === item);
}

/**
 * Whether a schema stays inside the subset this gateway implements — checked at plan time, before
 * Jev is asked anything. One that does not hands the whole call to the LLM with the schema
 * forwarded byte for byte, so no keyword is ever enforced by code that ignores it: `$ref`,
 * composition, `format`, `nullable`, numeric bounds, and boolean schemas all fail here.
 * `keys` are the assertions the caller implements; everything not listed below is unimplemented.
 */
function supportedSchema(value: unknown, keys: string[]): value is JsonSchema {
  if (!isRecord(value) || !validType(value.type)) return false;
  return Object.entries(value).every(([key, item]) => {
    // Annotations assert nothing, so only the one that is read back (`description`) has to have
    // the type its reader expects. `$schema` and `$id` belong here too: OpenCode stamps the first
    // on every native tool and the TypeScript SDK on every MCP server, and neither constrains a
    // value — a tool carrying them is as answerable as one that does not.
    if (["title", "description", "$comment", "$schema", "$id"].includes(key)) return typeof item === "string";
    if (["deprecated", "readOnly", "writeOnly"].includes(key)) return typeof item === "boolean";
    if (key === "default") return true; // never applied, so its own value is never read
    if (key === "examples") return Array.isArray(item);
    return keys.includes(key);
  });
}

/** JSON Schema compares object values without key order and treats negative zero as zero. */
function valueKey(value: Json): string {
  return JSON.stringify(value, (_key, item: unknown) => isRecord(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
}

/**
 * One parameter Jev can fill without help: a fixed set small enough to offer as choices, and a
 * schema this gateway fully implements. Anything it cannot stand behind returns `undefined` and
 * keeps that argument — the whole call — with the LLM, schema untouched.
 */
function closedParam(name: string, schema: JsonSchema, required: boolean): ClosedParam | undefined {
  if (!supportedSchema(schema, ["type", "const", "enum"])) return undefined;
  const hasConst = Object.hasOwn(schema, "const");
  if (hasConst && !matchesType(schema.const as Json, schema.type)) return undefined;

  if (Object.hasOwn(schema, "enum")) {
    const list = schema.enum as Json[];
    // The cap comes first: a Choice accepts 255 options, so a longer enum is refused on its
    // length alone, before anything walks it.
    if (!Array.isArray(list) || list.length === 0 || list.length > 255) return undefined;
    // One pass builds the labels Jev sees. Colliding labels ("1" vs 1, or two objects, which all
    // label as "[object Object]") cannot be mapped back to their values — that collision check is
    // also the duplicate check — and every member must match the declared type.
    const values = new Map<string, Json>();
    for (const value of list) {
      if (!matchesType(value, schema.type)) return undefined;
      if (isRecord(value) && !hasConst) return undefined;
      values.set(String(value), value);
    }
    if (values.size !== list.length) return undefined;
    if (hasConst) {
      const constant = schema.const as Json;
      // Scalars compare through their label; only objects need key-order-insensitive equality.
      const inEnum = isRecord(constant)
        ? list.some((member) => valueKey(member) === valueKey(constant))
        : values.get(String(constant)) === constant;
      return inEnum ? { name, required, kind: "const", value: constant } : undefined;
    }
    if (list.length === 1) return { name, required, kind: "const", value: list[0]! };
    return { name, required, kind: "enum", description: schema.description, values };
  }
  if (hasConst) return { name, required, kind: "const", value: schema.const as Json };
  if (schema.type === "boolean" || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === "boolean")) {
    return { name, required, kind: "boolean", description: schema.description };
  }
  return undefined;
}

export function planTool(tool: RouterTool): ToolPlan {
  const schema = tool.parameters;
  // Only function tools take JSON arguments, and without a recognizable object schema
  // there is nothing safe to infer about them.
  if (tool.kind !== "function") return { name: tool.name };
  if (!supportedSchema(schema, ["type", "properties", "required", "additionalProperties"]) || !matchesType({}, schema.type)) return { name: tool.name };
  if (Object.hasOwn(schema, "properties") && !isRecord(schema.properties)) return { name: tool.name };
  if (Object.hasOwn(schema, "required") && (!Array.isArray(schema.required) || !schema.required.every((name) => typeof name === "string")
    || new Set(schema.required).size !== schema.required.length)) return { name: tool.name };
  if (Object.hasOwn(schema, "additionalProperties") && typeof schema.additionalProperties !== "boolean") return { name: tool.name };
  const required = new Set(schema.required ?? []);
  if ([...required].some((name) => !Object.hasOwn(schema.properties ?? {}, name))) return { name: tool.name };
  const closedParams: ClosedParam[] = [];
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    const param = closedParam(name, property, required.has(name));
    if (!param) return { name: tool.name };
    closedParams.push(param);
  }
  return { name: tool.name, closedParams };
}

export const argKey = (toolIndex: number, param: string) => `arg:${toolIndex}:${param}`;
export const statedKey = (toolIndex: number, param: string) => `stated:${toolIndex}:${param}`;

function toolCriteria(tools: RouterTool[]): Record<string, string | null> {
  const limit = Math.min(MAX_DESCRIPTION_CHARS, Math.floor(QUESTION_CHAR_BUDGET / tools.length));
  const criteria: Record<string, string | null> = {};
  for (const tool of tools) {
    const params = Object.keys(tool.parameters?.properties ?? {});
    // Descriptions lead with what the tool is for; the tail is usage detail Jev doesn't need.
    const description = tool.description?.trim().slice(0, limit);
    criteria[tool.name] = description || (params.length ? `Parameters: ${params.join(", ")}` : null);
  }
  return criteria;
}

export const shardKey = (index: number) => `shard:${index}`;

/**
 * First pass over a roster too big for one question: every shard is ranked in the same Jev call,
 * and the best few of each go on to the real decision — ranking wide, then judging a shortlist.
 */
export function buildShortlistQuestions(tools: RouterTool[]): { questions: Questions; shards: RouterTool[][] } {
  const shardCount = Math.ceil(tools.length / MAX_TOOLS);
  const size = Math.ceil(tools.length / shardCount);
  const shards = Array.from({ length: shardCount }, (_, index) => tools.slice(index * size, (index + 1) * size));
  const questions: Questions = {};
  shards.forEach((shard, index) => {
    questions[shardKey(index)] = {
      type: "choice",
      instructions:
        "Given the conversation, which of these tools would best advance the user's latest request " +
        "if the assistant called it next?",
      criteria: { ...toolCriteria(shard), [NONE_OF_THESE]: "None of the tools in this list fits the next step." },
    };
  });
  return { questions, shards };
}

/**
 * One Jev request decides everything: which tool (if any), whether a tool is needed at all,
 * and — speculatively, for every tool Jev could fully answer — each closed-set argument.
 * Extra questions barely change latency, so code picks the relevant answers afterwards.
 */
export function buildQuestions(
  tools: RouterTool[],
  options: { allowNone: boolean; withArgs: boolean },
): { questions: Questions; plans: ToolPlan[] } {
  const plans = tools.map(planTool);
  const criteria = toolCriteria(tools);
  if (options.allowNone) {
    criteria[NO_TOOL] =
      "No tool call is needed right now: the assistant should reply to the user in plain text " +
      "(answer directly, ask a clarifying question, or report results that tools already returned).";
  }

  const questions: Questions = {
    [TOOL_KEY]: {
      type: "choice",
      instructions:
        "Given the conversation, what should the assistant do next? " +
        "Pick the single tool whose call best advances the user's latest request.",
      criteria,
    },
    [NEEDS_TOOL_KEY]: {
      type: "noul",
      instructions:
        "Does the assistant need to call one of its tools now, rather than reply to the user in plain text?",
    },
  };
  if (!options.withArgs) return { questions, plans };

  let argQuestions = 0;
  plans.forEach((plan, toolIndex) => {
    const asked = plan.closedParams?.filter((param) => param.kind !== "const") ?? [];
    const cost = asked.reduce((sum, param) => sum + (param.required ? 1 : 2), 0);
    if (!plan.closedParams || argQuestions + cost > MAX_ARG_QUESTIONS) {
      delete plan.closedParams;
      return;
    }
    argQuestions += cost;
    for (const param of asked) {
      const about = `the "${param.name}" argument of the tool "${plan.name}"${
        param.description ? ` (${truncate(param.description, MAX_DESCRIPTION_CHARS)})` : ""
      }`;
      questions[argKey(toolIndex, param.name)] =
        param.kind === "boolean"
          ? { type: "noul", instructions: `If the assistant calls "${plan.name}" now, should ${about} be true?` }
          : {
              type: "choice",
              instructions: `If the assistant calls "${plan.name}" now, what value should ${about} have?`,
              criteria: Object.fromEntries([...param.values.keys()].map((label) => [label, null])),
            };
      if (!param.required) {
        questions[statedKey(toolIndex, param.name)] = {
          type: "noul",
          instructions: `Does the conversation state or clearly imply a value for ${about}?`,
        };
      }
    }
  });
  return { questions, plans };
}
