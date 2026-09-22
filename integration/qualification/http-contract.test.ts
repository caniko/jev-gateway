import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { fakeJev, fakeUpstream, testConfig } from "../../test/helpers.js";

// Deterministic v2 acceptance (no keys, no desktop, no network).
// These HTTP checks make no claims about client discovery or permissions.

const mcpTool = (name: string, params: any = { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] }) => ({
  type: "function",
  function: { name, description: `${name} (MCP flattened)`, parameters: params },
});

describe("deterministic v2 acceptance", () => {
  it("offers supplied flattened tool names to Jev", async () => {
    const jev = fakeJev({ tool: { choice: "blender_get_scene_info" }, needs_tool: { noul: 0.9 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "scene?" }],
        tools: [mcpTool("blender_get_scene_info", { type: "object", properties: {} }), mcpTool("blender_execute_code")],
      }),
    });
    const criteria = (jev.requests[0]!.questions as any).tool.criteria;
    expect(Object.keys(criteria)).toContain("blender_get_scene_info");
    expect(Object.keys(criteria)).toContain("blender_execute_code");
  });

  it("exercises direct, forced, and media passthrough", async () => {
    // direct
    {
      const jev = fakeJev({ tool: { choice: "t" }, needs_tool: { noul: 0.95 }, "arg:0:on": { noul: 0.99 } });
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "on" }],
          tools: [mcpTool("t")],
          stream: false,
        }),
      });
      expect(res.headers.get("x-jev-gateway-mode")).toBe("direct");
      expect(upstream.calls).toHaveLength(0);
    }
    // forced
    {
      const jev = fakeJev({ tool: { choice: "t" }, needs_tool: { noul: 0.9 } });
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "run open task" }],
          tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } } }],
        }),
      });
      expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    }
    // passthrough (multimodal guard in PR3; here assert preservation regardless)
    {
      const jev = fakeJev({ tool: { choice: "t" }, needs_tool: { noul: 0.9 } });
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const body: any = {
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "http://x/y.png" } }] }],
        tools: [mcpTool("t")],
      };
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
      expect(jev.requests).toHaveLength(0);
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]!.body).toEqual(body);
    }
  });

  it("forwards linked call/result history unchanged", async () => {
    const jev = fakeJev({ tool: { choice: "t" }, needs_tool: { noul: 0.9 } });
    const upstream = fakeUpstream({ id: "ok" });
    const app = createApp({ config: testConfig({ directCalls: false }), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "do" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: '{"on":true}' } }] },
        { role: "tool", tool_call_id: "c1", content: "done" },
        { role: "user", content: "thanks" },
      ],
      tools: [mcpTool("t")],
    };
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(upstream.calls).toHaveLength(1);
    expect(jev.requests).toHaveLength(1);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls[0]!.body.messages).toEqual(body.messages);
  });

  it("delivers images to main model and preserves credentials", async () => {
    const jev = fakeJev({ tool: { choice: "t" }, needs_tool: { noul: 0.9 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const body = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "shot" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }],
      tools: [mcpTool("t")],
    };
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-key" },
      body: JSON.stringify(body),
    });
    // Full no-Jev guarantee is owned by PR3 multimodal guard; here assert
    // preservation and credential routing which hold in both cases.
    expect(upstream.calls[0]!.headers.get("authorization")).toBe("Bearer client-key");
    expect(upstream.calls[0]!.body.messages[0].content).toHaveLength(2);
  });

});
