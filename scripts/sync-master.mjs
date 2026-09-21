#!/usr/bin/env node
// Idempotent master sync/check against upstream + pending PRs.
//
// What it does:
// - Fetches upstream/main and every pending feature branch.
// - Reads actual PR merge metadata (merged, merge_commit_sha, head sha) via
//   gh, so upstream squash merges retire pending entries by record — never
//   by ancestry alone, never by reverting the feature or applying it twice.
// - Assembles a clean candidate worktree: fetched upstream/main + merges of
//   the remaining pending branches in manifest order. A conflict while
//   merging is a CONFLICT failure, not a silent skip.
// - Compares the candidate tree against master, excluding exactly the
//   manifest's downstreamOnly paths. Any other difference is STALE or
//   unexplained and fails.
// - Detects stale heads (manifest headSha != fetched branch head after
//   follow-up commits) and missing metadata (gh failure fails, never warns
//   through).
// - --sync additionally retires landed PRs in the manifest (state=merged,
//   mergedSha, baseSha advanced to fetched upstream/main). It never rewrites
//   branch history; reintegration stays an explicit merge.
// - Repeated runs are idempotent: same inputs, same verdict.
//
// Usage: node scripts/sync-master.mjs --check [--manifest PATH]
//        node scripts/sync-master.mjs --sync [--manifest PATH]
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const SYNC = argv.includes("--sync");
const manifestIdx = argv.indexOf("--manifest");
const MANIFEST = manifestIdx >= 0 ? argv[manifestIdx + 1] : join(ROOT_OF(), "integration/manifest.json");
function ROOT_OF() {
  return join(new URL(".", import.meta.url).pathname, "..");
}
const ROOT = ROOT_OF();

let failures = 0;
const ok = (m) => console.log(`ok: ${m}`);
const bad = (m) => { failures++; console.log(`FAIL: ${m}`); };
const info = (m) => console.log(`info: ${m}`);

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", cwd: ROOT, ...opts }).trim();
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const UPSTREAM = `https://github.com/${manifest.upstream.repo}.git`;
const MAIN = manifest.upstream.defaultBranch;
const downstreamOnly = manifest.downstreamOnly ?? ["integration/", "scripts/sync-master.mjs", ".github/workflows/integration.yml"];

// 1. fetch -----------------------------------------------------------------
try {
  git(["fetch", "origin"]);
  git(["fetch", UPSTREAM, `${MAIN}:refs/remotes/sync-upstream/${MAIN}`, "--update-head-ok"]);
} catch (e) {
  bad(`fetch failed: ${String(e.message).slice(0, 200)}`);
  process.exit(1);
}
const upstreamHead = git(["rev-parse", `refs/remotes/sync-upstream/${MAIN}`]);
info(`upstream ${MAIN} = ${upstreamHead.slice(0, 12)} (manifest base ${manifest.upstream.baseSha.slice(0, 12)})`);

// 2. PR metadata (required; failure fails) ----------------------------------
const prMeta = new Map();
for (const p of manifest.prs) {
  let meta;
  try {
    const out = execFileSync("gh", ["api", `repos/${manifest.upstream.repo}/pulls/${p.id}`, "--jq",
      "{merged:.merged,sha:.merge_commit_sha,state:.state,head:.head.sha}"], { encoding: "utf8", timeout: 20000 });
    meta = JSON.parse(out);
  } catch (e) {
    bad(`PR #${p.id}: merge metadata unavailable (${String(e.message).slice(0, 120)})`);
    continue;
  }
  prMeta.set(p.id, meta);
  info(`PR #${p.id} ${p.branch}: state=${meta.state} merged=${meta.merged} head=${String(meta.head).slice(0, 12)}`);
}
if (failures) process.exit(1);

