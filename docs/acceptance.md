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

Current checks (36): installed artifact (full pack digest and source SHA recorded, gateway
and plugin both run from the production-dependency installation), version,
text roundtrip, native tool call/result linkage, MCP connection
(server-log evidence that the fixture connected with 3 tools), MCP
invocation and denial in direct and Code Mode configurations, selection through the real binary +
gateway (forced `tool_choice` plus a unique readback marker), direct synthesis
(one MCP status invocation, its real result, and one skipped model request), plugin influence (the configured
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

Four lifecycle cases keep the same server alive while enabling, disabling,
reenabling, and reloading the plugin; each requires exactly one Jev call
when enabled and zero when disabled. Three mutation checkpoints interrupt
before approval, before commit, or after commit/before the result, then
retry the exact admitted prompt ID. Started/committed/cancelled event counts
and final state must match exactly; the committed case must not replay.

Both the released 2.0.12 baseline and the source-built readiness candidate
passed all 36 checks locally. Permission decisions use the API rather than
terminal UI automation. The scripted model validates advertised tools and
`tool_choice`; only explicitly named adversarial scenarios may violate the
advertised roster. Plugin tests use a direct provider path, not accidental
plugin-plus-proxy routing.

The earlier claim that 2.0.12 cannot expose MCP tools was incorrect. The
instant-response fixture raced startup and catalog reconciliation. The
current fixture keeps the session alive through a harmless initial read,
with bounded response latency, then uses the actual exposed catalog.
`codemode:false` exposes `fixture_test_write`; Code Mode discovery returns
`tools.fixture.test_write`. Both execute a unique counter mutation exactly
once. Adversarial calls under deny must leave that counter empty. No
BLOCKED result is exempt from the deterministic acceptance gate.

## First-turn readiness qualification

`scripts/v2-cold-start.mjs` requires explicit `OPENCODE_V2_BIN`,
`OPENCODE_V2_VERSION`, and `OPENCODE_V2_SHA256`. It runs 20 isolated trials:
immediate, 150 ms, and 500 ms MCP startup; disabled server; and a configured
startup timeout. It has no warm-up call, status poll, or model latency.
Every enabled-server first request must advertise the tool and execute it
once; disabled/failed servers must remain bounded and execute nothing.

The released 2.0.12 binary failed 12/20 trials. The candidate from
`caniko/opencode@1b894b926a9e69a6211e3f0185d8f51d743a7f89`
([upstream PR #50528](https://github.com/anomalyco/opencode/pull/50528))
passed 20/20. `v2-acceptance.mjs --runtime-pin=FILE` accepts an explicit
`{version,sha256,firstTurnReady}` pin for this separately built executable;
`firstTurnReady:true` removes the warm-up from the MCP permission cases.
It does not change the installed host binary or imply web UI qualification.

## B. Real application (gated, disposable)

Blender (`newo-ether/blender-mcp@ced81a5a`) and FreeCAD
(`neka-nat/freecad-mcp@75197460`) disposable workflows — instance
discovery, bounded mutation, state/revision verification, screenshot
round trips, approval handling — remain manual and credential-gated
(desktop + application availability). They are BLOCKED until run, and
mocks never count as live validation. Compare routing off vs on with
disposable workflows and record actual routed decisions; all-passthrough
success is compatibility, not proof of Jev routing.
