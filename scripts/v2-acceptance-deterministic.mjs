#!/usr/bin/env node
// Deterministic v2 acceptance runner (no keys, no desktop).
// Uses the pinned gateway build + stub Jev/upstream + local test MCP shapes.
// Real OpenCode v2 binary level: set OPENCODE_V2_BIN to a pinned 2.0.12 binary;
// otherwise that section reports BLOCKED (not FAIL).
//
// Pinned:
// - @opencode/cli@2.0.12 (sha512-LwB0LD7LXZbfFDU12KwiUq5nPcjW1BzYpp81UPzEBpeZSNvszKXnTUa3l8JmLi6I6/WtQx/Z/8n2743FyY6lpg==)
// - newo-ether/blender-mcp ced81a5a220dd01240e67df2453dffeb8fb51daa
// - neka-nat/freecad-mcp 751974609a401660a58a1772ef16f3afbeba9ba1
import { spawnSync } from "node:child_process";

const results = [];
const report = (name, status, reason = "") => {
  results.push({ name, status, reason });
  console.log(`${status} ${name}${reason ? ` (${reason})` : ""}`);
};

// HONEST STATUS (review correction): this runner does not execute the listed
// workflows yet, so nothing here may report PASS. Each item is BLOCKED until
// the executable harness (local MCP fixture + scripted endpoints driven
// through the pinned OpenCode binary) implements it. The vitest file
// test/v2-acceptance.test.ts covers gateway-level fixtures only.
report("gateway unit (vitest)", "BLOCKED", "not executed by this runner; run pnpm test test/v2-acceptance.test.ts");
report("MCP discovery/normalized names", "BLOCKED", "not implemented: requires local MCP fixture via pinned binary");
report("direct/selection-only/passthrough/no-tool", "BLOCKED", "not implemented: requires pinned-binary drive");
report("multi-turn continuity", "BLOCKED", "not implemented: requires pinned-binary drive");
report("image to main model without Jev", "BLOCKED", "not implemented: requires pinned-binary drive");
report("ask/deny/allow zero side effects", "BLOCKED", "not implemented: requires side-effect counter fixture");
report("no duplicate on retry", "BLOCKED", "not implemented: requires retry/cancellation drive");
report("Code Mode nested approvals", "BLOCKED", "not implemented: requires nested-approval observation");
report("shared-service isolation", "BLOCKED", "not implemented: requires cold/attached standalone comparison");
report("credentials no leakage", "BLOCKED", "not implemented: requires sentinel-credential run");

if (process.env.OPENCODE_V2_BIN) {
  const v = spawnSync(process.env.OPENCODE_V2_BIN, ["--version"], { encoding: "utf8", timeout: 15000 });
  if (v.status === 0) report("real v2 binary version", "PASS", v.stdout.trim());
  else report("real v2 binary version", "FAIL", v.stderr?.slice(0, 200) ?? "spawn failed");
}

const failed = results.filter((r) => r.status === "FAIL").length;
process.exit(failed ? 1 : 0);
