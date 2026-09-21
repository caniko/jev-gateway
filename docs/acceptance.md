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
- Gateway-in-loop scenarios pack the checkout given by `GATEWAY_ROOT`,
  install the tarball, and execute its installed gateway and plugin, with upstream at the stub and Jev
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

Current checks (28): installed artifact (pack digest recorded, gateway
and plugin both run from the production-dependency installation), version,
text roundtrip, native tool call/result linkage, MCP connection
(server-log evidence that the fixture connected with 2 tools), MCP
invocation and denial in direct and Code Mode configurations, selection through the real binary +
gateway (forced `tool_choice`), plugin influence (the configured
plugin's `[jev-routing]` hint reaches model traffic and the session
completes — proving plugin load and request annotation), plugin
fail-open (dead gateway leaves the run untouched with no hint),
plugin-only influence (provider straight to stub, so hints plus a Jev
consultation prove the plugin path with the proxy structurally absent),
multi-turn continuity, deny/ask safety (no execution either way), image
bypass with 0 Jev calls, both credential directions, standalone
isolation, existing shared service (own-config-wins, zero cross-talk on
a separated stub), explicit remote honored, balanced pairs,
cancellation with no post-kill retries. The four permission reply cases use
the supported v2 server API against a fresh authenticated local server:
observe a pending MCP request, assert the counter is empty, then reply
`once` or `reject` and check the exact final counter, in both exposure modes.

The 2026-09-22 local run passed 28 checks with zero failures and zero
blocked checks. This verifies the permission decision API, not the terminal
approval UI. It does not establish reload/disposal or exactly-once
application mutations under cancellation;
those remain required production qualifications, distinct from these checks.

The earlier claim that 2.0.12 cannot expose MCP tools was incorrect. The
instant-response fixture raced startup and catalog reconciliation. The
current fixture keeps the session alive through a harmless initial read,
with bounded response latency, then uses the actual exposed catalog.
`codemode:false` exposes `fixture_test_write`; Code Mode discovery returns
`tools.fixture.test_write`. Both execute a unique counter mutation exactly
once. Adversarial calls under deny must leave that counter empty. No
BLOCKED result is exempt from the deterministic acceptance gate.

## B. Real application (gated, disposable)

Blender (`newo-ether/blender-mcp@ced81a5a`) and FreeCAD
(`neka-nat/freecad-mcp@75197460`) disposable workflows — instance
discovery, bounded mutation, state/revision verification, screenshot
round trips, approval handling — remain manual and credential-gated
(desktop + application availability). They are BLOCKED until run, and
mocks never count as live validation. Compare routing off vs on with
disposable workflows and record actual routed decisions; all-passthrough
success is compatibility, not proof of Jev routing.
