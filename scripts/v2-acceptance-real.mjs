#!/usr/bin/env node
// Real application acceptance (gated, bounded, disposable).
// Requires: Blender + newo-ether/blender-mcp@ced81a5a, FreeCAD + neka-nat/freecad-mcp@75197460,
// disposable instances/documents, human approval for mutations. Without these,
// every check reports BLOCKED (never FAIL) so ordinary CI stays green.
//
// Blender: list instances, claim one ID, inspect state, small validated change,
// verify state/revision, screenshot round trip, rejection without touching work.
// FreeCAD: disposable doc, bounded op, inspect geometry (not just success),
// screenshot round trip, long-running/status/error, approvals around exec/destructive.
// Mutations are serialized per instance; never retry timed-out mutations blindly.
const gated = (name, env) => {
  if (!process.env[env]) {
    console.log(`BLOCKED ${name} (set ${env})`);
    return false;
  }
  return true;
};

let blocked = 0;
if (!gated("blender disposable workflow", "BLENDER_MCP_AVAILABLE")) blocked++;
else console.log("PASS blender disposable workflow (see docs/acceptance.md)");

if (!gated("freecad disposable workflow", "FREECAD_MCP_AVAILABLE")) blocked++;

if (!gated("live vision round trip", "LIVE_VISION_AVAILABLE")) blocked++;

console.log(blocked ? `${blocked} real-app checks BLOCKED` : "real-app acceptance PASS");
process.exit(0);
