import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { caseCollisions, parsePolicyConfig, policyFor } from "../src/policies.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

describe("policy collisions and cache", () => {
  it("finds folded names with more than one spelling", () => {
    expect(caseCollisions(["Read", "read"])).toEqual(new Set(["read"]));
    expect(caseCollisions(["Read", "Read"])).toEqual(new Set());
    expect(caseCollisions([])).toEqual(new Set());
    expect(caseCollisions(["a", "B", "A", "b", "c"])).toEqual(new Set(["a", "b"]));
  });

  it("agrees between precomputed collisions and inline rosters across churn", () => {
    const config = parsePolicyConfig({ default: "direct-eligible",
      rules: [{ match: "fixture_*", policy: "selection-only" }, { match: "f*", policy: "passthrough" }] });
    const rosters = [
      ["Read", "read", "fixture_status", "other"],
      ["read", "other", "Read", "fixture_status"],
      ["other", "fixture_status"],
      ["Read", "read"],
      ["Read", "Read", "other"],
    ];
    for (const roster of rosters) {
      const collisions = caseCollisions(roster);
      for (const name of [...roster, "absent"]) {
        expect(policyFor(name, config, collisions), `${name} in ${roster}`).toBe(policyFor(name, config, roster));
      }
    }
    expect(policyFor("Read", config, ["Read", "read"])).toBe("passthrough");
    expect(policyFor("fixture_status", config, ["Read", "read"])).toBe("selection-only");
    expect(policyFor("other", config, ["Read", "read"])).toBe("direct-eligible");
    expect(policyFor("Read", config, [])).toBe("direct-eligible");
  });

  it("memoizes rule answers per config with a bounded cache", () => {
    const config = parsePolicyConfig({ default: "direct-eligible", rules: [{ match: "a*", policy: "selection-only" }] });
    expect(config.cache.size).toBe(0);
    expect(policyFor("apple", config)).toBe("selection-only");
    expect(policyFor("apple", config)).toBe("selection-only");
    expect(config.cache.size).toBe(1);
    expect(policyFor("banana", config)).toBe("direct-eligible");
    expect(config.cache.size).toBe(2);
    for (let i = 0; i < 600; i++) policyFor(`tool_${i}`, config);
    expect(config.cache.size).toBe(512);
    // Evicted or not, the answer is recomputed identically.
    expect(policyFor("apple", config)).toBe("selection-only");
    expect(policyFor("banana", config)).toBe("direct-eligible");
  });

  it("isolates caches across parsed configurations", () => {
    const first = parsePolicyConfig({ default: "passthrough", rules: [{ match: "a*", policy: "selection-only" }] });
    const second = parsePolicyConfig({ default: "direct-eligible", rules: [] });
    expect(policyFor("apple", first)).toBe("selection-only");
    expect(policyFor("apple", second)).toBe("direct-eligible");
    expect(policyFor("apple", first)).toBe("selection-only");
    expect(first.cache).not.toBe(second.cache);
  });

  it("keeps full-roster collisions visible after shortlisting drops a sibling", async () => {
    const names = Array.from({ length: 121 }, (_, i) => `tool_${i}`);
    names[0] = "Read";
    names[61] = "read";
    // 121 tools form two shards of 61; each shard keeps only its canned pick.
    const toolPolicies = parsePolicyConfig({ default: "direct-eligible", rules: [{ match: "zzz*", policy: "selection-only" }] });
    const jev = fakeJev({
      "shard:0": { choice: "Read" },
      "shard:1": { choice: "tool_62" },
      tool: { choice: "Read" },
      needs_tool: { noul: 0.99 },
    });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig({ toolPolicies }), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const body = { model: "m", stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools: names.map((name) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } })),
    };
    const res = await app.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe("tool_policy_passthrough");
    // Shortlist plus the decision: the collision came from the full roster, not the shortlist.
    expect(jev.requests).toHaveLength(2);
  });
});
