#!/usr/bin/env node
// First-turn MCP qualification. No warm-up tool, service-status polling, or
// model latency hides startup. Delays below belong only to the MCP fixture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.env.OPENCODE_V2_BIN;
const expectedHash = process.env.OPENCODE_V2_SHA256;
const expectedVersion = process.env.OPENCODE_V2_VERSION;
assert(binary && /^[a-f0-9]{64}$/.test(expectedHash ?? "") && expectedVersion, "set the exact binary, SHA256 and version");
assert.equal(createHash("sha256").update(readFileSync(binary)).digest("hex"), expectedHash);
assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), `opencode v${expectedVersion}`);
const fixture = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/acceptance-mcp.mjs");
const base = mkdtempSync("/tmp/jev-cold-");
console.log(`EVIDENCE ${base}`);
let failed = 0;
for (let trial = 0; trial < 20; trial++) {
  const root = join(base, String(trial));
  const scenario = trial % 5;
  const disabled = scenario === 3;
  const hung = scenario === 4;
  const expectedTool = !disabled && !hung;
  const delay = scenario === 1 ? 150 : scenario === 2 ? 500 : 0;
  mkdirSync(root);
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state") };
  for (const value of Object.values(env).slice(1)) mkdirSync(value);
  const seen = [];
  let primary = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const names = (body.tools ?? []).map(t => t.function?.name ?? t.name);
    const isPrimary = names.length > 0;
    if (isPrimary) {
      primary++;
      seen.push({ primary, names, messages: body.messages });
    }
    const call = isPrimary && primary === 1 && names.includes("fixture_test_write")
      ? { name: "fixture_test_write", arguments: JSON.stringify({ line: `trial-${trial}` }) } : undefined;
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "title", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${trial}`, type: "function", function: call }] } : { role: "assistant", content: "cold-complete" };
    const chunk = { id: "cold", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  writeFileSync(join(root, "counter"), "");
  writeFileSync(join(root, "opencode.json"), JSON.stringify({
    model: "probe/fixture", small_model: "probe/fixture",
    provider: { probe: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "dummy" }, models: { fixture: { name: "fixture", tools: true, limit: { context: 100000, output: 8000 } } } } },
    mcp: { servers: { fixture: { type: "local", command: [process.execPath, fixture], codemode: false, disabled, timeout: { startup: hung ? 300 : 3000, catalog: 3000 }, environment: { FIXTURE_COUNTER: join(root, "counter"), FIXTURE_STARTUP_DELAY_MS: String(delay), FIXTURE_HANG_STARTUP: hung ? "1" : "0" } } } },
    permission: { "*": "allow" },
  }));
  const started = Date.now();
  const child = spawn(binary, ["run", "--standalone", "--auto", "Perform the disposable fixture operation once."], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", d => output += d);
  child.stderr.on("data", d => output += d);
  const timer = setTimeout(() => child.kill("SIGTERM"), 20000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);
  server.close();
  const counter = readFileSync(join(root, "counter"), "utf8");
  const valid = code === 0 && !signal && output.includes("cold-complete")
    && seen.length > 0 && seen[0].names.includes("fixture_test_write") === expectedTool
    && counter === (expectedTool ? `write:trial-${trial}\n` : "");
  writeFileSync(join(root, "evidence.json"), JSON.stringify({ trial, delay, disabled, hung, code, signal, counter, seen, output }, null, 2));
  if (!valid) failed++;
  console.log(`${valid ? "PASS" : "FAIL"} cold-${trial} delay=${delay} disabled=${disabled} hung=${hung} ms=${Date.now()-started} counter=${JSON.stringify(counter)}`);
}
console.log(`${20-failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
