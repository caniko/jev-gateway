# Review remediation — 2026-09-22

The seven PRs remain separate drafts. Upstream base is
`a197836755671fc224cc3d7f91a8592d56ca665c`. Exact revised heads and own-delta bases are in
[`manifest.json`](manifest.json). Original commits remain in fork master history and local
`backup/review-20260922-*` refs. Existing dirty worktrees were left untouched.

## Comment → change → regression

Thread numbers below are GitHub review-comment IDs in `vinilana/jev-gateway`.

| PR | Comments | Change | Regression evidence | Commit |
| --- | --- | --- | --- | --- |
| 17 | 4067836280, 4067836286 | Only `decide()` gates direct calls; empty/const-only and decision-endpoint cases live in router tests | Both cases fail on upstream base; revised head passes 138 tests | `af1ddde4e24aae63111993f320ea656a6588ac98` |
| 18 | 4067836435, 4067836440, 4067836444 | Typed closed-value validation; recognized annotations, unions, omitted object type and OpenAI-only omitted parameters; safe own-property construction | Eight compatibility/property-name failures on `31eb23c`; revised head passes 169 tests, including bounded large-enum and JSON-equality checks | `ba7e1ffd865ba1652f650fc1ca0f01ec83bb0cf1` |
| 19 | 4067836591, 4067836596, 4067836602, 4067836606 | Inspect protocol media containers; preserve signatures, hosted traces, refusals, web-search results, and ordinary application JSON; README/dashboard explain retained media | Three positive-routing failures on `ab7d6da`; revised head passes 149 tests, including unchanged streaming media payloads | `9e5a33be92dad3012f703928fb7f798dc7295299` |
| 20 | 4067839305, 4067839306, 4067839311, 4067839318, 4067839326, 4067839332 | Precompute bounded DP patterns; passthrough prevents forced none; exact-name examples, descriptive startup errors, hint/unknown-name/collision coverage | Nine failures on `80a1453`, including bounded subprocess timeout; revised head passes 182 tests | `793564b1462b306b6b78cc653e8175441bbe53a2` |
| 21 | 4067836804, 4067836805, 4067836811, 4067836812 and review body | Compiled dependency-free plugin object; request-local hints; one owner per request; gateway-only authentication; guarded configuration merge and explicit model precedence; README setup | Fourteen failures on `e3f21b7`; revised head passes 227 tests; production-only install loads on both Node versions; real v1/v2 checks below | `8ac1b82f1edf182b6dc70f7705658e8b28a31bdc` |
| 21 | 4067836808 | Separate Responses fix: direct only with explicit `store:false`; streaming and chaining covered | `test/responses-store.test.ts` covers false/true/omitted store and next-request preservation | `9ca0a6871a493a7011b3b7d47d0d13a8002b35e1` |
| 22 | 4067836937, 4067836941, 4067836944, 4067836946, 4067836947 | Independent generic context change; explicit clipping metadata, dependency spans, observed Gemini IDs, exact serialized budgets and startup-only validation | Fourteen failures on `6cc4de8`; revised head passes 151 tests; 20 parallel reads remain routable within 6000 units | `f2690120068cffd3485bff80370147185024bdaf` |
| 23 | 4067837065, 4067837069, 4067837073, 4067837076, 4067837079, 4067837080 and review body | Upstream reduced to portable fixtures/procedural docs, actually stacked on #21; full qualification retained below `integration/qualification` | Revised head passes 230 tests; old polling helper fails two deadline/cancellation checks; fork helper passes fake-clock and environment checks | `aeb320c3cf3060a7703e43d0f2d0ad7c21cdfddc` |

Every feature head passed frozen install, typecheck, full tests, build, and package dry-run on
Node **22.15.0 and 24.19.0**. The combined source has 258 tests; the retained fork checks add eight.
No release-managed version or changelog was changed.

The planner replaces the old final validator by checking every value it can synthesize, required
property membership, supported root/property keywords, and argument own-property construction.
Arbitrary unknown keywords remain unsupported; a recognized annotation is not a license to drop
an unknown validation constraint. The wildcard matcher is O(pattern × name), not claimed linear;
rules and pattern lengths are capped and documented.

Pre-publication inspection also caught pairwise enum scans and negative-zero equality in the
intermediate `e26ddad` implementation. Both new regressions fail there (the 100,000-value case
hits its subprocess deadline) and pass after canonical JSON keys replace pairwise comparisons.

## Dependency and integration gates

- #17 → #18 → #20 → #21 → #23; #19 and #22 are independent of that chain.
- #21 has one feature commit plus the separate Responses fix; other PRs have one own commit.
- Fork history is preserved. Reconciliation selects the reviewed clean candidate's source tree,
  retaining only the explicitly listed downstream paths.
- `node scripts/sync-master.mjs --check` checks remote heads, actual prerequisite ancestry, order,
  clean reconstruction, and inclusion in master. Its fixture self-test covers missing/landed
  prerequisites and merge conflicts; required BLOCKED results fail.

## Qualification evidence

Runtime tarball SHA-256: `f7ae8f67c9a8ee0e633c9477d25d7787521a3e5fc446ee17e1b029a73b32512c`.
The local installed-artifact run at `c980a17b1a3454339835b7bc83b87fcc5d22c4e9` passed all **36** checks.
The earlier revised artifact also passed all 36 with released OpenCode 2.0.12. These are distinct
from cold-start and production gates, detailed in [`production-status.md`](production-status.md).

Production-only installation contains the gateway and its two runtime dependencies; loading the
published JavaScript plugin requires no OpenCode SDK package. The qualification SDK has its own
explicit private development dependency and frozen lockfile. Registry bootstrap and loopback
scenario traffic are documented separately.

Current fork CI: [integration workflow](https://github.com/caniko/jev-gateway/actions/workflows/integration.yml?query=branch%3Amaster).
Upstream CI still requires contributor approval; fork results do not replace it. No review thread
was marked resolved, no upstream PR was merged or self-approved, and no host cutover was performed.
Maintainer acceptance of the retained-media policy and the reduced upstream fixture scope remains
an external gate.
