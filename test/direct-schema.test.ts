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

describe("closed argument schemas", () => {
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
