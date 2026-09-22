# Production qualification status — 2026-09-22

**No cutover is approved or performed.** Review remediation and isolated qualification do not
replace the running v1 deployment or modify live user configuration.

## Runtime identities

| Runtime | Executable SHA-256 | Scope |
| --- | --- | --- |
| OpenCode `1.18.31+3b7d74d` | `a27a63046645a409c40559f352267f1b28c241247e915427d41d9cbd8591c7ff` | Unwrapped v1 binary, isolated HOME/XDG |
| OpenCode `2.0.12` | `2b0825721cb12f9bca3d5099588087d557a21ed2b5b56efebea3f17dc5f79e6a` | Released Linux x64 glibc AVX2 baseline |
| OpenCode `2.0.12+1b894b926a` | `a3f84d86349cf91c6eb46424f503895fe6e6354d3301fa41d17b1c2554ffbaab` | Staged Nix candidate, not activated |
| OpenCode `2.0.12-mcp.1` | `d4c5424547d983d5c6d36bdf5727df6f974a9b00e594f82872d240173c337036` | CI source build from the same fix; web UI assets omitted |

The candidate source is `caniko/opencode@1b894b926a9e69a6211e3f0185d8f51d743a7f89`,
[OpenCode PR #50528](https://github.com/anomalyco/opencode/pull/50528). Its upstream review is
separate from gateway review. See [`opencode-candidate.json`](opencode-candidate.json).

## Fresh results from this remediation pass

| Gate | Result | Evidence / limits |
| --- | --- | --- |
| Installed-artifact suite, released v2 | PASS: 36, zero FAIL/BLOCKED | [CI acceptance](https://github.com/caniko/jev-gateway/actions/runs/35720436028/job/106721803434); includes explicitly labeled warm-up |
| Installed-artifact suite, staged candidate | PASS: 36, zero FAIL/BLOCKED | `/data/scratch/tmp/jev-acceptance-1258888`; source `afced90ac7240b1a6326f699e30466db36563c0b` |
| Source-built candidate in CI | PASS: 76 MCP unit tests, 20 cold trials, 36 acceptance checks | [CI cold readiness](https://github.com/caniko/jev-gateway/actions/runs/35720436028/job/106721803523) |
| Cold first-request readiness, released v2 | FAIL: 8 pass, 12 fail | `/tmp/jev-cold-4h1pEh`; ready fixtures absent from the first roster |
| Cold first-request readiness, staged candidate | PASS: 20/20 | `/tmp/jev-cold-TuDaQj`; no warm-up, readiness polling, or artificial model delay |
| v1 proxy compatibility | PASS: three flag configurations | `/tmp/jev-v1-proxy-wEIeg2`; default flags and SDK path with Code Mode off/on; each consulted Jev once |
| Direct MCP and Code Mode | PASS separately | Actual discovery, invocation, allow/deny controls, and exact effects |
| API permission approval/rejection | PASS separately in both exposure modes | Actual pending requests, zero pre-approval effects, once/reject replies, exact counters |
| Plugin enable/disable/reenable/reload | PASS | Jev consultations 1/0/1/1; no duplicate hook calls |
| Cancellation and exact prompt retry | PASS | Before approval: 0 starts/0 commits; before commit: 1/0; after commit: 1/1 |
| Blender editing, screenshot, save/reopen | PASS | Pinned acceptance bundle; `/data/scratch/tmp/opencode/blender-mcp-acceptance/jev-review-20260922` |
| Live Blender → OpenCode → Jev → image → model | PASS | Disposable owned instance; eight model requests, five Jev decisions; subsequent retained-image requests bypassed Jev |
| Live FreeCAD → OpenCode → Jev → image → model | PASS | Disposable owned document; six model requests, two Jev decisions; actual box properties and geometry verified |
| Live image interpretation | PASS with stated scope | FreeCAD model described the box; Blender model identified the default scene and Quick Setup overlay |
| Terminal UI approval interaction | NOT EXERCISED | API permission replies above are not evidence of UI rendering or keypress behavior |
| Host/plugin/configuration migration | NOT PERFORMED | Outside this review pass; production cutover remains unauthorized |

Both live CAD runs used installed runtime artifact
`sha256:75eb5b81589e1fbbd207edcc137bfc8c935e0c9361bad10e2602566cc314bcc7`, the staged OpenCode binary,
the existing OpenAI subscription with `gpt-6-astra`, and the existing Jev credential. Credentials
stayed in memory. The generated documents/processes were owned by the test and disposed afterward.
No existing CAD document was used.

- Blender: 5.2.0, MCP 1.18.0 at `37acac7fd25d424b23c8a84f27d6c16c848d810d`, Canix patched
  immutable bundle `/nix/store/pwpksr04z9znwj2spmkv3impkm89n7fq-blender-mcp-acceptance`.
  Live evidence: `/data/scratch/tmp/opencode/blender-mcp-acceptance/jev-live-v2-XnO0vG`.
- FreeCAD: 1.1.3, MCP/addon 0.1.18 at `63acb305573194a011641ab13ccfb391fe95769f`.
  `ProofBox` measured 2 × 3 × 4 mm, volume approximately 24 mm³, 8 vertices, 12 edges, 6 faces.
  Live evidence: `/data/scratch/tmp/opencode/blender-mcp-acceptance/jev-live-v2-vHCjYO`.

The CI-built gateway tarball had SHA-256
`5036dd7a28489c5581db4e03a2e197d9d547707fe14f6dcad982df6934eaa45d` and was qualified separately.
Local and CI package hashes are recorded independently rather than claiming byte-identical archives.

Evidence directories are local; raw conversation/debug dumps and credentials are not committed.
Fork CI, upstream CI approval, maintainer review, terminal UI approval, and production migration
remain distinct. Use the current fork workflow run for the final published revision's status.
