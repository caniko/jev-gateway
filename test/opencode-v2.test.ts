import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

// OpenCode v2 support: pinned CLI 2.0.12 (npm integrity
// sha512-LwB0LD7LXZbfFDU12KwiUq5nPcjW1BzYpp81UPzEBpeZSNvszKXnTUa3l8JmLi6I6/WtQx/Z/8n2743FyY6lpg==).
// Gateway transport safety for the wire shapes 2.0.12 was observed to use
// (Responses for built-in providers, Chat Completions for openai-compatible
// custom providers). No paid keys or desktop needed.

describe("opencode v2 wire safety", () => {
  it("preserves provider fields on forced path and audits ARGS_MODEL", async () => {
    const jev = fakeJev({ tool: { choice: "bash" }, needs_tool: { noul: 0.9 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig({ argsModel: "cheap-model" }), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const body = {
      model: "gpt-5",
      messages: [{ role: "user", content: "list" }],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          },
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
    };
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    // ARGS_MODEL is used verbatim when set; otherwise the request model is preserved.
    expect(upstream.calls[0]!.body.model).toBe("cheap-model");

    const upstream2 = fakeUpstream();
    const app3 = createApp({ config: testConfig(), askJev: fakeJev({ tool: { choice: "bash" }, needs_tool: { noul: 0.9 } }).askJev, fetch: upstream2.fetchImpl });
    const res3 = await app3.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res3.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream2.calls[0]!.body.model).toBe("gpt-5");
  });

  it("disables direct on server-side history, namespaces, and dynamic tools", async () => {
    // previous_response_id already bypasses.
    const jev = fakeJev({});
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        input: [{ role: "user", content: "hi" }],
        previous_response_id: "resp_123",
        tools: [{ type: "function", name: "t", parameters: { type: "object", properties: {} } }],
      }),
    });
    expect(res.headers.get("x-jev-gateway-reason")).toBe("previous_response_id");
    expect(jev.requests).toHaveLength(0);

    // Namespaced tools never force/direct: passthrough preserves safe fallback.
    const jev2 = fakeJev({ tool: { choice: "ns.tool" }, needs_tool: { noul: 0.95 } });
    const app2 = createApp({ config: testConfig(), askJev: jev2.askJev, fetch: fakeUpstream().fetchImpl });
    const res2 = await app2.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        input: [{ role: "user", content: "hi" }],
        tools: [{ type: "namespace", name: "ns", tools: [{ type: "function", name: "tool" }] }],
      }),
    });
    expect(res2.headers.get("x-jev-gateway-mode")).toBe("passthrough");
  });

  it("records flattened MCP names vs provider namespaces", async () => {
    const jev = fakeJev({ tool: { choice: "mcp__home__set_light" }, needs_tool: { noul: 0.9 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "mcp__home__set_light",
              parameters: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] },
            },
          },
        ],
      }),
    });
    const criteria = (jev.requests[0]!.questions as any).tool.criteria;
    expect(Object.keys(criteria)).toContain("mcp__home__set_light");
    // Provider namespaces (Responses namespace groups, Codex additional_tools)
    // are qualified as `ns.name` and never forced by bare name (see safety test above).
  });

  it("disables direct unless the session is explicitly unstored", async () => {
    // Stored sessions (explicitly, or by omission since the API stores by
    // default) may later chain from previous_response_id. The gateway's
    // synthetic direct reply is explicitly unstored, so direct mode runs
    // only on explicit store:false while forced selection still applies.
    const canned = {
      tool: { choice: "t" },
      needs_tool: { noul: 0.95 },
      "arg:0:on": { noul: 0.99 },
    };
    const closed = { type: "function", name: "t", parameters: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] } };
    for (const body of [
      { model: "m", input: [{ role: "user", content: "hi" }], tools: [closed], store: true, stream: false },
      { model: "m", input: [{ role: "user", content: "hi" }], tools: [closed], stream: false },
    ]) {
      const jev = fakeJev(canned);
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]!.body.tool_choice).toEqual({ type: "function", name: "t" });
    }

    // Explicitly unstored sessions keep direct, and the synthetic reply
    // cannot poison a later chain: store:false with previous_response_id:null.
    const app2 = createApp({ config: testConfig(), askJev: fakeJev(canned).askJev, fetch: fakeUpstream().fetchImpl });
    const res2 = await app2.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", input: [{ role: "user", content: "hi" }], tools: [closed], store: false, stream: false }),
    });
    expect(res2.headers.get("x-jev-gateway-mode")).toBe("direct");
    const json = (await res2.json()) as any;
    expect(json.store).toBe(false);
    expect(json.previous_response_id).toBeNull();
  });

  it("routes dynamically declared additional_tools without inventing mappings", async () => {
    const jev = fakeJev({ tool: { choice: "late_tool" }, needs_tool: { noul: 0.9 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        input: [
          { role: "user", content: "hi" },
          { type: "additional_tools", tools: [{ type: "function", name: "late_tool", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }] },
        ],
      }),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls[0]!.body.tool_choice).toEqual({ type: "function", name: "late_tool" });
  });

  it("does not generate synthetic response IDs and streams safely", async () => {
    const jev = fakeJev({
      tool: { choice: "mcp__home__set_light" },
      needs_tool: { noul: 0.95 },
      "arg:0:on": { noul: 0.99 },
    });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "light" }],
        tools: [
          {
            type: "function",
            function: {
              name: "mcp__home__set_light",
              parameters: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] },
            },
          },
        ],
        stream: true,
      }),
    });
    // Direct IDs are client-visible call IDs, never previous_response_id chains.
    expect(res.headers.get("x-jev-gateway-mode")).toBe("direct");
    const text = await res.text();
    expect(text).toContain("[DONE]");
    expect(text).not.toContain("previous_response_id");
  });
});
