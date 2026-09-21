import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { buildQuestions } from "../src/questions.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

// JEV_DIRECT_CALLS=false must be absolute: no tool may produce a synthetic
// direct response, even when no argument questions would be needed.

const emptyTool = {
  type: "function",
  function: {
    name: "empty_tool",
    description: "Takes no arguments.",
    parameters: { type: "object", properties: {} },
  },
} as const;

const requiredConstTool = {
  type: "function",
  function: {
    name: "const_required",
    description: "Required const.",
    parameters: {
      type: "object",
      properties: { mode: { const: "fast" } },
      required: ["mode"],
    },
  },
} as const;

const optionalConstTool = {
  type: "function",
  function: {
    name: "const_optional",
    description: "Optional const.",
    parameters: {
      type: "object",
      properties: { mode: { const: "fast" } },
      required: [],
    },
  },
} as const;

const singleEnumTool = {
  type: "function",
  function: {
    name: "single_enum",
    description: "Single-value enum.",
    parameters: {
      type: "object",
      properties: { mode: { enum: ["only"] } },
      required: ["mode"],
    },
  },
} as const;

const boolTool = {
  type: "function",
  function: {
    name: "bool_tool",
    description: "Boolean arg.",
    parameters: {
      type: "object",
      properties: { on: { type: "boolean" } },
      required: ["on"],
    },
  },
} as const;

const enumTool = {
  type: "function",
  function: {
    name: "enum_tool",
    description: "Ordinary enum.",
    parameters: {
      type: "object",
      properties: { room: { type: "string", enum: ["kitchen", "office"] } },
      required: ["room"],
    },
  },
} as const;

const mixedTool = {
  type: "function",
  function: {
    name: "mixed_tool",
    description: "Open-ended plus closed.",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string", enum: ["kitchen", "office"] },
        note: { type: "string" },
      },
      required: ["room", "note"],
    },
  },
} as const;

describe("JEV_DIRECT_CALLS=false is absolute", () => {
  it("strips closed plans when argument questions are disabled", () => {
    const tools = [emptyTool, requiredConstTool, boolTool, enumTool, mixedTool].map((t: any) => ({
      kind: "function" as const,
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
    const { questions, plans } = buildQuestions(tools, { allowNone: true, withArgs: false });
    expect(Object.keys(questions)).toEqual(["tool", "needs_tool"]);
    for (const plan of plans) expect(plan.closedParams).toBeUndefined();
  });

  it("never returns direct for empty, const, single-enum, boolean, or enum tools", async () => {
    const cases: Array<{ tool: any; canned: Record<string, any> }> = [
      { tool: emptyTool, canned: { tool: { choice: "empty_tool" }, needs_tool: { noul: 0.95 } } },
      { tool: requiredConstTool, canned: { tool: { choice: "const_required" }, needs_tool: { noul: 0.95 } } },
      { tool: optionalConstTool, canned: { tool: { choice: "const_optional" }, needs_tool: { noul: 0.95 } } },
      { tool: singleEnumTool, canned: { tool: { choice: "single_enum" }, needs_tool: { noul: 0.95 } } },
      {
        tool: boolTool,
        canned: { tool: { choice: "bool_tool" }, needs_tool: { noul: 0.95 }, "arg:0:on": { noul: 0.99 } },
      },
      {
        tool: enumTool,
        canned: { tool: { choice: "enum_tool" }, needs_tool: { noul: 0.95 }, "arg:0:room": { choice: "kitchen" } },
      },
    ];
    for (const { tool, canned } of cases) {
      const jev = fakeJev(canned);
      const upstream = fakeUpstream();
      const app = createApp({
        config: testConfig({ directCalls: false }),
        askJev: jev.askJev,
        fetch: upstream.fetchImpl,
      });
      const body = {
        model: "m",
        messages: [{ role: "user", content: "go" }],
        tools: [tool],
        tool_choice: "auto",
      };
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.headers.get("x-jev-gateway-mode")).not.toBe("direct");
      expect(["forced", "hint"]).toContain(res.headers.get("x-jev-gateway-mode"));
      expect(upstream.calls).toHaveLength(1);
      // /router/decide must agree: confident selection delegates, never direct.
      const jev2 = fakeJev(canned);
      const app2 = createApp({
        config: testConfig({ directCalls: false }),
        askJev: jev2.askJev,
        fetch: fakeUpstream().fetchImpl,
      });
      const decided = await app2.request("/router/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await decided.json()) as any;
      expect(json.mode).not.toBe("direct");
    }
  });

  it("delegates mixed/open schemas via forced instead of direct", async () => {
    const jev = fakeJev({ tool: { choice: "mixed_tool" }, needs_tool: { noul: 0.95 } });
    const upstream = fakeUpstream();
    const app = createApp({
      config: testConfig({ directCalls: false }),
      askJev: jev.askJev,
      fetch: upstream.fetchImpl,
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "go" }],
        tools: [mixedTool],
      }),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls).toHaveLength(1);
  });

  it("covers every adapter endpoint with direct disabled", async () => {
    const toolName = "empty_tool";
    const canned = { tool: { choice: toolName }, needs_tool: { noul: 0.95 } };
    const config = testConfig({ directCalls: false });

    // chat
    {
      const app = createApp({ config, askJev: fakeJev(canned).askJev, fetch: fakeUpstream().fetchImpl });
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "go" }],
          tools: [emptyTool],
        }),
      });
      expect(res.headers.get("x-jev-gateway-mode")).not.toBe("direct");
    }
    // responses
    {
      const jev = fakeJev(canned);
      const upstream = fakeUpstream();
      const app = createApp({ config, askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          input: [{ role: "user", content: "go" }],
          tools: [{ type: "function", name: toolName, parameters: { type: "object", properties: {} } }],
        }),
      });
      expect(res.headers.get("x-jev-gateway-mode")).not.toBe("direct");
      expect(upstream.calls).toHaveLength(1);
    }
    // messages
    {
      const jev = fakeJev(canned);
      const upstream = fakeUpstream();
      const app = createApp({ config, askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "go" }],
          tools: [{ name: toolName, input_schema: { type: "object", properties: {} } }],
        }),
      });
      expect(res.headers.get("x-jev-gateway-mode")).not.toBe("direct");
    }
    // gemini
    {
      const jev = fakeJev(canned);
      const upstream = fakeUpstream();
      const app = createApp({ config, askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "go" }] }],
          tools: [{ functionDeclarations: [{ name: toolName, parameters: { type: "object", properties: {} } }] }],
        }),
      });
      expect(res.headers.get("x-jev-gateway-mode")).not.toBe("direct");
    }
    // /router/decide with chat shape
    {
      const app = createApp({ config, askJev: fakeJev(canned).askJev, fetch: fakeUpstream().fetchImpl });
      const res = await app.request("/router/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "go" }],
          tools: [emptyTool],
        }),
      });
      expect(((await res.json()) as any).mode).not.toBe("direct");
    }
  });

  it("keeps valid no-arg direct working when enabled (positive control)", async () => {
    const jev = fakeJev({ tool: { choice: "empty_tool" }, needs_tool: { noul: 0.95 } });
    const upstream = fakeUpstream();
    const app = createApp({
      config: testConfig({ directCalls: true }),
      askJev: jev.askJev,
      fetch: upstream.fetchImpl,
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "go" }],
        tools: [emptyTool],
        stream: false,
      }),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("direct");
    expect(upstream.calls).toHaveLength(0);
  });
});
