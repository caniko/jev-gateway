import { describe, expect, it, vi } from "vitest";
import plugin, {
  applyJevHint,
  parseDecision,
  resolveOptions,
  toChatMessages,
  toolResultText,
  type HintEvent,
} from "../plugin/jev/index.js";

const config = { gatewayUrl: "http://127.0.0.1:9", timeoutMs: 50 };

function decideWith(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

const model = { providerID: "p", id: "m" };

describe("resolveOptions", () => {
  it("applies defaults and accepts explicit values", () => {
    expect(resolveOptions(undefined)).toEqual({ gatewayUrl: "http://127.0.0.1:8791", timeoutMs: 1500 });
    expect(resolveOptions({ gatewayUrl: "https://gw:1/base/", timeoutMs: 100, enabled: true })).toEqual({
      gatewayUrl: "https://gw:1/base/",
      timeoutMs: 100,
    });
  });

  it("rejects unknown keys, bad urls, credentials, queries, fragments, and bad timeouts", () => {
    expect(() => resolveOptions({ bogus: 1 })).toThrow(/unknown option/);
    expect(() => resolveOptions({ enabled: "yes" })).toThrow(/enabled/);
    expect(() => resolveOptions({ gatewayUrl: "not-a-url" })).toThrow(/gatewayUrl/);
    expect(() => resolveOptions({ gatewayUrl: "ftp://h/x" })).toThrow(/http/);
    expect(() => resolveOptions({ gatewayUrl: "http://u:p@h/" })).toThrow(/credentials/);
    expect(() => resolveOptions({ gatewayUrl: "http://h/?x=1" })).toThrow(/query/);
    expect(() => resolveOptions({ gatewayUrl: "http://h/#f" })).toThrow(/fragment/);
    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 120001, "100"]) {
      expect(() => resolveOptions({ timeoutMs })).toThrow(/timeoutMs/);
    }
    expect(() => resolveOptions(null)).toThrow(/object/);
  });
});

