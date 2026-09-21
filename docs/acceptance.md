# MCP acceptance

Two separated levels. Preceding PRs own their regression tests; this is
reusable cross-component tooling.

## A. Deterministic (CI, no keys/desktop)

Run: `pnpm test test/v2-acceptance.test.ts`
Runner: `node scripts/v2-acceptance-deterministic.mjs`
Optional live binary: `OPENCODE_V2_BIN=/path/to/opencode-2.0.12 node scripts/v2-acceptance-deterministic.mjs`

Verifies with stubbed Jev/model endpoints and local MCP shapes:

- MCP discovery and normalized tool names (`mcp__*` flattened vs provider namespaces);
- direct, selection-only (forced), passthrough, ordinary no-tool;
- multi-turn call/result/final-answer (single Jev, single upstream, no duplication);
- image delivery to main model without Jev call;
- ask/deny/allow: gateway never executes tools; denied calls have zero MCP side effects;
- retry/cancellation: no duplicate invocation in exercised cases;
- Code Mode: outer `execute` compatibility only; no claim Jev selects inner code tools;
- shared-service isolation (`--standalone` vs existing service);
- credentials routing without cross-provider leakage.

Adapters are exercised independently where v2 does not use a format.

## B. Real application (gated, disposable)

Run: `node scripts/v2-acceptance-real.mjs`
Gates: `BLENDER_MCP_AVAILABLE`, `FREECAD_MCP_AVAILABLE`, `LIVE_VISION_AVAILABLE`.
Without gates: BLOCKED (CI stays green). Mocks never count as live validation.

Pinned:

- `newo-ether/blender-mcp@ced81a5a220dd01240e67df2453dffeb8fb51daa`
- `neka-nat/freecad-mcp@751974609a401660a58a1772ef16f3afbeba9ba1`

Blender: discover/select instance ID, inspect, small validated change, verify
state/revision safeguards, screenshot round trip, rejection without touching work.
FreeCAD: disposable doc, bounded op, inspect geometry/properties, screenshot
round trip, long-running/status/error, approvals around exec/destructive.
Serialize mutations per instance; preserve server validation/transactions; never
blind-retry timed-out mutations. Text-only inspection where suitable, plus normal
screenshot workflow unchanged.

Compare routing off vs on with disposable workflows; record actual routed
decisions. All-passthrough success is compatibility, not proof of Jev routing.
