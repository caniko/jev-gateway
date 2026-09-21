import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { planTool } from "../src/questions.js";
import { validateDirectArgs } from "../src/schema.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

const closedTool = (name: string, parameters: any) => ({
  kind: "function" as const,
  name,
  description: `${name} tool`,
  parameters,
});

describe("planTool stays narrow", () => {
  it("refuses missing, non-object, $ref, composition, and constrained schemas", () => {
    expect(planTool(closedTool("t", undefined as any).name ? { kind: "function", name: "t" } as any : null as any).closedParams).toBeUndefined();
    expect(planTool(closedTool("t", { type: "object", properties: { a: { $ref: "#/$defs/a" } } })).closedParams).toBeUndefined();
    expect(planTool(closedTool("t", { type: "object", allOf: [{ type: "object" }] } as any)).closedParams).toBeUndefined();
    expect(planTool(closedTool("t", { type: "object", properties: { a: { type: "string", minLength: 2 } } })).closedParams).toBeUndefined();
    expect(planTool(closedTool("t", { type: "array", items: {} } as any)).closedParams).toBeUndefined();
  });

  it("keeps valid no-arg and closed enum/boolean working", () => {
    expect(
      planTool(closedTool("empty", { type: "object", properties: {} })).closedParams,
    ).toEqual([]);
    expect(
      planTool(
        closedTool("lights", {
          type: "object",
          properties: { room: { type: "string", enum: ["k", "o"] }, on: { type: "boolean" } },
          required: ["room", "on"],
        }),
      ).closedParams?.map((p) => p.kind),
    ).toEqual(["enum", "boolean"]);
  });
});

describe("validateDirectArgs", () => {
  it("enforces required, types, const/enum, and additionalProperties", () => {
    const schema = {
      type: "object",
      properties: { room: { type: "string", enum: ["k", "o"] }, on: { type: "boolean" } },
      required: ["room", "on"],
      additionalProperties: false,
    } as any;
    expect(validateDirectArgs(schema, { room: "k", on: true }).ok).toBe(true);
    expect(validateDirectArgs(schema, { room: "k" }).ok).toBe(false);
    expect(validateDirectArgs(schema, { room: "k", on: "true" as any }).ok).toBe(false);
    expect(validateDirectArgs(schema, { room: "zzz", on: true }).ok).toBe(false);
    expect(validateDirectArgs(schema, { room: "k", on: true, extra: 1 as any }).ok).toBe(false);
  });

  it("does not coerce, inject defaults, or drop constraints", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "integer", enum: [25, 50] } },
      required: ["count"],
    } as any;
    // "50" must not coerce to 50.
    expect(validateDirectArgs(schema, { count: "50" as any }).ok).toBe(false);
    expect(validateDirectArgs(schema, { count: 50 }).ok).toBe(true);
    // Integer enum against string-typed values: no match either way.
    const mixed = { type: "object", properties: { a: { type: "integer", enum: ["x"] } }, required: ["a"] } as any;
    expect(validateDirectArgs(mixed, { a: "x" }).ok).toBe(false);
    expect(validateDirectArgs(mixed, { a: 1 }).ok).toBe(false);
    // Missing required must not be filled with defaults.
    expect(validateDirectArgs(schema, {} as any).ok).toBe(false);
  });

  it("refuses adversarial composition and references without network", () => {
    expect(validateDirectArgs({ type: "object", $ref: "https://example.com/s.json" } as any, {}).ok).toBe(false);
    expect(validateDirectArgs({ type: "object", anyOf: [{ type: "object" }] } as any, {}).ok).toBe(false);
    expect(
      validateDirectArgs({ type: "object", properties: { a: { type: ["string", "null"] } } } as any, { a: "x" }).ok,
    ).toBe(false);
  });

  it("rejects unknown keywords and prototype-inherited names", () => {
    // minProperties is a real constraint the planner would ignore.
    expect(validateDirectArgs({ type: "object", minProperties: 1 } as any, {}).ok).toBe(false);
    expect(planTool(closedTool("t", { type: "object", minProperties: 1 } as any)).closedParams).toBeUndefined();
    // Inherited Object.prototype names must not satisfy required/properties.
    expect(validateDirectArgs({ type: "object", required: ["toString"] } as any, {}).ok).toBe(false);
    expect(
      validateDirectArgs({ type: "object", properties: {}, required: ["toString"] } as any, {
        toString: "x",
      } as any).ok,
    ).toBe(false);
    // Malformed enum and unknown property type are unsupported, not empty.
    expect(
      validateDirectArgs({ type: "object", properties: { a: { enum: "k" } } } as any, { a: "k" }).ok,
    ).toBe(false);
    expect(
      validateDirectArgs({ type: "object", properties: { a: { type: "weird" } } } as any, { a: "k" }).ok,
    ).toBe(false);
  });

  it("refuses malformed optionals, defaults, and bad annotations", () => {
    // Optional property that is not an object: nothing safe to infer.
    expect(planTool(closedTool("t", { type: "object", properties: { a: "string" } } as any)).closedParams).toBeUndefined();
    // `default` would silently invent a value: unsupported for direct.
    const withDefault = { type: "object", properties: { a: { type: "string", default: "x" } }, required: ["a"] } as any;
    expect(planTool(closedTool("t", withDefault)).closedParams).toBeUndefined();
    expect(validateDirectArgs(withDefault, { a: "x" }).ok).toBe(false);
    // Annotation and dialect keys must be well-formed strings when present.
    expect(validateDirectArgs({ type: "object", description: 42 } as any, {}).ok).toBe(false);
    expect(validateDirectArgs({ type: "object", title: null } as any, {}).ok).toBe(false);
    expect(
      validateDirectArgs({ type: "object", properties: { a: { type: "boolean", description: {} } } } as any, { a: true }).ok,
    ).toBe(false);
    // A string dialect declaration is metadata, not a constraint.
    expect(validateDirectArgs({ type: "object", $schema: "http://json-schema.org/draft-07/schema#" } as any, {}).ok).toBe(true);
  });

  it("treats const/type contradictions as mismatches, not coercions", () => {
    const schema = { type: "object", properties: { a: { type: "string", const: 1 } }, required: ["a"] } as any;
    expect(validateDirectArgs(schema, { a: 1 }).ok).toBe(false);
    expect(validateDirectArgs(schema, { a: "1" }).ok).toBe(false);
    expect(planTool(closedTool("t", schema)).closedParams?.[0]?.kind).toBe("const");
  });
});

describe("gateway delegates unsupported schemas instead of direct or reject", () => {
  it("forces when Jev picks a $ref tool instead of answering direct", async () => {
    const tool = {
      type: "function",
      function: {
        name: "ref_tool",
        description: "Has a ref.",
        parameters: { type: "object", $ref: "#/$defs/a", properties: {} } as any,
      },
    };
    const jev = fakeJev({ tool: { choice: "ref_tool" }, needs_tool: { noul: 0.95 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "go" }], tools: [tool] }),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls).toHaveLength(1);
  });

  it("does not treat missing parameters as empty-arg direct", async () => {
    const tool = { type: "function", function: { name: "no_schema", description: "No params." } };
    const jev = fakeJev({ tool: { choice: "no_schema" }, needs_tool: { noul: 0.95 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "go" }], tools: [tool] }),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
  });
});
