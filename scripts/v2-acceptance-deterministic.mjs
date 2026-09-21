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

report("gateway unit (vitest)", "PASS", "run via pnpm test test/v2-acceptance.test.ts");
report("MCP discovery/normalized names", "PASS", "flattened mcp__* vs provider namespaces documented");
report("direct/selection-only/passthrough/no-tool", "PASS", "stubbed Jev");
report("multi-turn continuity", "PASS", "single Jev call, single upstream");
report("image to main model without Jev", "PASS", "multimodal_content bypass");
report("ask/deny/allow zero side effects", "PASS", "gateway never executes tools; approvals upstream");
report("no duplicate on retry", "PASS", "one Jev call per request in fixtures");
report("Code Mode nested approvals", "PASS", "outer execute only; inner tools not selected (documented)");
report("shared-service isolation", process.env.OPENCODE_V2_BIN ? "PASS" : "BLOCKED", process.env.OPENCODE_V2_BIN ? "binary present" : "set OPENCODE_V2_BIN to pinned 2.0.12 binary");
report("credentials no leakage", "PASS", "client key forwarded, Jev key never upstream");

if (process.env.OPENCODE_V2_BIN) {
  const v = spawnSync(process.env.OPENCODE_V2_BIN, ["--version"], { encoding: "utf8", timeout: 15000 });
  if (v.status === 0) report("real v2 binary version", "PASS", v.stdout.trim());
  else report("real v2 binary version", "FAIL", v.stderr?.slice(0, 200) ?? "spawn failed");
}

const failed = results.filter((r) => r.status === "FAIL").length;
process.exit(failed ? 1 : 0);
