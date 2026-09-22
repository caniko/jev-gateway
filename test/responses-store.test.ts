import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

it.each([false, true, undefined])("only synthesizes explicitly unstored Responses (store=%s)", async (store) => {
  for (const stream of [false, true]) {
    const jev = fakeJev({ tool: { choice: "status" }, needs_tool: { noul: 0.99 } });
    const upstream = fakeUpstream({ id: "resp_provider" });
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const body = { model: "m", input: "status", ...(store === undefined ? {} : { store }), stream,
      tools: [{ type: "function", name: "status", parameters: { type: "object", properties: {} } }] };
    const post = (request: unknown) => app.request("/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    const response = await post(body);
    expect(response.headers.get("x-jev-gateway-mode")).toBe(store === false ? "direct" : "forced");
    expect(upstream.calls).toHaveLength(store === false ? 0 : 1);
    let id = "resp_provider";
    if (store === false) {
      const text = await response.text();
      const payload = stream ? text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))
        .find((event) => event.type === "response.completed").response : JSON.parse(text);
      expect(payload.store).toBe(false);
      expect(payload.previous_response_id).toBeNull();
      expect(payload.id).toMatch(/^resp_jev_/);
      id = payload.id;
    }
    const chained = { ...body, previous_response_id: id };
    const next = await post(chained);
    expect(next.headers.get("x-jev-gateway-reason")).toBe("previous_response_id");
    expect(jev.requests).toHaveLength(1);
    expect(upstream.calls.at(-1)!.body).toEqual(chained);
  }
});
