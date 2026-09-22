import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { planTool } from "../src/questions.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

async function route(parameters: unknown, extraAnswers = {}, omit = false) {
  const jev = fakeJev({ tool: { choice: "status" }, needs_tool: { noul: 0.99 }, ...extraAnswers });
  const upstream = fakeUpstream();
  const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
  const body = { model: "m", messages: [{ role: "user", content: "status" }],
    tools: [{ type: "function", function: { name: "status", ...(omit ? {} : { parameters }) } }] };
  const response = await app.request("/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { mode: response.headers.get("x-jev-gateway-mode"), json: await response.json() as any, upstream, jev };
}

/** The same tool through `/v1/responses`, whose API accepts `parameters: null`. */
async function routeResponses(parameters: unknown) {
  const jev = fakeJev({ tool: { choice: "status" }, needs_tool: { noul: 0.99 } });
  const upstream = fakeUpstream();
  const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
  const body = { model: "m", input: [{ role: "user", content: "status" }],
    tools: [{ type: "function", name: "status", parameters }], stream: false };
  const response = await app.request("/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { mode: response.headers.get("x-jev-gateway-mode"), json: await response.json() as any, upstream };
}

describe("closed argument schemas", () => {
  it("uses JSON equality for constant/enum intersections, including negative zero and object key order", () => {
    for (const [constant, value] of [[-0, 0], [{ a: -0, b: 1 }, { b: 1, a: 0 }]] as const) {
      expect(planTool({ kind: "function", name: "status", parameters: {
        properties: { value: { const: constant, enum: [value] } }, required: ["value"],
      } }).closedParams).toHaveLength(1);
    }
    expect(planTool({ kind: "function", name: "status", parameters: {
      properties: { value: { const: 0, enum: [0, -0] } },
    } }).closedParams).toBeUndefined();
  });

  it("validates a large constant enum without walking it", () => {
    const values = Array.from({ length: 100_000 }, (_, index) => index);
    expect(planTool({ kind: "function", name: "status", parameters: {
      type: "object", properties: { value: { const: 99_999, enum: values } }, required: ["value"],
    } }).closedParams).toBeUndefined();
    expect(planTool({ kind: "function", name: "status", parameters: {
      type: "object", properties: { value: { enum: values.slice(0, 255) } }, required: ["value"],
    } }).closedParams).toHaveLength(1);
  });

  it.each([
    { title: "Status", type: "object", properties: { value: { title: "Value", type: "string", enum: ["ok"], examples: ["ok"] } }, required: ["value"] },
    { properties: { value: { type: ["string", "null"], enum: [null] } }, required: ["value"], additionalProperties: false },
    { type: "object", properties: { value: { const: 1, type: ["integer", "null"], enum: [1, null] } }, required: ["value"] },
    { properties: { value: { const: { nested: [1, true] }, type: "object" } }, required: ["value"] },
  ])("answers directly when closed values satisfy the declared schema: %j", async (schema) => {
    const result = await route(schema);
    expect(result.mode).toBe("direct");
    expect(result.upstream.calls).toHaveLength(0);
    expect(Object.keys(JSON.parse(result.json.choices[0].message.tool_calls[0].function.arguments))).toEqual(["value"]);
  });

  it("answers directly when the schema carries the annotations every generator stamps on it", async () => {
    // Captured from OpenCode's native tools (test/opencode.test.ts): the draft 2020-12 `$schema`
    // there, the draft-07 one TypeScript SDK MCP servers send, and `$id`, constrain nothing.
    const answers = { "arg:0:room": { choice: "kitchen" }, "arg:0:on": { noul: 0.99 } };
    const closed = { type: "object",
      properties: { room: { type: "string", enum: ["kitchen", "office"] }, on: { type: "boolean" } },
      required: ["room", "on"], additionalProperties: false };
    for (const schema of [
      { $schema: "https://json-schema.org/draft/2020-12/schema", ...closed },
      { $schema: "http://json-schema.org/draft-07/schema#", ...closed },
      { $id: "https://example.test/status#", ...closed },
    ]) {
      const result = await route(schema, answers);
      expect(result.mode).toBe("direct");
      expect(result.upstream.calls).toHaveLength(0);
      expect(JSON.parse(result.json.choices[0].message.tool_calls[0].function.arguments))
        .toEqual({ room: "kitchen", on: true });
    }
  });

  it("answers an empty tool with no arguments, $schema or not", async () => {
    for (const parameters of [
      { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {}, required: [] },
      { $schema: "https://json-schema.org/draft/2020-12/schema" },
      {},
    ]) {
      const result = await route(parameters);
      expect(result.mode).toBe("direct");
      expect(JSON.parse(result.json.choices[0].message.tool_calls[0].function.arguments)).toEqual({});
    }
  });

  it("treats Responses `parameters: null` as an omitted key, at the adapter boundary", async () => {
    const result = await routeResponses(null);
    expect(result.mode).toBe("direct");
    expect(result.upstream.calls).toHaveLength(0);
    expect(JSON.parse(result.json.output[0].arguments)).toEqual({});
    // The planner itself never sees the wire shape: only the Responses adapter normalizes it.
    expect(planTool({ kind: "function", name: "status", parameters: null as never }).closedParams).toBeUndefined();
  });

  it("leaves optional arguments absent without injecting defaults", async () => {
    const result = await route({ properties: { on: { type: "boolean", default: true } } },
      { "arg:0:on": { noul: 0.9 }, "stated:0:on": { noul: 0.01 } });
    expect(result.mode).toBe("direct");
    expect(JSON.parse(result.json.choices[0].message.tool_calls[0].function.arguments)).toEqual({});
  });

  it("uses nullable enum answers without coercion", async () => {
    const result = await route({ properties: { room: { type: ["string", "null"], enum: ["k", null] } }, required: ["room"] },
      { "arg:0:room": { choice: "null" } });
    expect(result.mode).toBe("direct");
    expect(JSON.parse(result.json.choices[0].message.tool_calls[0].function.arguments)).toEqual({ room: null });
  });

  it("treats omitted OpenAI parameters as a no-argument function", async () => {
    const result = await route(undefined, {}, true);
    expect(result.mode).toBe("direct");
    expect(JSON.parse(result.json.choices[0].message.tool_calls[0].function.arguments)).toEqual({});
    expect(planTool({ kind: "function", name: "status" }).closedParams).toBeUndefined();
  });

  it.each([
    false, null, [], { type: "array" }, { properties: null }, { properties: "bad" }, { required: 5 },
    { required: ["absent"], properties: {} }, { required: ["toString"], properties: {} },
    { $ref: "https://example.invalid/schema" }, { allOf: [{}] }, { unknownConstraint: true },
    { properties: { value: { const: "a", enum: ["b"] } } },
    { properties: { value: { const: 1, type: "string" } } },
    { properties: { value: { enum: ["a"], type: "number" } } },
    { properties: { value: { enum: ["2026-01-01"], format: "date" } } },
    { properties: { value: { enum: ["a"], nullable: true } } },
    { properties: { value: { enum: [] } } }, { properties: { value: { enum: "a" } } },
    { properties: { value: { enum: ["1", 1] } } }, { properties: { value: { enum: ["x", "x"] } } },
    { properties: { value: { type: "boolean", not: { const: false } } } },
    { properties: { value: { enum: ["a"], minLength: 2 } } },
    { properties: { value: { type: [], const: true } } },
  ])("delegates malformed or unsupported schemas without losing constraints: %j", async (schema) => {
    const result = await route(schema);
    expect(result.mode).toBe("forced");
    expect(result.upstream.calls).toHaveLength(1);
    expect(result.upstream.calls[0]!.body.tools[0].function.parameters).toEqual(schema);
  });

  it("does not read inherited schemas or lose special own-property argument names", async () => {
    const inherited = Object.create({ type: "object", properties: {} });
    expect(planTool({ name: "status", kind: "function", parameters: inherited }).closedParams).toBeUndefined();
    const schema = JSON.parse('{"properties":{"__proto__":{"const":"safe"},"toString":{"const":true}},"required":["__proto__","toString"]}');
    const result = await route(schema);
    expect(result.mode).toBe("direct");
    const args = JSON.parse(result.json.choices[0].message.tool_calls[0].function.arguments);
    expect(Object.hasOwn(args, "__proto__")).toBe(true);
    expect(args.__proto__).toBe("safe");
    expect(args.toString).toBe(true);
  });
});
