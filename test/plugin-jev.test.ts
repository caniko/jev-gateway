import { describe, expect, it, vi } from "vitest";
import plugin, { applyJevHint, toChatMessages } from "../plugin/jev/index.js";

const config = { gatewayUrl: "http://127.0.0.1:9", timeoutMs: 50 };

function decideWith(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

describe("toChatMessages", () => {
  it("preserves system, every text turn, and call/result association", () => {
    const out = toChatMessages({
      system: [{ type: "text", text: "Be brief." }],
      messages: [
        { role: "user", content: "inspect it" },
        {
          role: "assistant",
          content: [{ type: "tool-call", id: "c1", name: "inspect", input: { id: "a" } }],
        },
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

  it("returns opaque for images, files, and unknown parts instead of chopping", () => {
    expect(
      toChatMessages({ messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url" }] }] }),
    ).toEqual({ opaque: true });
    expect(toChatMessages({ messages: [{ role: "user", content: [{ type: "file" }] }] })).toEqual({ opaque: true });
    expect(toChatMessages({ messages: [{ role: "user", content: [{}] }] })).toEqual({ opaque: true });
    expect(
      toChatMessages({
        messages: [
          { role: "user", content: "fine" },
          { role: "assistant", content: [{ type: "tool-call", id: "c1" }] },
        ],
      }),
    ).toEqual({ opaque: true });
  });

  it("returns empty when nothing routable was said", () => {
    expect(toChatMessages({ messages: [] })).toEqual({});
    expect(toChatMessages({})).toEqual({});
  });
});

describe("applyJevHint", () => {
  it("appends a hint on confident selection and nothing otherwise", async () => {
    const system: Array<{ type: string; text?: string }> = [];
    const event = {
      tools: { read: { description: "r", input: { type: "object", properties: {} } } },
      messages: [{ role: "user", content: "hi" }],
      system,
    };
    const out = await applyJevHint(event, config, decideWith({ mode: "forced", tool: "read", confidence: 0.9 }));
    expect(out).toEqual({ applied: true, reason: "forced", tool: "read" });
    expect(system).toHaveLength(1);
    expect(system[0]!.text).toContain('"read"');

    const system2: Array<{ type: string; text?: string }> = [];
    const out2 = await applyJevHint(
      { ...event, system: system2 },
      config,
      decideWith({ mode: "passthrough", reason: "x" }),
    );
    expect(out2.applied).toBe(false);
    expect(system2).toHaveLength(0);
  });

  it("rejects decisions naming tools outside the captured roster", async () => {
    const system: Array<{ type: string; text?: string }> = [];
    const event = {
      tools: { read: { description: "r", input: {} } },
      messages: [{ role: "user", content: "hi" }],
      system,
    };
    for (const tool of ["rm -rf /", "", undefined, 42]) {
      const out = await applyJevHint(event, config, decideWith({ mode: "forced", tool, confidence: 0.99 }));
      expect(out.applied).toBe(false);
    }
    expect(system).toHaveLength(0);
  });

  it("rejects malformed decisions and non-finite confidence text", async () => {
    const system: Array<{ type: string; text?: string }> = [];
    const event = {
      tools: { read: { description: "r", input: {} } },
      messages: [{ role: "user", content: "hi" }],
      system,
    };
    expect((await applyJevHint(event, config, decideWith(null))).applied).toBe(false);
    expect((await applyJevHint(event, config, decideWith({}))).applied).toBe(false);
    const out = await applyJevHint(event, config, decideWith({ mode: "forced", tool: "read", confidence: NaN }));
    expect(out.applied).toBe(true);
    expect(system[0]!.text).toContain("n/a");
    expect(system).toHaveLength(1);
  });

  it("skips without tools, text, or on opaque content — and never throws", async () => {
    const fetch = decideWith({ mode: "direct", tool: "t", confidence: 1 });
    expect((await applyJevHint({ tools: {}, messages: [] }, config, fetch)).reason).toBe("no_tools");
    expect(
      (await applyJevHint({ tools: { t: {} }, messages: [{ role: "user", content: [{ type: "image_url" }] }] }, config, fetch))
        .reason,
    ).toBe("multimodal");
    expect((await applyJevHint({ tools: { t: {} }, messages: [] }, config, fetch)).reason).toBe("no_text");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails open on gateway errors", async () => {
    const system: Array<{ type: string; text?: string }> = [];
    const event = { tools: { t: {} }, messages: [{ role: "user", content: "hi" }], system };
    expect((await applyJevHint(event, config, decideWith({}, 500))).reason).toBe("gateway_http_500");
    expect((await applyJevHint(event, config, vi.fn().mockRejectedValue(new Error("down")))).reason).toBe(
      "gateway_unreachable",
    );
    expect(system).toHaveLength(0);
  });
});

describe("applyJevHint conversation", () => {
  it("sends the preserved conversation, not a fabricated fragment", async () => {
    let sent: any;
    const fetch = vi.fn().mockImplementation((_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ mode: "forced", tool: "read", confidence: 0.9 }) });
    });
    const system: Array<{ type: string; text?: string }> = [{ type: "text", text: "Sys." }];
    await applyJevHint(
      {
        tools: { read: { description: "r", input: {} } },
        system,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: [{ type: "tool-call", id: "c9", name: "read", input: { path: "a" } }] },
          { role: "tool", content: [{ type: "tool-result", id: "c9", name: "read", result: { type: "text", value: "v" } }] },
          { role: "user", content: "again" },
        ],
      } as never,
      config,
      fetch,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent.messages.map((m: any) => [m.role, m.content ?? m.tool_calls?.length ?? m.tool_call_id])).toEqual([
      ["system", "Sys."],
      ["user", "first"],
      ["assistant", 1],
      ["tool", "v"],
      ["user", "again"],
    ]);
    expect(sent.messages[2].tool_calls[0]).toMatchObject({ id: "c9", function: { name: "read" } });
    expect(sent.messages[3]).toMatchObject({ tool_call_id: "c9" });
    expect(system).toHaveLength(2);
    expect(system[1]!.text).toContain("[jev-routing]");
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
    await expect(
      plugin.setup({ options: { timeoutMs: -5 }, session: { hook } } as never),
    ).rejects.toThrow(/timeoutMs/);
    await expect(
      plugin.setup({ options: { bogus: true }, session: { hook } } as never),
    ).rejects.toThrow(/unknown option/);
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
