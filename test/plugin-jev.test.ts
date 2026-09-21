import { describe, expect, it, vi } from "vitest";
import plugin, { applyJevHint, extractUserText } from "../plugin/jev/index.js";

const config = { gatewayUrl: "http://127.0.0.1:9", timeoutMs: 50 };

function decideWith(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

describe("extractUserText", () => {
  it("reads plain and part-wrapped user text", () => {
    expect(extractUserText([{ role: "user", content: "hi" }])).toEqual({ text: "hi" });
    expect(extractUserText([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toEqual({ text: "hi" });
    expect(extractUserText([{ role: "user", content: "" }])).toEqual({});
    expect(extractUserText([])).toEqual({});
  });

  it("treats image, file, and unknown parts as opaque", () => {
    expect(
      extractUserText([{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: {} }] }]),
    ).toEqual({ opaque: true });
    expect(extractUserText([{ role: "user", content: [{ type: "file", file: {} }] }])).toEqual({ opaque: true });
    expect(extractUserText([{ role: "user", content: [{}] }])).toEqual({ opaque: true });
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

  it("never lets hook errors escape", async () => {
    let fn!: (event: never) => Promise<void>;
    await plugin.setup({
      options: { gatewayUrl: "http://127.0.0.1:9", timeoutMs: 5 },
      session: { hook: vi.fn().mockImplementation(async (_n: string, f: never) => void (fn = f)) },
    } as never);
    await expect(fn({ tools: { t: {} }, messages: [{ role: "user", content: "hi" }] } as never)).resolves.toBeUndefined();
  });
});
