import { describe, expect, it } from "vitest";
import { waitFor } from "../scripts/readiness.mjs";

describe("waitFor", () => {
  it("resolves on sync truthy predicates", async () => {
    let calls = 0;
    await waitFor(() => ++calls >= 2, 2000, "sync");
    expect(calls).toBe(2);
  });

  it("awaits async predicates: false never counts as ready", async () => {
    let calls = 0;
    await expect(waitFor(async () => (++calls >= 3 ? true : false), 3000, "async-false")).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("times out instead of accepting a pending Promise", async () => {
    const start = Date.now();
    await expect(waitFor(async () => false, 600, "never")).rejects.toThrow(/timeout waiting for never/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(500);
  });
});
