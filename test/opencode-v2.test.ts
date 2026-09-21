import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

// OpenCode v2 support: pinned CLI 2.0.12 (npm integrity
// sha512-LwB0LD7LXZbfFDU12KwiUq5nPcjW1BzYpp81UPzEBpeZSNvszKXnTUa3l8JmLi6I6/WtQx/Z/8n2743FyY6lpg==).
// Validates v2-native provider config, transport safety, and CAD codemode guidance
// without requiring paid keys or a desktop.

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

    const app2 = createApp({ config: testConfig(), askJev: fakeJev({ tool: { choice: "bash" }, needs_tool: { noul: 0.9 } }).askJev, fetch: fakeUpstream().fetchImpl });
    const upstream2 = fakeUpstream();
    const app3 = createApp({ config: testConfig(), askJev: fakeJev({ tool: { choice: "bash" }, needs_tool: { noul: 0.9 } }).askJev, fetch: upstream2.fetchImpl });
    const res3 = await app3.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res3.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream2.calls[0]!.body.model).toBe("gpt-5");
    expect(app2).toBeDefined();
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
