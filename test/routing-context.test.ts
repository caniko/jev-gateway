import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { buildState } from "../src/state.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

const tool = {
  type: "function",
  function: {
    name: "inspect",
    description: "Inspect.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
};

function cadTurns() {
  return [
    { role: "user", text: "inspect instance blender-01 doc Main revision r42" },
    { role: "assistant", tool_calls: [{ tool: "inspect", arguments: '{"id":"blender-01"}' }] },
    {
      role: "tool_result",
      tool: "inspect",
      content: JSON.stringify({ instance: "blender-01", doc: "Main", tree: "Geometry Nodes", revision: "r42", status: "ok" }),
    },
    { role: "assistant", tool_calls: [{ tool: "inspect", arguments: '{"id":"job-7"}' }] },
    {
      role: "tool_result",
      tool: "inspect",
      content: JSON.stringify({ job: "job-7", status: "running", progress: 0.4, validation: { failed: ["node-12"] } }),
    },
  ];
}

describe("routing-context integrity", () => {
  it("preserves tool-call/result association and recent groups", () => {
    const state = buildState({ system: "", turns: cadTurns() as any }, { maxStateChars: 2000, maxMessageChars: 2000 }) as any;
    expect(state.conversation).toHaveLength(5);
    expect(state.earlier_turns_omitted).toBeUndefined();
    // No IDs inferred, no promotion to system.
    expect(state.assistant_instructions).toBeUndefined();
  });

  it("keeps interaction groups atomic when omitting", () => {
    const turns = [
      { role: "user", text: "old" },
      { role: "assistant", tool_calls: [{ tool: "inspect", arguments: '{"id":"old"}' }] },
      { role: "tool_result", tool: "inspect", content: '{"id":"old"}' },
      { role: "user", text: "new plain question" },
    ];
    const state = buildState({ system: "", turns: turns as any }, { maxStateChars: 120, maxMessageChars: 2000 }) as any;
    // Ordinary text omission still routes (no incomplete flag for pure text).
    expect(state.truncated_routing_context).toBeUndefined();
    // Never keeps a result without its call.
    const hasResult = state.conversation.some((t: any) => t.role === "tool_result");
    const hasCall = state.conversation.some((t: any) => t.tool_calls);
    if (hasResult) expect(hasCall).toBe(true);
  });

  it("bypasses when newest structured result is truncated", async () => {
    const big = "x".repeat(5000);
    const turns = [
      { role: "user", text: "check" },
      { role: "assistant", tool_calls: [{ tool: "inspect", arguments: '{"id":"blender-01"}' }] },
      { role: "tool_result", tool: "inspect", content: JSON.stringify({ instance: "blender-01", blob: big }) },
    ];
    const jev = fakeJev({ tool: { choice: "inspect" }, needs_tool: { noul: 0.95 } });
    const upstream = fakeUpstream();
    const app = createApp({
      config: testConfig({ maxStateChars: 500, maxMessageChars: 500 }),
      askJev: jev.askJev,
      fetch: upstream.fetchImpl,
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [
          { role: "user", content: "check" },
          { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "inspect", arguments: '{"id":"blender-01"}' } }] },
          { role: "tool", tool_call_id: "c1", content: JSON.stringify({ instance: "blender-01", blob: big }) },
        ],
        tools: [tool],
      }),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe("incomplete_routing_context");
    expect(jev.requests).toHaveLength(0);
    // Upstream request unchanged (no Jev-driven rewrite to save input).
    expect(upstream.calls).toHaveLength(1);
  });

  it("bounds oversized newest turn and validates limits", () => {
    expect(() => buildState({ system: "", turns: [] }, { maxStateChars: 0, maxMessageChars: 100 } as any)).toThrow();
    const state = buildState(
      { system: "", turns: [{ role: "user", text: "x".repeat(5000) }] as any },
      { maxStateChars: 500, maxMessageChars: 5000 },
    ) as any;
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(2000);
    expect(state.conversation).toHaveLength(1);
  });

  it("preserves useful routing for ordinary text with old omission", async () => {
    const jev = fakeJev({ tool: { choice: "inspect" }, needs_tool: { noul: 0.9 } });
    const upstream = fakeUpstream();
    const app = createApp({
      config: testConfig({ maxStateChars: 300, maxMessageChars: 1000 }),
      askJev: jev.askJev,
      fetch: upstream.fetchImpl,
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [
          { role: "user", content: "old text ".repeat(50) },
          { role: "assistant", content: "old reply" },
          { role: "user", content: "inspect blender-01 now" },
        ],
        tools: [tool],
      }),
    });
    // Not indiscriminately disabled: ordinary text still routes.
    expect(["forced", "hint", "direct", "none"]).toContain(res.headers.get("x-jev-gateway-mode"));
    expect(jev.requests).toHaveLength(1);
  });
});
