import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error: qualification helpers are plain JavaScript.
import { waitFor } from "./readiness.mjs";
// @ts-expect-error: qualification helpers are plain JavaScript.
import { hermeticEnv } from "./environment.mjs";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("bounded polling", () => {
  it("awaits false async results and stops after the first true result", async () => {
    let calls = 0;
    const pending = waitFor(async () => ++calls === 3, 3000, "ready");
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(calls).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces its deadline even if a predicate never settles", async () => {
    let signal: AbortSignal | undefined;
    const pending = waitFor((value: AbortSignal) => { signal = value; return new Promise(() => {}); }, 100, "stuck");
    const assertion = expect(pending).rejects.toThrow("timeout waiting for stuck");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels cooperative in-flight work rather than leaving a timeout race running", async () => {
    let active = 0;
    const pending = waitFor((signal: AbortSignal) => new Promise((_resolve, reject) => {
      active++;
      signal.addEventListener("abort", () => { active--; reject(signal.reason); }, { once: true });
    }), 100, "request");
    const assertion = expect(pending).rejects.toThrow("timeout waiting for request");
    expect(active).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not inherit routing, debugging, provider credentials, or personal configuration", () => {
    for (const key of ["JEV_ON_NONE", "JEV_DEBUG_DUMP_DIR", "ANTHROPIC_API_KEY", "OPENCODE_CONFIG_CONTENT", "NODE_OPTIONS", "NPM_CONFIG_USERCONFIG"]) {
      vi.stubEnv(key, "parent-only");
    }
    const iso = { home: "/fixture/home", config: "/fixture/config", data: "/fixture/data", cache: "/fixture/cache", state: "/fixture/state" };
    const env = hermeticEnv(iso);
    expect(Object.values(env)).not.toContain("parent-only");
    expect(env.HOME).toBe(iso.home);
    expect(env.XDG_CONFIG_HOME).toBe(iso.config);
  });
});
