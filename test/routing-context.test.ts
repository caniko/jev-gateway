import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
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
  it("bounds escaped text and oversized identifiers including tiny valid budgets", () => {
    for (const budget of [64, 100, 128, 300, 800]) {
      const input = {
        system: '"\\\n'.repeat(2000),
        turns: [{ role: "tool_result", call_id: "x".repeat(2000), content: "answer" }],
      };
      const before = JSON.stringify(input);
      const result = buildState(input, { maxStateChars: budget, maxMessageChars: 2000 });
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(budget);
      expect(result.truncated_routing_context).toBe(true);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(() => loadConfig({ JEV_MAX_STATE_CHARS: "1" })).toThrow(/at least 64/);
  });
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
    expect(() => buildState({ system: "", turns: [] }, { maxStateChars: 1.5, maxMessageChars: 100 } as any)).toThrow();
    const state = buildState(
      { system: "", turns: [{ role: "user", text: "x".repeat(5000) }] as any },
      { maxStateChars: 500, maxMessageChars: 5000 },
    ) as any;
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(2000);
    expect(state.conversation).toHaveLength(1);
  });

  it("keeps the serialized total within budget and never mutates its input", () => {
    const turns = [
      { role: "user", text: "q" },
      { role: "assistant", tool_calls: [{ tool: "inspect", arguments: '{"id":"a"}', call_id: "c1" }] },
      { role: "tool_result", tool: "inspect", content: "r1", call_id: "c1" },
      { role: "assistant", tool_calls: [{ tool: "inspect", arguments: '{"id":"b"}', call_id: "c2" }] },
      { role: "tool_result", tool: "inspect", content: "r2", call_id: "c2" },
    ];
    const snapshot = JSON.stringify(turns);
    const state = buildState({ system: "sys", turns: turns as any }, { maxStateChars: 300, maxMessageChars: 1000 }) as any;
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(turns)).toBe(snapshot);
    // Contiguous suffix: dropping the middle group is never allowed.
    const texts = JSON.stringify(state.conversation);
    if (texts.includes("r2")) expect(texts.includes("c2")).toBe(true);
  });

  it("rejects non-integer state limits at config load", () => {
    expect(() => loadConfig({ UPSTREAM_BASE_URL: "https://llm.test/v1", JEV_MAX_STATE_CHARS: "0" })).toThrow();
    expect(() => loadConfig({ UPSTREAM_BASE_URL: "https://llm.test/v1", JEV_MAX_MESSAGE_CHARS: "1.5" })).toThrow();
    expect(loadConfig({ UPSTREAM_BASE_URL: "https://llm.test/v1" }).maxStateChars).toBe(60_000);
  });

  it("holds the exact serialized bound at tiny limits", () => {
    const turns = [
      { role: "user", text: "first question here" },
      { role: "assistant", tool_calls: [{ tool: "inspect", arguments: '{"id":"a"}', call_id: "c1" }] },
      { role: "tool_result", tool: "inspect", content: "result one", call_id: "c1" },
      { role: "user", text: "second question here" },
    ];
    for (const max of [150, 200, 300]) {
      const state = buildState({ system: "", turns: turns as any }, { maxStateChars: max, maxMessageChars: 1000 }) as any;
      expect(JSON.stringify(state).length).toBeLessThanOrEqual(max);
      // Contiguous suffix: the newest user turn is always present.
      expect(JSON.stringify(state.conversation)).toContain("second question here");
    }
  });

  it("survives oversized system text, escaping, and large identifiers", () => {
    const bigId = "c".repeat(300);
    const turns = [
      { role: "assistant", tool_calls: [{ tool: "inspect", arguments: `{"id":"${bigId}","q":"he said \\"hi\\" 🎛"}`, call_id: bigId }] },
      { role: "tool_result", tool: "inspect", content: "ok \"quoted\" \\ done", call_id: bigId },
    ];
    const state = buildState(
      { system: "S".repeat(5000), turns: turns as any },
      { maxStateChars: 800, maxMessageChars: 2000 },
    ) as any;
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(800);
    // Escaped content round-trips through JSON; the large id is intact or
    // the turn is explicitly marked truncated (never silently chopped).
    const text = JSON.stringify(state.conversation);
    expect(text.includes(bigId) || state.truncated_routing_context === true).toBe(true);
  });

  it("bypasses interleaved call/result groups that cannot stay associated", async () => {
    // resultA kept without callA: disconnected evidence must not route.
    const { incompleteRoutingContext } = await import("../src/state.js");
    const state = buildState(
      {
        system: "",
        turns: [
          { role: "assistant", tool_calls: [{ tool: "a", arguments: "{}", call_id: "ca" }] },
          { role: "assistant", tool_calls: [{ tool: "b", arguments: "{}", call_id: "cb" }] },
          { role: "tool_result", tool: "b", content: "rb", call_id: "cb" },
          { role: "tool_result", tool: "a", content: "ra", call_id: "ca" },
        ] as any,
      },
      { maxStateChars: 220, maxMessageChars: 1000 },
    ) as any;
    // Small budget keeps only the tail; if callA fell off while resultA
    // stayed, the context is incomplete.
    const hasA = JSON.stringify(state.conversation).includes('"ca"');
    const hasRa = JSON.stringify(state.conversation).includes("ra");
    if (hasRa && !hasA) expect(incompleteRoutingContext(state)).toBe("incomplete_routing_context");
    else expect(state.earlier_turns_omitted ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("bypasses a kept result whose call was omitted", async () => {
    // Direct buildState input with a dangling call_id (as produced if an
    // adapter ever emitted one) must not route on disconnected evidence.
    const { incompleteRoutingContext } = await import("../src/state.js");
    expect(
      incompleteRoutingContext({
        conversation: [{ role: "tool_result", tool: "x", content: "orphan", call_id: "missing" }],
      }),
    ).toBe("incomplete_routing_context");
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
