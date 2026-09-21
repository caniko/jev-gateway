import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { policyFor, parsePolicyConfig } from "../src/policies.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

const closedTool = (name: string) => ({
  type: "function",
  function: {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] },
  },
});

describe("policy matching", () => {
  it("matches exact normalized identities and simple patterns with precedence", () => {
    const cfg = parsePolicyConfig({
      default: "passthrough",
      rules: [
        { match: "blender_get_scene_info", policy: "direct-eligible" },
        { match: "blender_*", policy: "selection-only" },
        { match: "blender_get_*", policy: "direct-eligible" },
      ],
    });
    expect(policyFor("blender_get_scene_info", cfg)).toBe("direct-eligible");
    expect(policyFor("BLENDER_GET_SCENE_INFO", cfg)).toBe("direct-eligible");
    expect(policyFor("blender_other", cfg)).toBe("selection-only");
    expect(policyFor("unknown_tool", cfg)).toBe("passthrough");
  });

  it("resolves conflicts to the most restrictive and rejects invalid config", () => {
    const cfg = parsePolicyConfig({
      default: "direct-eligible",
      rules: [
        { match: "t*", policy: "direct-eligible" },
        { match: "t*", policy: "passthrough" },
      ],
    });
    expect(policyFor("tool", cfg)).toBe("passthrough");
    expect(() => parsePolicyConfig({ default: "allow-everything" } as any)).toThrow();
    expect(() => parsePolicyConfig({ default: "passthrough", rules: [{ match: "", policy: "passthrough" }] })).toThrow();
  });

  it("handles normalized-name collisions conservatively", () => {
    const cfg = parsePolicyConfig({
      default: "passthrough",
      rules: [{ match: "my_tool", policy: "direct-eligible" }],
    });
    expect(policyFor("MY_TOOL", cfg)).toBe("direct-eligible");
    expect(policyFor(" my_tool ", cfg)).toBe("direct-eligible");
    // A roster holding two distinct names with one normalized form is
    // ambiguous: both resolve to passthrough even with an exact rule.
    expect(policyFor("MY_TOOL", cfg, ["MY_TOOL", "my_tool"])).toBe("passthrough");
    expect(policyFor("my_tool", cfg, ["MY_TOOL", "my_tool"])).toBe("passthrough");
  });

  it("rejects explicit null instead of silently defaulting permissive", () => {
    expect(() => parsePolicyConfig(null)).toThrow();
    expect(parsePolicyConfig(undefined).default).toBe("direct-eligible");
    expect(parsePolicyConfig("").default).toBe("direct-eligible");
  });

  it("rejects unknown fields instead of silently defaulting permissive", () => {
    expect(() => parsePolicyConfig({ defualt: "passthrough" } as any)).toThrow();
    expect(() => parsePolicyConfig({ default: "passthrough", rules: [{ match: "t", policy: "allow" }] })).toThrow();
    expect(() =>
      parsePolicyConfig({ default: "passthrough", rules: [{ match: "t", policy: "passthrough", extra: 1 }] as any }),
    ).toThrow();
  });

  it("keeps unreviewed FreeCAD tools on passthrough under the CAD example", async () => {
    const { readFileSync } = await import("node:fs");
    const example = JSON.parse(readFileSync(new URL("../examples/cad-policies.json", import.meta.url), "utf8"));
    const cfg = parsePolicyConfig(example);
    expect(policyFor("freecad_get_something", cfg)).toBe("passthrough");
    expect(policyFor("blender_get_scene_info", cfg)).toBe("direct-eligible");
  });
});

