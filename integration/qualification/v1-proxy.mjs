#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { hermeticEnv } from "./environment.mjs";

const binary = process.env.OPENCODE_V1_BIN;
const installed = process.env.GATEWAY_INSTALL;
assert(binary && installed, "set OPENCODE_V1_BIN to the unwrapped binary and GATEWAY_INSTALL to a production-only install");
const require = createRequire(join(installed, "package.json"));
const { serve } = await import(require.resolve("@hono/node-server"));
const { createApp } = await import(join(installed, "dist/app.js"));
const { loadConfig } = await import(join(installed, "dist/config.js"));
const { opencode } = await import(join(installed, "bin/clients.mjs"));
const root = mkdtempSync("/tmp/jev-v1-proxy-");
const iso = Object.fromEntries(["home", "config", "data", "cache", "state"].map((key) => [key, join(root, key)]));
for (const directory of Object.values(iso)) mkdirSync(directory);
const env = hermeticEnv(iso);
const version = execFileSync(binary, ["--version"], { env, encoding: "utf8", timeout: 30000 }).trim();
assert.equal(version, "1.18.31+3b7d74d");
console.log(`BINARY ${version} sha256=${createHash("sha256").update(readFileSync(binary)).digest("hex")}`);
console.log(`EVIDENCE ${root}`);
const requests = [];
const model = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  requests.push(body);
  const message = { role: "assistant", content: "v1-proxy-ok" };
  const base = { id: "fixture", created: 1, model: "fixture" };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: "stop" }] }));
  } else {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
let decisions = 0;
const app = createApp({ config: loadConfig({ UPSTREAM_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, JEV_DIRECT_CALLS: "false" }),
  askJev: async ({ questions }) => {
    decisions++;
    return { model: "fixture", usage: { input_tokens: 1, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key,
      question.type === "choice" ? { type: "choice", choice: "no_tool_needed" in question.criteria ? "no_tool_needed" : Object.keys(question.criteria)[0], confidence: 0.99, probabilities: {} }
        : { type: "noul", noul: 0.01 }])) };
  } });
const gateway = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await once(gateway, "listening");
process.env.JEV_OPENCODE_MODEL = "fixture";
delete process.env.OPENCODE_CONFIG_CONTENT;
const inline = opencode.env(`http://127.0.0.1:${gateway.address().port}`);
try {
  for (const flags of [{}, { OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false", OPENCODE_EXPERIMENTAL_CODE_MODE: "false" },
    { OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false", OPENCODE_EXPERIMENTAL_CODE_MODE: "true" }]) {
    const before = requests.length;
    const prior = decisions;
    const child = spawn(binary, ["run", "--format", "json", "Reply with the fixture marker."], {
      detached: true, cwd: root, env: { ...env, ...inline, ...flags }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => output += data);
    child.stderr.on("data", (data) => output += data);
    const timer = setTimeout(() => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 90000);
    let code;
    try { [code] = await once(child, "close"); } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-2000));
    assert(output.includes("v1-proxy-ok"), "fixture response must reach v1");
    assert(requests.slice(before).some((request) => request.model === "fixture"), "launcher-selected model must reach proxy");
    assert(decisions > prior, "proxy must consult Jev for the actual v1 roster");
    console.log(`PASS v1-proxy ${JSON.stringify(flags)} modelRequests=${requests.length - before} Jev=${decisions - prior}`);
  }
} finally {
  gateway.closeAllConnections(); model.closeAllConnections();
  await Promise.all([new Promise((resolve) => gateway.close(resolve)), new Promise((resolve) => model.close(resolve))]);
}