// 3. fetch pending branch heads + stale-head detection -----------------------
const pending = manifest.prs.filter((p) => p.state === "pending");
for (const p of pending) {
  try {
    git(["fetch", "origin", `${p.branch}:refs/remotes/sync-origin/${p.branch.replaceAll("/", "_")}`, "--update-head-ok"]);
  } catch (e) {
    bad(`PR #${p.id}: cannot fetch branch ${p.branch}`);
    continue;
  }
  const fetched = git(["rev-parse", `refs/remotes/sync-origin/${p.branch.replaceAll("/", "_")}`]);
  p._fetched = fetched;
  const meta = prMeta.get(p.id);
  if (meta && meta.head && meta.head !== fetched) {
    // Follow-up commits exist that the manifest does not record.
    bad(`PR #${p.id}: STALE-HEAD manifest=${p.headSha.slice(0, 12)} fetched=${fetched.slice(0, 12)} upstream-head=${String(meta.head).slice(0, 12)}`);
  } else if (p.headSha !== fetched) {
    bad(`PR #${p.id}: STALE-HEAD manifest=${p.headSha.slice(0, 12)} fetched=${fetched.slice(0, 12)}`);
  } else {
    ok(`PR #${p.id}: head ${fetched.slice(0, 12)} matches manifest`);
  }
}
if (failures) process.exit(1);

// 4. retire landed PRs (--sync: manifest only, no history rewrite) ----------
const landed = pending.filter((p) => prMeta.get(p.id)?.merged);
if (SYNC && landed.length) {
  for (const p of landed) {
    p.state = "merged";
    p.mergedSha = prMeta.get(p.id).sha;
  }
  manifest.upstream.baseSha = upstreamHead;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  info(`retired ${landed.map((p) => `#${p.id}`).join(", ")}; base advanced to ${upstreamHead.slice(0, 12)}`);
  info("reintegration of remaining branches stays an explicit merge; history untouched");
}
const remaining = manifest.prs.filter((p) => p.state === "pending");

// 5. clean candidate: upstream + remaining merges in manifest order ----------
const candidate = mkdtempSync(join(tmpdir(), "jev-candidate-"));
try {
  execSync(`git worktree add --detach ${candidate} ${upstreamHead}`, { cwd: ROOT, stdio: "pipe" });
  const ordered = [...remaining].sort(
    (a, b) => manifest.order.indexOf(a.branch) - manifest.order.indexOf(b.branch),
  );
  for (const p of ordered) {
    try {
      execFileSync("git", ["merge", "--no-ff", "--no-commit", p._fetched], { cwd: candidate, encoding: "utf8", stdio: "pipe" });
      execFileSync("git", ["commit", "--no-edit", "-m", `sync-candidate: merge ${p.branch}`], { cwd: candidate, encoding: "utf8", stdio: "pipe" });
      ok(`candidate merged ${p.branch}`);
    } catch (e) {
      execFileSync("git", ["merge", "--abort"], { cwd: candidate, stdio: "pipe" });
      bad(`PR #${p.id}: CONFLICT merging ${p.branch} onto ${upstreamHead.slice(0, 12)}`);
    }
  }
  if (failures) process.exit(1);

  // 6. compare candidate vs master outside downstream-only paths --------------
  const master = git(["rev-parse", "HEAD"]);
  const excludes = downstreamOnly.map((p) => `':!${p}'`);
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", "--name-only", master, "HEAD", "--", ".", ...excludes], { cwd: candidate, encoding: "utf8" }).trim();
  } catch (e) {
    bad(`tree comparison failed: ${String(e.message).slice(0, 160)}`);
    process.exit(1);
  }
  if (diff) {
    bad(`master differs from clean candidate outside downstream-only paths:\n${diff}`);
  } else {
    ok(`master matches candidate (upstream ${upstreamHead.slice(0, 12)} + ${ordered.length} pending) outside ${downstreamOnly.length} downstream-only paths`);
  }

  // 7. ancestry: every remaining head must be in master ------------------------
  for (const p of ordered) {
    try {
      git(["merge-base", "--is-ancestor", p._fetched, "HEAD"]);
      ok(`${p.branch} in master`);
    } catch {
      bad(`${p.branch} NOT in master`);
    }
  }
} finally {
  try { execSync(`git worktree remove --force ${candidate}`, { cwd: ROOT, stdio: "pipe" }); } catch {}
  try { execSync("git worktree prune", { cwd: ROOT, stdio: "pipe" }); } catch {}
}

console.log(failures ? `\nsync ${SYNC ? "sync" : "check"} FAILED (${failures})` : `\nsync ${SYNC ? "sync" : "check"} done: clean`);
process.exit(failures ? 1 : 0);
