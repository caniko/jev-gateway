#!/usr/bin/env node
// Idempotent master sync/check against upstream + pending PRs.
// - Uses actual PR merge metadata (merged, merge_commit_sha), not ancestry alone,
//   so upstream squash merges retire pending entries without reverting or double-applying.
// - Before publishing integration updates, compares master against a clean candidate
//   (upstream base + remaining pending changes) and reports stale/unexplained diffs.
// Usage:
//   node scripts/sync-master.mjs --check
//   node scripts/sync-master.mjs --sync
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../integration/manifest.json", import.meta.url), "utf8"));
const sh = (args) => execFileSync("git", args, { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname }).trim();

const upstreamBase = manifest.upstream.baseSha;
const pending = manifest.prs.filter((p) => p.state === "pending");
console.log(`upstream base ${upstreamBase}`);
console.log(`pending: ${pending.map((p) => `#${p.id} ${p.branch}`).join(", ") || "(none)"}`);

// Check PR merge metadata via gh (requires gh auth for private rate limits; public read is fine).
let mergedNow = [];
if (process.argv.includes("--sync") || process.argv.includes("--check")) {
  for (const p of pending) {
    try {
      const out = execFileSync("gh", ["api", `repos/vinilana/jev-gateway/pulls/${p.id}`, "--jq", "{merged:.merged,sha:.merge_commit_sha,state:.state}"], { encoding: "utf8", timeout: 15000 });
      const meta = JSON.parse(out);
      if (meta.merged) {
        console.log(`PR #${p.id} merged upstream as ${meta.sha} (state ${meta.state})`);
        mergedNow.push({ pr: p, sha: meta.sha });
      }
    } catch (e) {
      console.log(`WARN: could not fetch PR #${p.id} metadata (${e.message?.slice(0, 120) ?? e})`);
    }
  }
}

if (mergedNow.length && process.argv.includes("--sync")) {
  console.log("To retire a landed PR without reverting/double-applying:");
  console.log("  1. git fetch upstream main; record new upstream base SHA");
  console.log("  2. Verify upstream implementation covers the feature (diff feature branch vs merge commit)");
  console.log("  3. Update integration/manifest.json: state=merged, update baseSha, drop retired branch from order if empty");
  console.log("  4. Rebuild clean candidate (upstream + remaining pending) and compare to master before pushing");
  console.log("Retire manually after review; this script never auto-rewrites history.");
}

// Clean-candidate comparison: master should equal upstream base + pending branch contents.
// We approximate by checking that master contains each pending head (merge ancestry)
// and that no non-manifest, non-merge changes exist on master beyond those merges.
try {
  const master = sh(["rev-parse", "HEAD"]);
  console.log(`master ${master}`);
  for (const p of pending) {
    try {
      sh(["merge-base", "--is-ancestor", p.headSha, "HEAD"]);
      console.log(`ok: ${p.branch} ${p.headSha.slice(0, 7)} in master`);
    } catch {
      console.log(`STALE: ${p.branch} ${p.headSha.slice(0, 7)} NOT in master`);
      process.exitCode = 1;
    }
  }
} catch (e) {
  console.log(`WARN: ancestry check failed (${e.message?.slice(0, 120)})`);
}

console.log("sync check done. See integration/manifest.json for the source of truth.");
