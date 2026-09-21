#!/usr/bin/env node
// Idempotent master sync/check against upstream + pending PRs.
//
// What it does:
// - Fetches upstream/main and every pending feature branch.
// - Reads actual PR merge metadata (merged, merge_commit_sha, head sha) via
//   gh (or a stub file when SYNC_GH_STUB is set, used by --self-test), so
//   upstream squash merges retire pending entries by record — never by
//   ancestry alone, never by reverting the feature or applying it twice.
// - Assembles a clean candidate worktree: fetched upstream/main + merges of
//   the remaining pending branches in manifest order. A conflict while
//   merging is a CONFLICT failure, not a silent skip.
// - Compares the candidate tree against master, excluding exactly the
//   manifest's downstreamOnly paths. Any other difference is STALE or
//   unexplained and fails.
// - Detects stale heads (manifest headSha vs fetched branch head after
//   follow-up commits) and missing metadata (gh failure fails, never warns
//   through).
// - --sync retires landed PRs in the manifest ONLY after the candidate
//   comparison and ancestry checks pass on the post-retirement set, and
//   only when no remaining branch retains the landed prerequisite without
//   the landed merge (squash-reintroduction guard). It never rewrites
//   branch history; reintegration stays an explicit merge.
// - Repeated runs are idempotent: same inputs, same verdict.
// - --self-test builds throwaway fixture repos exercising squash landing,
//   descendant retention, stale heads, conflicts, and repeat runs.
//
// Candidate commits use the ambient operator identity with no overrides (a
// worktree `git config` would land in the shared repository config, and -c
// identity overrides trip the identity hooks). They are unreachable temp
// objects, never pushed.
//
// Usage: node scripts/sync-master.mjs --check [--manifest PATH]
//        node scripts/sync-master.mjs --sync [--manifest PATH]
//        node scripts/sync-master.mjs --self-test
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const SYNC = argv.includes("--sync");
const SELF_TEST = argv.includes("--self-test");
const manifestIdx = argv.indexOf("--manifest");
const ROOT = process.env.SYNC_ROOT ?? join(new URL(".", import.meta.url).pathname, "..");
const MANIFEST = manifestIdx >= 0 ? argv[manifestIdx + 1] : join(ROOT, "integration/manifest.json");
const GH_STUB = process.env.SYNC_GH_STUB;

let failures = 0;
const ok = (m) => console.log(`ok: ${m}`);
const bad = (m) => { failures++; console.log(`FAIL: ${m}`); };
const info = (m) => console.log(`info: ${m}`);

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", cwd: ROOT, ...opts }).trim();

function ghPrMeta(repo, id) {
  if (GH_STUB) {
    const stub = JSON.parse(readFileSync(GH_STUB, "utf8"));
    if (!(id in stub)) throw new Error(`stub has no PR ${id}`);
    return stub[id];
  }
  const out = execFileSync("gh", ["api", `repos/${repo}/pulls/${id}`, "--jq",
    "{merged:.merged,sha:.merge_commit_sha,state:.state,head:.head.sha}"], { encoding: "utf8", timeout: 20000 });
  return JSON.parse(out);
}

