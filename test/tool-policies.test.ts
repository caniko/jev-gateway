import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { parsePolicyConfig, policyFor } from "../src/policies.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

describe("tool policies", () => {
  it("uses exact names, specificity, restrictive ties, and collision protection", () => {
    const config = parsePolicyConfig({ default: "passthrough", rules: [
      { match: "f*", policy: "direct-eligible" }, { match: "fixture_*", policy: "selection-only" },
      { match: "FIXTURE_STATUS", policy: "direct-eligible" }, { match: "fixture_????", policy: "passthrough" },
    ] });
    expect(policyFor("fixture_status", config)).toBe("direct-eligible");
    expect(policyFor("fixture_other", config)).toBe("selection-only");
    expect(policyFor("fixture_mode", config)).toBe("passthrough");
    expect(policyFor("unknown_safe", config)).toBe("passthrough");
    expect(policyFor("fixture_status", config, ["fixture_status", "Fixture_Status"])).toBe("passthrough");
    expect(policyFor("𐐀", parsePolicyConfig({ rules: [{ match: "?", policy: "selection-only" }] }))).toBe("selection-only");
    expect(policyFor("anything", parsePolicyConfig(undefined))).toBe("direct-eligible");
    expect(policyFor("anything", parsePolicyConfig(""))).toBe("direct-eligible");
  });

  it.each(["nope", "null", '{"defualt":"passthrough"}', '{"default":"typo"}', '{"rules":[{"match":"*","policy":"typo"}]}'])
    ("names JEV_TOOL_POLICIES and the invalid value in startup errors: %s", (raw) => {
      expect(() => parsePolicyConfig(raw)).toThrow("JEV_TOOL_POLICIES");
      expect(() => parsePolicyConfig(raw)).toThrow(JSON.stringify(raw));
    });

  it("finishes adversarial wildcard matches in a deadline-bounded subprocess", () => {
    const url = new URL("../src/policies.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {parsePolicyConfig, policyFor} from ${JSON.stringify(url)};
      for (const pattern of ['*a*a*a*a*b', '*a*a*a*a*a*a*a*a*b', '*?*?*?*?*b']) {
        const config = parsePolicyConfig({ default:'passthrough', rules:[{match:pattern,policy:'selection-only'}] });
        for (let i=0; i<100; i++) assert.equal(policyFor('a'.repeat(128), config), 'passthrough');
      }
      console.log('completed');
    `], { timeout: 5_000, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("completed");
  });

  const parameters = { type: "object", properties: {} };
  async function route(policy: string, choice: string, messages = false, mixed = false, directCalls = true) {
    const toolPolicies = parsePolicyConfig({ default: "passthrough", rules: [{ match: "fixture_status", policy }] });
    const jev = fakeJev({ tool: { choice }, needs_tool: { noul: choice === "no_tool_needed" ? 0.01 : 0.99 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig({ toolPolicies, directCalls }), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const names = mixed ? ["fixture_status", "unknown_safe"] : ["fixture_status"];
    const body = { model: "m", stream: true,
      messages: [{ role: "user", content: "check status" }],
      ...(messages ? { thinking: { type: "enabled", budget_tokens: 1024 } } : {}),
      tools: names.map((name) => messages ? { name, input_schema: parameters }
        : { type: "function", function: { name, parameters } }),
    };
    const res = await app.request(messages ? "/v1/messages" : "/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { mode: res.headers.get("x-jev-gateway-mode"), reason: res.headers.get("x-jev-gateway-reason"), body, jev, upstream };
  }

  it.each([false, true])("does not suppress passthrough tools when Jev chooses none (mixed=%s)", async (mixed) => {
    const result = await route(mixed ? "selection-only" : "passthrough", "no_tool_needed", false, mixed);
    expect(result.mode).toBe("passthrough");
    expect(result.reason).toBe("tool_policy_passthrough");
    expect(result.jev.requests).toHaveLength(1);
    expect(result.upstream.calls[0]!.body).toEqual(result.body);
  });

  it("applies default passthrough to a safe unknown name that reaches policy evaluation", async () => {
    const result = await route("selection-only", "unknown_safe", false, true);
    expect(result.jev.requests).toHaveLength(1);
    expect(result.reason).toBe("tool_policy_passthrough");
    expect(result.upstream.calls[0]!.body).toEqual(result.body);
  });

  it.each(["passthrough", "selection-only"])("honours %s in Messages hint mode", async (policy) => {
    const result = await route(policy, "fixture_status", true);
    expect(result.mode).toBe(policy === "passthrough" ? "passthrough" : "hint");
    expect(result.jev.requests).toHaveLength(1);
    expect(result.upstream.calls[0]!.body.tools).toEqual(result.body.tools);
    expect(result.upstream.calls[0]!.body.tool_choice).toBeUndefined();
    if (policy === "passthrough") expect(result.upstream.calls[0]!.body).toEqual(result.body);
    else expect(JSON.stringify(result.upstream.calls[0]!.body.messages)).toContain("fixture_status");
  });

  it("allows direct mode only when the policy and global switch both permit it", async () => {
    expect((await route("direct-eligible", "fixture_status")).mode).toBe("direct");
    expect((await route("direct-eligible", "fixture_status", false, false, false)).mode).toBe("forced");
    expect((await route("selection-only", "fixture_status")).mode).toBe("forced");
  });
});