describe("toolResultText", () => {
  it("keeps text, json, and error evidence", () => {
    expect(toolResultText({ type: "text", value: "hi" })).toEqual({ text: "hi" });
    expect(toolResultText({ type: "json", value: { a: 1 } })).toEqual({ text: '{"a":1}' });
    expect(toolResultText({ type: "error", value: "boom" })).toEqual({ text: "boom" });
    expect(toolResultText({ type: "content", value: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toEqual({
      text: "a\nb",
    });
  });

  it("bypasses file, unknown, and unserializable results", () => {
    // MCP-returned screenshot nested in a tool result.
    expect(
      toolResultText({ type: "content", value: [{ type: "text", text: "shot" }, { type: "file", uri: "f", mime: "i/png" }] }),
    ).toEqual({ opaque: true });
    expect(toolResultText({ type: "weird", value: 1 })).toEqual({ opaque: true });
    expect(toolResultText(null)).toEqual({ opaque: true });
    expect(toolResultText({ type: "text", value: 42 })).toEqual({ text: "42" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toolResultText({ type: "json", value: circular })).toEqual({ opaque: true });
  });
});

describe("toChatMessages", () => {
  it("preserves system, every text turn, and call/result association", () => {
    const out = toChatMessages({
      system: [{ type: "text", text: "Be brief." }],
      messages: [
        { role: "user", content: "inspect it" },
        { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "inspect", input: { id: "a" } }] },
        {
          role: "tool",
          content: [{ type: "tool-result", id: "c1", name: "inspect", result: { type: "text", value: "rev r42" } }],
        },
        { role: "user", content: [{ type: "text", text: "do that again" }] },
      ],
    });
    expect(out.opaque).toBeUndefined();
    expect(out.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "inspect it" },
      {
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: "inspect", arguments: '{"id":"a"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "rev r42" },
      { role: "user", content: "do that again" },
    ]);
  });

  it("keeps json/error results and skips reasoning, bypasses encrypted-only compaction", () => {
    const out = toChatMessages({
      messages: [
        { role: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "done" }] },
        { role: "tool", content: [{ type: "tool-result", id: "c2", name: "t", result: { type: "error", value: "denied" } }] },
        { role: "assistant", content: [{ type: "compaction", provider: "p", text: "summary" }] },
      ],
    });
    expect(out.opaque).toBeUndefined();
    expect(out.messages).toEqual([
      { role: "assistant", content: "done" },
      { role: "tool", tool_call_id: "c2", content: "denied" },
      { role: "assistant", content: "summary" },
    ]);
    expect(
      toChatMessages({ messages: [{ role: "assistant", content: [{ type: "compaction", provider: "p", encrypted: "x" }] }] }),
    ).toEqual({ opaque: true });
  });

  it("returns opaque for images, files, malformed calls, and unknown parts", () => {
    expect(
      toChatMessages({ messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url" }] }] }),
    ).toEqual({ opaque: true });
    expect(toChatMessages({ messages: [{ role: "user", content: [{ type: "media" }] }] })).toEqual({ opaque: true });
    expect(
      toChatMessages({ messages: [{ role: "assistant", content: [{ type: "tool-call", id: "c1" }] }] }),
    ).toEqual({ opaque: true });
    expect(toChatMessages({ messages: [{ role: "user", content: [{ type: "frobnicate" }] }] })).toEqual({ opaque: true });
  });

  it("encodes string input as data, never as presumed JSON", () => {
    const out = toChatMessages({
      messages: [
        { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "t", input: '{"a":1}' }] },
        { role: "assistant", content: [{ type: "tool-call", id: "c2", name: "t", input: "raw" }] },
      ],
    });
    // Strings are values: '{"a":1}' as data encodes with quotes, exactly
    // like any other string, instead of smuggling in a foreign object.
    expect(out.messages?.[0]).toMatchObject({ tool_calls: [{ function: { arguments: '"{\\"a\\":1}"' } }] });
    expect(out.messages?.[1]).toMatchObject({ tool_calls: [{ function: { arguments: '"raw"' } }] });
  });

  it("keeps single-result text beside its result, bypasses ambiguous mixes", () => {
    const single = toChatMessages({
      messages: [
        { role: "tool", content: [{ type: "text", text: "note" }, { type: "tool-result", id: "c1", name: "t", result: { type: "text", value: "v" } }] },
      ],
    });
    expect(single.messages).toEqual([{ role: "tool", tool_call_id: "c1", content: "v\nnote" }]);
    // Text beside two results could belong to either: bypass, don't guess.
    expect(
      toChatMessages({
        messages: [
          {
            role: "tool",
            content: [
              { type: "text", text: "note" },
              { type: "tool-result", id: "c1", name: "t", result: { type: "text", value: "v1" } },
              { type: "tool-result", id: "c2", name: "t", result: { type: "text", value: "v2" } },
            ],
          },
        ],
      }),
    ).toEqual({ opaque: true });
  });

  it("bypasses namespaced calls and malformed messages instead of dropping them", () => {
    expect(
      toChatMessages({
        messages: [{ role: "assistant", content: [{ type: "tool-call", id: "c1", name: "t", namespace: "mcp", input: {} }] }],
      }),
    ).toEqual({ opaque: true });
    expect(toChatMessages({ messages: [{ content: "no role" }] })).toEqual({ opaque: true });
    expect(toChatMessages({ messages: [{ role: "user", content: 42 }] })).toEqual({ opaque: true });
    expect(toChatMessages({ messages: [null] })).toEqual({ opaque: true });
  });

  it("returns empty when nothing routable was said", () => {
    expect(toChatMessages({ messages: [] })).toEqual({});
    expect(toChatMessages({})).toEqual({});
  });
});

describe("parseDecision", () => {
  const roster = ["read"];
  it("accepts verified in-roster selections", () => {
    expect(parseDecision({ mode: "forced", tool: "read", confidence: 0.9 }, roster)).toEqual({
      tool: "read",
      confidence: 0.9,
      mode: "forced",
    });
  });

  it("rejects unknown tools, bad modes, and unverified confidence", () => {
    expect(parseDecision({ mode: "forced", tool: "rm", confidence: 0.9 }, roster)).toEqual({ error: "decision_unknown_tool" });
    expect(parseDecision({ mode: "forced", tool: "", confidence: 0.9 }, roster)).toEqual({ error: "decision_unknown_tool" });
    expect(parseDecision({ mode: "whatever", tool: "read", confidence: 0.9 }, roster)).toEqual({ error: "decision_whatever" });
    expect(parseDecision(null, roster)).toEqual({ error: "decision_malformed" });
    for (const confidence of [undefined, -0.1, 1.1, NaN, Infinity, "0.9"]) {
      expect(parseDecision({ mode: "forced", tool: "read", confidence }, roster)).toEqual({ error: "decision_unverified" });
    }
  });
});

