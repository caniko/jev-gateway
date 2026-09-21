import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MULTIMODAL_SKIP } from "../src/multimodal.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

function chatApp() {
  const jev = fakeJev({ tool: { choice: "x" }, needs_tool: { noul: 0.9 } });
  const upstream = fakeUpstream({ id: "ok" });
  const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
  return { app, jev, upstream };
}

describe("conservative multimodal passthrough", () => {
  it("bypasses user screenshots without a Jev call, preserving body and model", async () => {
    const { app, jev, upstream } = chatApp();
    const body = {
      model: "gpt-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this screenshot?" },
            { type: "image_url", image_url: { url: "http://127.0.0.1/image.png" } },
          ],
        },
      ],
      tools: [{ type: "function", function: { name: "read", description: "r", parameters: { type: "object", properties: {} } } }],
    };
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
    expect(jev.requests).toHaveLength(0);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body).toEqual(body);
    expect(upstream.calls[0]!.body.model).toBe("gpt-5");
  });

  it("bypasses MCP-returned screenshots and mixed text/image tool results", async () => {
    const { app, jev, upstream } = chatApp();
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "screenshot the viewport" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "shot", arguments: "{}" } }] },
        {
          role: "tool",
          tool_call_id: "c1",
          content: [
            { type: "text", text: "viewport:" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          ],
        },
      ],
      tools: [{ type: "function", function: { name: "shot", parameters: { type: "object", properties: {} } } }],
    };
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
    expect(jev.requests).toHaveLength(0);
    expect(upstream.calls[0]!.body.messages[2].content).toHaveLength(2);
  });

  it("covers Responses, Messages, and Gemini image shapes", async () => {
    // Responses input_image
    {
      const jev = fakeJev({});
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          input: [{ role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "http://x/y.png" }] }],
          tools: [{ type: "function", name: "t", parameters: { type: "object", properties: {} } }],
        }),
      });
      expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
      expect(jev.requests).toHaveLength(0);
    }
    // Messages image block + nested tool-result image
    {
      const jev = fakeJev({});
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { type: "base64" } }] }],
          tools: [{ name: "t", input_schema: { type: "object", properties: {} } }],
        }),
      });
      expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
      expect(jev.requests).toHaveLength(0);
    }
    // Gemini inlineData
    {
      const jev = fakeJev({});
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }, { inlineData: { mimeType: "image/png", data: "AAA" } }] }],
          tools: [{ functionDeclarations: [{ name: "t", parameters: { type: "object", properties: {} } }] }],
        }),
      });
      expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
      expect(jev.requests).toHaveLength(0);
    }
  });

  it("bypasses nested blobs and opaque references without failing", async () => {
    // Gemini functionResponse carrying a nested screenshot part.
    {
      const jev = fakeJev({});
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const body = {
        contents: [
          {
            role: "user",
            parts: [{ functionResponse: { name: "shot", response: { ok: true }, parts: [{ inlineData: { mimeType: "image/png", data: "AAA" } }] } }],
          },
        ],
        tools: [{ functionDeclarations: [{ name: "t", parameters: { type: "object", properties: {} } }] }],
      };
      const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
      expect(jev.requests).toHaveLength(0);
      expect(upstream.calls[0]!.body).toEqual(body);
    }
    // Responses opaque item reference (server-side content Jev cannot see).
    {
      const jev = fakeJev({});
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const body = {
        model: "m",
        input: [{ type: "item_reference", id: "msg_1" }],
        tools: [{ type: "function", name: "t", parameters: { type: "object", properties: {} } }],
      };
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
      expect(jev.requests).toHaveLength(0);
      expect(upstream.calls[0]!.body).toEqual(body);
    }
  });

  it("bypasses opaque file references and malformed content without failing", async () => {
    const { app, jev } = chatApp();
    const fileRef = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file-123" } }] }],
        tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }],
      }),
    });
    expect(fileRef.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(jev.requests).toHaveLength(0);

    const malformed = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: [{ type: "image_url" }] }],
        tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }],
      }),
    });
    expect(malformed.headers.get("x-jev-gateway-mode")).toBe("passthrough");
  });

  it("treats old images in history conservatively (any image bypasses)", async () => {
    const { app, jev } = chatApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [
          { role: "user", content: [{ type: "text", text: "old" }, { type: "image_url", image_url: { url: "http://x/old.png" } }] },
          { role: "assistant", content: "saw it" },
          { role: "user", content: "now pure text follow-up" },
        ],
        tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }],
      }),
    });
    // No mechanism guesses the old image was already understood.
    expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
    expect(jev.requests).toHaveLength(0);
  });
});