describe("gateway enforces policies", () => {
  it("passthrough tools stay in the request and delegate unchanged", async () => {
    const tool = closedTool("blender_execute_code");
    const cfg = testConfig({
      toolPolicies: parsePolicyConfig({ default: "passthrough", rules: [] }),
    });
    const jev = fakeJev({ tool: { choice: "blender_execute_code" }, needs_tool: { noul: 0.95 }, "arg:0:on": { noul: 0.99 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: cfg, askJev: jev.askJev, fetch: upstream.fetchImpl });
    const body = { model: "m", messages: [{ role: "user", content: "run" }], tools: [tool] };
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe("tool_policy_passthrough");
    // Tools are not removed from the upstream request.
    expect(upstream.calls[0]!.body.tools).toEqual(body.tools);
  });

  it("selection-only never synthesizes direct, even when closed", async () => {
    const tool = closedTool("blender_validate_patch");
    const cfg = testConfig({
      toolPolicies: parsePolicyConfig({
        default: "passthrough",
        rules: [{ match: "blender_validate_*", policy: "selection-only" }],
      }),
    });
    const jev = fakeJev({ tool: { choice: "blender_validate_patch" }, needs_tool: { noul: 0.95 }, "arg:0:on": { noul: 0.99 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: cfg, askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "v" }], tools: [tool] }),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls).toHaveLength(1);
  });

  it("direct-eligible allows direct only when all gates pass, global disable wins", async () => {
    const tool = closedTool("blender_get_scene_info");
    const directCfg = testConfig({
      toolPolicies: parsePolicyConfig({
        default: "passthrough",
        rules: [{ match: "blender_get_scene_info", policy: "direct-eligible" }],
      }),
    });
    const canned = { tool: { choice: "blender_get_scene_info" }, needs_tool: { noul: 0.95 }, "arg:0:on": { noul: 0.99 } };
    const app1 = createApp({ config: directCfg, askJev: fakeJev(canned).askJev, fetch: fakeUpstream().fetchImpl });
    const res1 = await app1.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "i" }], tools: [tool], stream: false }),
    });
    expect(res1.headers.get("x-jev-gateway-mode")).toBe("direct");

    const disabledCfg = testConfig({
      directCalls: false,
      toolPolicies: parsePolicyConfig({
        default: "passthrough",
        rules: [{ match: "blender_get_scene_info", policy: "direct-eligible" }],
      }),
    });
    const app2 = createApp({ config: disabledCfg, askJev: fakeJev(canned).askJev, fetch: fakeUpstream().fetchImpl });
    const res2 = await app2.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "i" }], tools: [tool] }),
    });
    expect(res2.headers.get("x-jev-gateway-mode")).not.toBe("direct");
  });

  it("treats a case-folded roster collision as passthrough at the gateway", async () => {
    const cfg = testConfig({
      toolPolicies: parsePolicyConfig({
        default: "passthrough",
        rules: [{ match: "my_tool", policy: "direct-eligible" }],
      }),
    });
    const tools = [closedTool("MY_TOOL"), closedTool("my_tool")];
    // Policy gates the outcome after selection; arg questions are still
    // asked for every closed tool, so both need canned answers.
    const jev = fakeJev({
      tool: { choice: "MY_TOOL" },
      needs_tool: { noul: 0.95 },
      "arg:0:on": { noul: 0.99 },
      "arg:1:on": { noul: 0.99 },
    });
    const upstream = fakeUpstream();
    const app = createApp({ config: cfg, askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "go" }], tools }),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe("tool_policy_passthrough");
  });

  it("keeps passthrough tools in the request on a no-tool decision", async () => {
    // Jev says no tool is needed while a passthrough-policy tool exists:
    // the decision delegates unchanged with the roster intact.
    const tool = closedTool("blender_execute_code");
    const cfg = testConfig({ toolPolicies: parsePolicyConfig({ default: "passthrough", rules: [] }) });
    const jev = fakeJev({ tool: { choice: "no_tool_needed" }, needs_tool: { noul: 0.05 }, "arg:0:on": { noul: 0.5 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: cfg, askJev: jev.askJev, fetch: upstream.fetchImpl });
    const body = { model: "m", messages: [{ role: "user", content: "just chat" }], tools: [tool] };
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(["none", "passthrough"]).toContain(res.headers.get("x-jev-gateway-mode"));
    if (upstream.calls.length) expect(upstream.calls[0]!.body.tools).toEqual(body.tools);
  });

  it("unsafe names still bypass via existing guards, unknown tools default passthrough", async () => {
    const cfg = testConfig({
      toolPolicies: parsePolicyConfig({ default: "passthrough", rules: [{ match: "ok_*", policy: "direct-eligible" }] }),
    });
    const jev = fakeJev({ tool: { choice: "ok_tool" }, needs_tool: { noul: 0.95 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: cfg, askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "evil tool", parameters: { type: "object", properties: {} } } }],
      }),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
  });
});
