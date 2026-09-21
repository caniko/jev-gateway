# Production qualification — 2026-09-22

Status: **not approved for cutover**. The running host remains OpenCode v1.

## Verified in this run

- Pinned OpenCode CLI 2.0.12 performs actual local MCP mutations.
- With native `codemode: false`, provider-visible names are
  `fixture_test_read` and `fixture_test_write`.
- With Code Mode enabled, catalog discovery returns
  `tools.fixture.test_write`; execution changes the fixture counter once.
- Both direct and nested adversarial calls under a deny policy are refused
  with zero MCP side effects.
- The earlier "MCP unsupported" claim is retracted. Published Core 2.0.12
  `MCP.tools()` reads the current catalog without waiting for startup;
  `McpTool` reconciles changes after a 100 ms debounce. Instant-response
  test sessions ended before the catalog update. A harmless initial tool
  turn with bounded model-response latency reproduces successful execution.
- The context builder now enforces its actual JSON size at the final
  boundary. Accepted state budgets have a minimum of 64 characters;
  unrepresentable context produces a bounded explicit bypass state.

Runtime investigation evidence (local, disposable):
`/data/scratch/tmp/opencode/jev-live-azkpPP/wire.json` and `cli.log`.
The counter contained exactly `write:real-mcp-proof` once.
Automated reproduction: `scripts/v2-acceptance.mjs`, using the installed
gateway package and pinned CLI; required checks have no BLOCKED exemption.

## Actual application checks

These use the installed Canix Blender MCP 1.18.0 deployment, not the
manifest's proposed 1.19.0 pin. They must not qualify the proposed pin.

| Gate | Result | Evidence |
|---|---|---|
| Packaged Blender protocol | PASS | `BLENDER_MCP_PROTOCOL_OK` |
| Disposable graphical editing | FAIL | `vector edit kept revision` assertion at `scripts/test-blender-mcp.py:582` |
| Disposable viewport screenshot | FAIL | Blender allocator failure during screenshot, followed by transport disconnect |

Disposable state is preserved under:

- `/data/scratch/tmp/opencode/jev-production-blender-protocol`
- `/data/scratch/tmp/opencode/jev-production-blender-graphical`
- `/data/scratch/tmp/opencode/jev-production-blender-image`

The image run's `blender.log` records `Malloc returns null` in
`create_cropped_buffer_impl` and a crash report path. The test driver
owns and cleans up its application processes. Existing user work was not
selected or edited. A display was available; prior reports claiming no
graphics support were not supported by this environment.

## Open production gates

- Verify the staged Canix Blender revision/screenshot fixes in their owning
  workstream; rerun against the actual candidate package in fresh instances.
- Cold first-request MCP readiness: the bounded warm-up in acceptance is
  not a production startup synchronization mechanism.
- Interactive ask/approve/reject, reload/disposal, and controlled mutation
  cancellation/retry counters remain unqualified.
- FreeCAD disposable geometry and screenshot workflow has not been run.
- Live model image interpretation has not been run.
- The Canix consumer still points to upstream 0.3.1 and does not install
  the new plugin directory. No downstream revision/hash is approved yet.
- Required local v1 plugin migrations, session/data rollback, server API
  consumers, and LSP replacement checks remain pre-cutover requirements.
- Upstream draft PR check rollups must be distinguished from fork master
  CI. No upstream approval or independent production approval is claimed.

Do not deploy using hashes copied from older handoffs. Calculate and
evaluate a new immutable consumer only after its exact source is accepted.
