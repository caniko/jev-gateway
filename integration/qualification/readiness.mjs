#!/usr/bin/env node
// Readiness polling shared by the acceptance harness. The predicate may be
// sync or async; either way it is awaited, so an async predicate resolving
// to false never counts as ready (a bare truthiness check would accept the
// Promise object itself).
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal.reason); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Predicates performing IO must pass the supplied signal into that IO. */
export async function waitFor(fn, timeoutMs, label) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`timeout waiting for ${label}`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const poll = async () => {
    for (;;) {
      const ready = await fn(controller.signal);
      controller.signal.throwIfAborted();
      if (ready) return;
      await sleep(250, controller.signal);
    }
  };
  try { await Promise.race([poll(), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}