describe("applyJevHint conversation", () => {
  function eventWith(system: Array<{ type: string; text?: string }>): HintEvent {
    return {
      tools: { read: { description: "r", input: {} } },
      model,
      system,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "tool-call", id: "c9", name: "read", input: { path: "a" } }] },
        { role: "tool", content: [{ type: "tool-result", id: "c9", name: "read", result: { type: "text", value: "v" } }] },
        { role: "user", content: "again" },
      ],
    };
  }

  it("sends the preserved conversation with the real model label", async () => {
    let sent: any;
    const fetch = vi.fn().mockImplementation((_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ mode: "forced", tool: "read", confidence: 0.9 }) });
    });
    const system: Array<{ type: string; text?: string }> = [{ type: "text", text: "Sys." }];
    const out = await applyJevHint(eventWith(system), config, fetch);
    expect(out).toEqual({ applied: true, reason: "forced", tool: "read" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent.model).toBe("p/m");
    expect(sent.messages.map((m: any) => [m.role, m.content ?? m.tool_calls?.length ?? m.tool_call_id])).toEqual([
      ["system", "Sys."],
      ["user", "first"],
      ["assistant", 1],
      ["tool", "v"],
      ["user", "again"],
    ]);
    expect(system).toHaveLength(2);
    expect(system[1]!.text).toContain("[jev-routing]");
  });

  it("skips multimodal without calling, and leaves malformed models alone", async () => {
    const fetch = decideWith({ mode: "forced", tool: "read", confidence: 0.9 });
    const shot = eventWith([]);
    shot.messages = [{ role: "user", content: [{ type: "image_url" }] }];
    expect((await applyJevHint(shot, config, fetch)).reason).toBe("multimodal");
    const badModel = eventWith([]);
    badModel.model = { providerID: "", id: "m" };
    expect((await applyJevHint(badModel, config, fetch)).reason).toBe("malformed_model");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never sends screenshot-bearing history: zero fetches at the boundary", async () => {
    const fetch = decideWith({ mode: "forced", tool: "read", confidence: 0.99 });
    const system: Array<{ type: "text"; text?: string }> = [];
    const event: HintEvent = {
      tools: { read: { description: "r", input: {} } },
      model,
      system,
      messages: [
        { role: "user", content: "look at this" },
        { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "shot", input: {} }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "c1",
              name: "shot",
              result: { type: "content", value: [{ type: "text", text: "screenshot" }, { type: "file", uri: "f", mime: "i/png" }] },
            },
          ],
        },
        { role: "user", content: "what do you see" },
      ],
    };
    expect((await applyJevHint(event, config, fetch)).reason).toBe("multimodal");
    expect(fetch).not.toHaveBeenCalled();
    expect(system).toHaveLength(0);
  });

  it("fails open on gateway errors", async () => {
    const system: Array<{ type: string; text?: string }> = [];
    const event = { tools: { t: {} }, model, messages: [{ role: "user", content: "hi" }], system };
    expect((await applyJevHint(event, config, decideWith({}, 500))).reason).toBe("gateway_http_500");
    expect((await applyJevHint(event, config, vi.fn().mockRejectedValue(new Error("down")))).reason).toBe(
      "gateway_unreachable",
    );
    expect(system).toHaveLength(0);
  });
});

describe("plugin definition", () => {
  it("registers exactly one context hook and honors enabled:false", async () => {
    const hooks: Array<{ name: string; fn: (event: never) => Promise<void> }> = [];
    const hook = vi.fn().mockImplementation(async (name: string, fn: never) => {
      hooks.push({ name, fn: fn as never });
      return { dispose: vi.fn() };
    });
    await plugin.setup({ options: {}, session: { hook } } as never);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith("context", expect.any(Function));
    expect(hooks).toHaveLength(1);

    const hook2 = vi.fn();
    await plugin.setup({ options: { enabled: false }, session: { hook: hook2 } } as never);
    expect(hook2).not.toHaveBeenCalled();
  });

  it("rejects invalid explicit configuration at load time", async () => {
    const hook = vi.fn();
    await expect(plugin.setup({ options: { gatewayUrl: "not-a-url" }, session: { hook } } as never)).rejects.toThrow(
      /gatewayUrl/,
    );
    await expect(
      plugin.setup({ options: { gatewayUrl: "ftp://x/y", timeoutMs: 100 }, session: { hook } } as never),
    ).rejects.toThrow(/http/);
    await expect(plugin.setup({ options: { timeoutMs: -5 }, session: { hook } } as never)).rejects.toThrow(/timeoutMs/);
    await expect(plugin.setup({ options: { bogus: true }, session: { hook } } as never)).rejects.toThrow(
      /unknown option/,
    );
    expect(hook).not.toHaveBeenCalled();
  });

  it("never lets hook errors escape", async () => {
    let fn!: (event: never) => Promise<void>;
    await plugin.setup({
      options: { gatewayUrl: "http://127.0.0.1:9", timeoutMs: 5 },
      session: { hook: vi.fn().mockImplementation(async (_n: string, f: never) => void (fn = f)) },
    } as never);
    await expect(fn({ tools: { t: {} }, messages: [{ role: "user", content: "hi" }] } as never)).resolves
      .toBeUndefined();
  });
});
