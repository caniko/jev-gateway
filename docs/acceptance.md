# MCP acceptance

Two separated levels. Preceding PRs own their regression tests; this is
reusable cross-component tooling. Every PASS below corresponds to an
executed assertion; anything unimplemented reports BLOCKED, never PASS.

## A. Deterministic, binary-driven (`scripts/v2-acceptance.mjs`)

All loopback, no keys, no desktop. Topology:

- `opencode run --standalone` (pinned `@opencode/cli@2.0.12`) →
  scripted model endpoint (`test/fixtures/acceptance-model.mjs`, Chat
  Completions JSON + Responses SSE) and local MCP stdio fixture
  (`test/fixtures/acceptance-mcp.mjs`, `test_read` pure / `test_write`
  appends to a counter file so duplicate invocations are visible).
- Gateway-in-loop scenarios use the built `dist/` of a checkout given by
  `GATEWAY_ROOT` (default: this repo), with upstream at the stub and Jev
  at `scripts/mock-jev.mjs`.
- Fully isolated identity: fresh `HOME` plus `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` (`HOME`-only
  isolation still reads the real `~/.config`). Child processes get a
  hermetic env, never the caller's interactive `OPENCODE_*` variables.

Binary source: `--binary PATH`, `OPENCODE_V2_BIN`, or `--install-binary`
(fetches the pinned npm artifact and verifies `--version`; registry
access only). Without a usable binary every binary-driven check reports
BLOCKED. `GATEWAY_ROOT` selects the gateway build under test.

Verified 2026-09-21, 11 passed / 0 failed / 0 blocked:

- `binary-version`, `text-roundtrip`, `native-tool-loop` (call/result
  linked by id, final answer), `mcp-discovery` (server log shows the
  fixture with 2 tools), `multi-turn-continuity` (full history resent,
  no `previous_response_id`), `deny-write-side-effect-free` (denied
  native `write` left no file, run completed),
  `image-bypass-via-gateway` (image reached the model, 0 Jev calls),
  `credentials-routing` (every stub hit carried the client sentinel,
  none the Jev sentinel), `standalone-isolation` (private server works;
  explicit `--server` honored), `explicit-remote-server`,
  `balanced-tool-execution` (every call has exactly one result).

Observed 2.0.12 facts this relies on: custom `openai-compatible`
providers speak Chat Completions; the built-in `openai` provider speaks
Responses; MCP tools stay behind the `execute` Code Mode tool and never
appear on the provider wire; multi-turn resends full history. See
`docs/opencode-v2.md` on the v2 branch.

## B. Real application (gated, disposable)

Blender (`newo-ether/blender-mcp@ced81a5a`) and FreeCAD
(`neka-nat/freecad-mcp@75197460`) disposable workflows — instance
discovery, bounded mutation, state/revision verification, screenshot
round trips, approval handling — remain manual and credential-gated
(desktop + application availability). They are BLOCKED until run, and
mocks never count as live validation. Compare routing off vs on with
disposable workflows and record actual routed decisions; all-passthrough
success is compatibility, not proof of Jev routing.
