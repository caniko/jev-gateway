import { afterEach, expect, it, vi } from "vitest";
import plugin, { applyJevHint, type HintEvent } from "../plugin/jev/index.js";
import { createApp } from "../src/app.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

afterEach(() => vi.unstubAllEnvs());
const origin = "http://gateway.test";
const config = { gatewayUrl: origin, timeoutMs: 1000, gatewayApiKey: "gateway-only" };
const parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
const body = { model: "m", messages: [{ role: "user", content: "read" }], tools: [{ type: "function", function: { name: "read", parameters } }] };
const event = (): HintEvent => ({ model: { providerID: "native", id: "m" },
  system: [{ type: "text", text: "unchanged prefix" }], messages: structuredClone(body.messages), tools: { read: { input: parameters } } });

it("authorizes only the decision endpoint and fails open on missing credentials", async () => {
  const jev = fakeJev({ tool: { choice: "read" }, needs_tool: { noul: 0.99 } });
  const upstream = fakeUpstream();
  const app = createApp({ config: testConfig({ routerApiKey: "gateway-only", upstreamApiKey: "provider-only" }), askJev: jev.askJev, fetch: upstream.fetchImpl });
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`${origin}/router/decide`);
    expect(init?.redirect).toBe("error");
    expect(String(init?.body)).not.toContain("gateway-only");
    return app.request(String(url), init);
  });
  const good = event();
  expect((await applyJevHint(good, config, fetch)).applied).toBe(true);
  expect(jev.requests).toHaveLength(1);
  expect(upstream.calls).toHaveLength(0);
  expect(JSON.stringify(good)).not.toContain("gateway-only");
  const denied = event();
  const original = structuredClone(denied);
  expect((await applyJevHint(denied, { ...config, gatewayApiKey: undefined }, fetch)).reason).toBe("gateway_http_401");
  expect(denied).toEqual(original);
  expect((await applyJevHint(denied, config, vi.fn().mockRejectedValue(new Error("offline")))).reason).toBe("gateway_unreachable");
  expect(denied).toEqual(original);
});

it("makes one routing decision through the proxy and one through the advisory alternative", async () => {
  const jev = fakeJev({ tool: { choice: "read" }, needs_tool: { noul: 0.99 } });
  const upstream = fakeUpstream();
  const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
  await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(jev.requests).toHaveLength(1);
  const hooks = new Map<string, (input: any) => Promise<void>>();
  await plugin.setup({ options: { gatewayUrl: origin }, session: { hook: async (name: string, fn: any) => { hooks.set(name, fn); } } } as never);
  const advisory = event();
  await applyJevHint(advisory, { gatewayUrl: origin, timeoutMs: 1000 }, async (url, init) => app.request(String(url), init));
  expect(jev.requests).toHaveLength(2);
  const request = { request: new Request(`${origin}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) };
  await hooks.get("http.request")!(request);
  expect(request.request.headers.get("x-jev-gateway")).toBe("off");
  await app.request(request.request);
  expect(jev.requests).toHaveLength(2);
  expect(upstream.calls).toHaveLength(2);
  expect(upstream.calls[1]!.body).toEqual(body);
});

it("rejects enabling the advisory plugin under the proxy launcher", async () => {
  vi.stubEnv("JEV_OPENCODE_ROUTING_OWNER", "proxy");
  const hook = vi.fn();
  await expect(plugin.setup({ options: {}, session: { hook } } as never)).rejects.toThrow("launcher owns proxy routing");
  expect(hook).not.toHaveBeenCalled();
});