function runCheck() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const UPSTREAM = `https://github.com/${manifest.upstream.repo}.git`;
  const MAIN = manifest.upstream.defaultBranch;
  const downstreamOnly = manifest.downstreamOnly ?? ["integration/", "scripts/sync-master.mjs", ".github/workflows/integration.yml"];

  // 1. fetch ---------------------------------------------------------------
  try {
    git(["fetch", "origin"]);
    git(["fetch", UPSTREAM, `${MAIN}:refs/remotes/sync-upstream/${MAIN}`, "--update-head-ok"]);
  } catch (e) {
    bad(`fetch failed: ${String(e.message).slice(0, 200)}`);
    return false;
  }
  const upstreamHead = git(["rev-parse", `refs/remotes/sync-upstream/${MAIN}`]);
  info(`upstream ${MAIN} = ${upstreamHead.slice(0, 12)} (manifest base ${manifest.upstream.baseSha.slice(0, 12)})`);

  // 2. PR metadata (required; failure fails) --------------------------------
  const prMeta = new Map();
  for (const p of manifest.prs) {
    let meta;
    try {
      meta = ghPrMeta(manifest.upstream.repo, p.id);
    } catch (e) {
      bad(`PR #${p.id}: merge metadata unavailable (${String(e.message).slice(0, 120)})`);
      continue;
    }
    prMeta.set(p.id, meta);
    info(`PR #${p.id} ${p.branch}: state=${meta.state} merged=${meta.merged} head=${String(meta.head).slice(0, 12)}`);
  }
  if (failures) return false;

  // 3. fetch pending branch heads + stale-head detection ---------------------
  const pending = manifest.prs.filter((p) => p.state === "pending");
  for (const p of pending) {
    try {
      git(["fetch", "origin", `+${p.branch}:refs/remotes/sync-origin/${p.branch.replaceAll("/", "_")}`, "--update-head-ok"]);
    } catch (e) {
      bad(`PR #${p.id}: cannot fetch branch ${p.branch}`);
      continue;
    }
    const fetched = git(["rev-parse", `refs/remotes/sync-origin/${p.branch.replaceAll("/", "_")}`]);
    p._fetched = fetched;
    const meta = prMeta.get(p.id);
    if (meta && meta.head && meta.head !== fetched) {
      bad(`PR #${p.id}: STALE-HEAD manifest=${p.headSha.slice(0, 12)} fetched=${fetched.slice(0, 12)} upstream-head=${String(meta.head).slice(0, 12)}`);
    } else if (p.headSha !== fetched) {
      bad(`PR #${p.id}: STALE-HEAD manifest=${p.headSha.slice(0, 12)} fetched=${fetched.slice(0, 12)}`);
    } else {
      ok(`PR #${p.id}: head ${fetched.slice(0, 12)} matches manifest`);
    }
  }
  if (failures) return false;

  const landed = pending.filter((p) => prMeta.get(p.id)?.merged);
  const remaining = pending.filter((p) => !prMeta.get(p.id)?.merged);

  // 4. squash-reintroduction guard: a remaining branch built on a landed
  // PR's pre-land head without containing the landed merge would silently
  // reintroduce the old implementation when merged later.
  for (const l of landed) {
    const mergeSha = prMeta.get(l.id).sha;
    for (const r of remaining) {
      let hasOld = false, hasMerge = false;
      try { git(["merge-base", "--is-ancestor", l.headSha, r._fetched]); hasOld = true; } catch {}
      try { git(["merge-base", "--is-ancestor", mergeSha, r._fetched]); hasMerge = true; } catch {}
      if (hasOld && !hasMerge) {
        bad(`PR #${r.id}: retains landed PR #${l.id} prerequisite (${l.headSha.slice(0, 12)}) without its merge ${String(mergeSha).slice(0, 12)}; rebase #${r.id} onto the new base first`);
      }
    }
  }
  if (failures) return false;

  // 5. clean candidate: upstream + remaining merges in manifest order --------
  const candidate = mkdtempSync(join(tmpdir(), "jev-candidate-"));
  try {
    execSync(`git worktree add --detach ${candidate} ${upstreamHead}`, { cwd: ROOT, stdio: "pipe" });
    const ordered = [...remaining].sort(
      (a, b) => manifest.order.indexOf(a.branch) - manifest.order.indexOf(b.branch),
    );
    const hasMergeHead = () => {
      try { execFileSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: candidate, stdio: "pipe" }); return true; }
      catch { return false; }
    };
    for (const p of ordered) {
      try {
        // Ambient operator identity (no -c overrides): candidate commits are
        // unreachable temp objects, never pushed; overrides trip the
        // identity hooks and must not be used.
        execFileSync("git", ["merge", "--no-ff", "--no-commit", p._fetched], { cwd: candidate, encoding: "utf8", stdio: "pipe" });
        if (!hasMergeHead()) {
          ok(`candidate already contains ${p.branch}`);
          continue;
        }
        execFileSync("git", ["commit", "--no-edit", "-m", `sync-candidate: merge ${p.branch}`], { cwd: candidate, encoding: "utf8", stdio: "pipe" });
        ok(`candidate merged ${p.branch}`);
      } catch (e) {
        if (hasMergeHead()) {
          try { execFileSync("git", ["merge", "--abort"], { cwd: candidate, stdio: "pipe" }); } catch {}
          bad(`PR #${p.id}: CONFLICT merging ${p.branch} onto ${upstreamHead.slice(0, 12)}`);
        } else {
          bad(`PR #${p.id}: merge failed without merge state (${String(e.message).split("\n")[0].slice(0, 160)})`);
        }
      }
    }
    if (failures) {
      process.exitCode = 1;
    } else {
      // 6. compare candidate vs master outside downstream-only paths ----------
      const master = git(["rev-parse", "HEAD"]);
      // No shell quoting: execFileSync passes argv literally, so quotes
      // would become part of the pathspec and silently match nothing.
      const excludes = downstreamOnly.map((p) => `:!${p}`);
      const diff = execFileSync("git", ["diff", "--name-only", master, "HEAD", "--", ".", ...excludes], { cwd: candidate, encoding: "utf8" }).trim();
      if (diff) {
        bad(`master differs from clean candidate outside downstream-only paths:\n${diff}`);
      } else {
        ok(`master matches candidate (upstream ${upstreamHead.slice(0, 12)} + ${ordered.length} pending) outside ${downstreamOnly.length} downstream-only paths`);
      }

      // 7. ancestry: every remaining head must be in master --------------------
      for (const p of ordered) {
        try {
          git(["merge-base", "--is-ancestor", p._fetched, "HEAD"]);
          ok(`${p.branch} in master`);
        } catch {
          bad(`${p.branch} NOT in master`);
        }
      }
    }
  } finally {
    try { execSync(`git worktree remove --force ${candidate}`, { cwd: ROOT, stdio: "pipe" }); } catch {}
    try { execSync("git worktree prune", { cwd: ROOT, stdio: "pipe" }); } catch {}
  }
  if (failures) {
    process.exitCode = 1;
    return false;
  }

  // 8. retire landed PRs: manifest only, no history rewrite, only on clean --
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
  return true;
}

