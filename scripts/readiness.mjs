#!/usr/bin/env node
// Readiness polling shared by the acceptance harness. The predicate may be
// sync or async; either way it is awaited, so an async predicate resolving
// to false never counts as ready (a bare truthiness check would accept the
// Promise object itself).
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}
