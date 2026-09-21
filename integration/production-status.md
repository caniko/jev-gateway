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
- Four authenticated server-API permission cases observe pending requests
  and verify approval/rejection before and after the actual MCP mutation.
  The final local harness reports 28 PASS, zero FAIL, zero BLOCKED.
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

### Candidate Blender extension and FreeCAD follow-up

`canix cache build .#blender-mcp-extension` realized and privately published
`/nix/store/dnzwfsv6f789ca3gsp8j8fx4aq43zfp2-blender-mcp-extension-1.18.0`.
The installed desktop wrapper hardcodes the older extension, so overriding
its environment did not test the candidate. Launching Blender directly
with the staged `home/modules/productivity/blender-mcp-startup.py` and the
candidate extension produced:

- **PASS:** graphical suite, including vector-revision safeguards, in
  `/data/scratch/tmp/opencode/jev-patched-blender-graphical`.
- **FAIL:** image gate, now a bounded `no drawable area (-2x26)` error
  instead of a crash, in `/data/scratch/tmp/opencode/jev-patched-blender-image`.
  Waiting five seconds for initial redraw did not resolve it; diagnostic
  evidence: `/data/scratch/tmp/opencode/jev-blender-settled-m9rq5n82`.

A fresh FreeCAD 1.1.3 GUI with installed freecad-mcp 0.1.18 and its addon
passed MCP document creation, a `Part::Box` operation, exact readback of
Length=2 mm / Width=3 mm / Height=4 mm, and screenshot capture (3693 bytes).
Evidence: `/data/scratch/tmp/opencode/jev-freecad-cy6c9ssv`. The isolated
macro proves PID ownership after binding; existing endpoints are refused.
The disposable processes were terminated by the driver. This is direct
application/MCP evidence, not yet an OpenCode/Jev CAD session or a live
vision-provider qualification.

## Open production gates

- Blender candidate graphical verification passes; the drawable-viewport
  screenshot gate still needs resolution in its owning workstream.
- Cold first-request MCP readiness: the bounded warm-up in acceptance is
  not a production startup synchronization mechanism.
  A pre-prompt `mcp.list` connected-state poll alone passed once and failed
  on repetition: it does not wait for the tool-registry debounce. The
  permission tests retain the explicitly documented bounded first turn.
- Permission-server acceptance now observes real pending MCP requests and
  replies `once`/`reject` in both exposure modes, with zero pre-approval
  mutation and exact final counters. Terminal UI interaction, plugin
  reload/disposal, and mutation cancellation/retry counters remain unqualified.
- FreeCAD direct MCP geometry and screenshot checks pass; the complete
  v2/gateway/live-model workflow remains unqualified.
- Live model image interpretation has not been run.
- The Canix consumer still points to upstream 0.3.1 and does not install
  the new plugin directory. No downstream revision/hash is approved yet.
- `canix cache build .#jev-gateway` was attempted with the immutable
  `a93aaaaabdf87198357a8b0fedbd2a2318b4df50` source. Source fetching passed
  with unpacked NAR hash `sha256-xHxuNC2AjSeAAsunK4VnXtrwpzCJ+yfakGGIb6R0Lgw=`.
  Dependency fetching was BLOCKED by pnpm 11's minimum-release-age policy:
  six OpenCode 2.0.12 packages published on September 21 were inside the
  24-hour cutoff. The policy was not weakened. The experimental consumer
  edit was reverted; no fake dependency hash remains in Canix.
- Required local v1 plugin migrations, session/data rollback, server API
  consumers, and LSP replacement checks remain pre-cutover requirements.
- Upstream draft PR check rollups must be distinguished from fork master
  CI. No upstream approval or independent production approval is claimed.

Do not deploy using hashes copied from older handoffs. Calculate and
evaluate a new immutable consumer only after its exact source is accepted.
