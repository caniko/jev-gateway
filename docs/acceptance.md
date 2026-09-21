# MCP acceptance

Two separated levels. Preceding PRs own their regression tests; this is
reusable cross-component tooling. Every PASS corresponds to an executed
assertion; anything unimplemented reports BLOCKED, never PASS.

## A. Deterministic, binary-driven (`scripts/v2-acceptance.mjs`)

All loopback, no keys, no desktop. Topology:

- `opencode run --standalone` (pinned `@opencode/cli@2.0.12`) →
  scripted model endpoint (`test/fixtures/acceptance-model.mjs`, Chat
  Completions JSON + Responses SSE, optional per-request delay file) and
  local MCP stdio fixture (`test/fixtures/acceptance-mcp.mjs`,
  `test_read` pure / `test_write` appends to a counter file).
- Gateway-in-loop scenarios use the built `dist/` of a checkout given by
  `GATEWAY_ROOT` (default: this repo), with upstream at the stub and Jev
  at `scripts/mock-jev.mjs` (or `test/fixtures/acceptance-jev-auth.mjs`
  for the credential assertion).
- Fully isolated identity: fresh `HOME` plus `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` (`HOME`-only
  isolation still reads the real `~/.config`). Children get a hermetic
  env, never the caller's interactive `OPENCODE_*` variables.

Binary source: `--binary PATH`, `OPENCODE_V2_BIN`, or `--install-binary`
(fetches the pinned npm artifact and verifies `--version`; registry
access only). Without a usable binary every binary-driven check reports
BLOCKED. `GATEWAY_ROOT` selects the gateway build under test.

Current checks (21): installed artifact (pack digest recorded, gateway
and plugin both run from the dependency-free installation), version,
text roundtrip, native tool call/result linkage, MCP connection
(server-log evidence that the fixture connected with 2 tools), MCP
invocation (BLOCKED, see below), selection through the real binary +
gateway (forced `tool_choice`), plugin influence (the configured
plugin's `[jev-routing]` hint reaches model traffic and the session
completes — proving load plus exactly-once hook behavior), plugin
fail-open (dead gateway leaves the run untouched with no hint),
plugin-only influence (provider straight to stub, so hints plus a Jev
consultation prove the plugin path with the proxy structurally absent),
multi-turn continuity, deny/ask safety (no execution either way), image
bypass with 0 Jev calls, both credential directions, standalone
isolation, existing shared service (own-config-wins, zero cross-talk on
a separated stub), explicit remote honored, balanced pairs,
cancellation with no post-kill retries.

Last full run 2026-09-21: 15 passed / 1 failed / 1 blocked; the three
failures traced to harness bugs (stale gateway config, SIGINT exit-code
shape, cross-talk measured on a shared stub), all fixed since — the next
full run re-verifies all 17 checks.

Limits established by probing 2.0.12 with a valid native entry
(`codemode: false` retained, server connects with 2 tools): fixture
tools appear neither on the provider wire nor in the Code Mode
catalog/search nor by direct invocation (`Unknown tool`), with or
without allow permissions — so no deterministic MCP-invocation driver
exists here (`mcp-invocation` stays BLOCKED); direct mode is unreachable
through the binary because the native roster has no closed schemas
(covered at gateway unit level instead); nested Code Mode approvals are
unobservable for the same reason. Observed 2.0.12 facts this relies on
live in `docs/opencode-v2.md` on the v2 branch.

## B. Real application (gated, disposable)

Blender (`newo-ether/blender-mcp@ced81a5a`) and FreeCAD
(`neka-nat/freecad-mcp@75197460`) disposable workflows — instance
discovery, bounded mutation, state/revision verification, screenshot
round trips, approval handling — remain manual and credential-gated
(desktop + application availability). They are BLOCKED until run, and
mocks never count as live validation. Compare routing off vs on with
disposable workflows and record actual routed decisions; all-passthrough
success is compatibility, not proof of Jev routing.