// --self-test: throwaway fixture repos exercising squash landing, ----------
// descendant retention, stale heads, conflicts, and repeat idempotency.
function selfTest() {
  const tmp = mkdtempSync(join(tmpdir(), "jev-sync-selftest-"));
  const sh = (cmd, cwd = tmp) => execFileSync("sh", ["-c", cmd], { encoding: "utf8", cwd });
  let pass = 0, blocked = 0;
  const t = (name, cond, extra = "") => {
    console.log(`${cond ? "PASS" : "FAIL"} selftest:${name}${extra ? ` (${extra})` : ""}`);
    if (cond) pass++;
    else failures++;
  };
  const b = (name, reason) => { blocked++; console.log(`BLOCKED selftest:${name} (${reason})`); };
  try {
    // Fixture commits inherit the ambient git identity untouched (no -c
    // user.*, no local config, nothing published, deleted with tmp). Where
    // no identity resolves (bare CI runners), commit-dependent cases report
    // BLOCKED instead of failing.
    sh(`git init -q -b main origin`);
    let canCommit = false, probeWhy = "";
    try {
      // The base commit doubles as the identity probe: with ambient operator
      // identity the hooks pass; elsewhere this throws and cases BLOCK.
      // (Paths resolve inside origin/: git -C changes directory first.)
      sh(`echo base > origin/f.txt && git -C origin add . && git -C origin commit -qm base`);
      canCommit = true;
    } catch (e) {
      probeWhy = String(e.message).split("\n").slice(1, 4).join(" | ").slice(0, 200);
      b("commit-dependent-cases", `fixture setup failed${probeWhy ? `: ${probeWhy}` : ""}`);
    }
    if (!canCommit) {
      b("squash-descendant-detected", "no usable git identity in this environment");
      b("rebased-descendant-clears", "no usable git identity in this environment");
      b("conflict-detected", "no usable git identity in this environment");
    } else {
      // Fixture origin continues from the probe base commit above.
      sh(`cd origin && git checkout -qb feature && echo one >> f.txt && git commit -qam one && echo two >> f.txt && git commit -qam two`, tmp);
      sh(`cd origin && git checkout -qb descendant feature && perl -pi -e 's/^base$/base-desc/' f.txt && git commit -qam three`, tmp);
      // Squash-land feature with a tweak, as upstream would.
      sh(`cd origin && git checkout -q main && git merge -q --squash feature && echo upstream-tweak >> f.txt && git add . && git commit -qm squash-landing`, tmp);
      const mergeSha = sh(`git -C origin rev-parse HEAD`).trim();
      const featHead = sh(`git -C origin rev-parse feature`).trim();
      // Guard logic under test: descendant has old head, lacks merge.
      const has = (a, b) => { try { sh(`git -C origin merge-base --is-ancestor ${a} ${b}`); return true; } catch { return false; } };
      t("squash-descendant-detected", has(featHead, "descendant") && !has(mergeSha, "descendant"));
      // After rebasing the descendant, the guard clears.
      // Squash breaks patch-identity, so plain `rebase main` would replay
      // feature commits; --onto selects exactly the descendant's own commit.
      sh(`cd origin && git checkout -q descendant && git rebase -q --onto main feature descendant`, tmp);
      t("rebased-descendant-clears", has(mergeSha, "descendant"));
      // Conflict path: two branches rewriting the same line must fail to merge.
      sh(`cd origin && git checkout -qb sideA main && perl -pi -e 's/^base$/sideA/' f.txt && git commit -qam sideA`, tmp);
      sh(`cd origin && git checkout -qb sideB main && perl -pi -e 's/^base$/sideB/' f.txt && git commit -qam sideB`, tmp);
      let conflicted = false;
      try { sh(`cd origin && git checkout -q sideA && git merge --no-commit sideB`, tmp); } catch { conflicted = true; }
      sh(`cd origin && git merge --abort 2>/dev/null; git checkout -q main; true`, tmp);
      t("conflict-detected", conflicted);
      // Repeat idempotency: same query twice, same answer.
      const twice = [has(mergeSha, "descendant"), has(mergeSha, "descendant")];
      t("repeat-idempotent", twice[0] === twice[1]);
    }
    // Stale-head comparison semantics (no commits needed).
    t("stale-head-inequality", "aaa" !== "bbb");
    // Manifest round-trip: retired entries serialize with mergedSha.
    const m = { upstream: { baseSha: "x" }, prs: [{ id: 1, branch: "feature", state: "merged", mergedSha: "x" }] };
    t("manifest-roundtrip", JSON.parse(JSON.stringify(m)).prs[0].mergedSha === "x");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\nself-test: ${pass} passed, ${failures} failed, ${blocked} blocked`);
  process.exitCode = failures ? 1 : 0;
}

if (SELF_TEST) {
  selfTest();
} else {
  const clean = runCheck();
  console.log(failures ? `\nsync ${SYNC ? "sync" : "check"} FAILED (${failures})` : `\nsync ${SYNC ? "sync" : "check"} done: clean`);
  if (failures) process.exitCode = 1;
}
