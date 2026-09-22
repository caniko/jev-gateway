#!/usr/bin/env node
// Executable OpenCode v2 + jev-gateway acceptance.
//
// Scenario traffic is loopback; package/bootstrap installation may contact registries.
//   opencode run --standalone -> [gateway dist/ | stub model] -> stub model
//   gateway -> mock-jev (scripts/mock-jev.mjs) for Jev answers
//   opencode --(MCP stdio)--> acceptance fixture (counter file for side effects)
//
// Pinned binary: @opencode/cli@2.0.12. Source: --binary PATH, OPENCODE_V2_BIN,
// or --install-binary (fetches the pinned npm artifact into temp and verifies
// --version; registry access only, no credentials). Without a usable binary
// every binary-driven check reports BLOCKED, never PASS.
//
// Every PASS below corresponds to an executed assertion in this process.
// Usage: node integration/qualification/v2-acceptance.mjs [--install-binary] [--binary=PATH] [--keep]
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticEnv } from "./environment.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const pinPath = process.argv.find((a) => a.startsWith("--runtime-pin="))?.slice("--runtime-pin=".length);
const pin = pinPath ? JSON.parse(readFileSync(pinPath, "utf8")) : {
  version: "2.0.12", sha256: "2b0825721cb12f9bca3d5099588087d557a21ed2b5b56efebea3f17dc5f79e6a", firstTurnReady: false,
  platform: "linux", arch: "x64", variant: "glibc-avx2",
};
if (!/^[a-zA-Z0-9.+-]+$/.test(pin.version ?? "") || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? "") || typeof pin.firstTurnReady !== "boolean"
  || pin.platform !== process.platform || pin.arch !== process.arch || typeof pin.variant !== "string") throw new Error("invalid or incompatible runtime platform pin");
const VERSION = pin.version;
const CLI_SHA256 = pin.sha256;
const args = new Set(process.argv.slice(2));
const KEEP = args.has("--keep");

const work = mkdirTmp();
console.log(`EVIDENCE ${work}`);
const harnessIso = { home: join(work, "harness-home"), config: join(work, "harness-config"),
  data: join(work, "harness-data"), cache: join(work, "harness-cache"), state: join(work, "harness-state") };
for (const directory of Object.values(harnessIso)) mkdirSync(directory, { recursive: true, mode: 0o700 });
function mkdirTmp() {
  const dir = join(tmpdir(), `jev-acceptance-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const results = [];
const report = (name, status, reason = "") => {
  results.push({ name, status });
  console.log(`${status} ${name}${reason ? ` (${reason})` : ""}`);
};

import { sleep, waitFor } from "./readiness.mjs";

function freePort(port) {
  const out = spawnSync(process.execPath, ["-e", `require("net").createServer().once("error",()=>process.exit(1)).once("listening",function(){this.close();process.exit(0)}).listen(${port},"127.0.0.1")`], { env: hermeticEnv(harnessIso), timeout: 5000 });
  return out.status === 0;
}

// --- binary ---------------------------------------------------------------
function resolveBinary() {
  const direct = process.argv.find((a) => a.startsWith("--binary="))?.slice("--binary=".length) ?? process.env.OPENCODE_V2_BIN;
  if (direct) {
    if (!existsSync(direct)) return { error: `binary not found: ${direct}` };
    return { bin: direct };
  }
  if (!args.has("--install-binary")) return { blocked: "set OPENCODE_V2_BIN/--binary or pass --install-binary to fetch the pinned artifact" };
  if (pinPath) return { error: "an explicit runtime pin requires its already-built OPENCODE_V2_BIN" };
  try {
    execFileSync("npm", ["install", "--prefix", join(work, "v2bin"), "--no-audit", "--no-fund", `@opencode/cli@${VERSION}`], { env: hermeticEnv(harnessIso), stdio: "pipe", timeout: 180000 });
    execFileSync(process.execPath, [join(work, "v2bin/node_modules/@opencode/cli/postinstall.mjs")], { env: hermeticEnv(harnessIso), stdio: "pipe", timeout: 60000 });
    const bin = join(work, "v2bin/node_modules/@opencode/cli/bin/opencode.exe");
    if (!existsSync(bin)) return { error: "installed package has no binary" };
    return { bin };
  } catch (e) {
    return { blocked: `could not fetch pinned binary: ${String(e.message ?? e).slice(0, 160)}` };
  }
}

// --- processes ------------------------------------------------------------
const children = [];
function killChild(child, signal = "SIGKILL") {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}
function spawnLogged(name, cmd, cmdArgs, env, logFile) {
  const log = [];
  const child = spawn(cmd, cmdArgs, { detached: true, env: hermeticEnv(harnessIso, env), stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", (error) => log.push(`spawn error: ${error.message}`));
  child.stdout.on("data", (d) => log.push(d.toString()));
  child.stderr.on("data", (d) => log.push(d.toString()));
  children.push({ name, child, log });
  return { child, log };
}
async function boundedFetch(input, init = {}) {
  return fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(30000), ...(init.signal ? [init.signal] : [])]) });
}
async function httpGet(port, path, signal) {
  const response = await boundedFetch(`http://127.0.0.1:${port}${path}`, { signal });
  await response.arrayBuffer();
  return response.status;
}

function runOpencode(bin, iso, project, runArgs, extraEnv = {}, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(bin, runArgs, { detached: true, cwd: project, env: hermeticEnv(iso, extraEnv), stdio: ["ignore", "pipe", "pipe"] });
    children.push({ name: "opencode-run", child, log: [] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => killChild(child), timeoutMs);
    child.on("error", (error) => { err += error.message; clearTimeout(timer); resolve({ code: null, signal: null, out, err }); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
  });
}

function serverLogTail(iso, maxChars = 3000) {
  try {
    const p = join(iso.data, "opencode/log/opencode.log");
    if (!existsSync(p)) return "(no server log)";
    const text = readFileSync(p, "utf8");
    return text.slice(-maxChars);
  } catch (e) {
    return `(log unreadable: ${e.message})`;
  }
}

const modelLog = () => readFileSync(join(work, "model-requests.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// --- main -----------------------------------------------------------------
let failed = 0;
const fail = (name, reason) => { failed++; report(name, "FAIL", reason); };
const cleanup = () => { for (const c of children) killChild(c.child); if (!KEEP) rmSync(work, { recursive: true, force: true }); };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(2); });

const MODEL_PORT = 18081, JEV_PORT = 18090, GW_PORT = 18791, GW2_PORT = 18792, AUTH_PORT = 18091, MODEL2_PORT = 18083, SERVER_PORT = 18793;
for (const p of [MODEL_PORT, JEV_PORT, GW_PORT, GW2_PORT, AUTH_PORT, MODEL2_PORT, SERVER_PORT]) {
  if (!freePort(p)) { fail("preflight", `loopback port ${p} busy`); process.exit(1); }
}
// Gateway under test: an integrated checkout (master after reintegration).
// Defaults to this repo root; override for validating another worktree.
const GATEWAY_ROOT = process.env.GATEWAY_ROOT ?? ROOT;
if (!existsSync(join(GATEWAY_ROOT, "dist/index.js"))) { fail("preflight", `gateway dist/ missing in ${GATEWAY_ROOT}: run pnpm build there first`); process.exit(1); }

const { bin, blocked, error } = resolveBinary();
if (error) { fail("preflight", error); process.exit(1); }
const ALL_CHECKS = [
  "binary-version", "installed-artifact", "text-roundtrip", "native-tool-loop", "mcp-connection",
  "mcp-invocation", "mcp-denial", "mcp-codemode-invocation", "mcp-codemode-denial",
  "mcp-direct-ask-once", "mcp-direct-ask-reject", "mcp-nested-ask-once", "mcp-nested-ask-reject",
  "plugin-lifecycle-enable", "plugin-lifecycle-disable", "plugin-lifecycle-reenable", "plugin-lifecycle-reload",
  "mcp-cancel-before-approval", "mcp-cancel-before-commit", "mcp-cancel-after-commit",
  "selection-via-opencode", "plugin-influence", "plugin-fail-open", "plugin-only-influence",
  "direct-via-opencode",
  "multi-turn-continuity", "deny-write-side-effect-free", "ask-write-safe-default",
  "image-bypass-via-gateway", "credentials-routing", "jev-auth-credential",
  "standalone-isolation", "shared-service-existing", "gateway-health",
  "balanced-tool-execution", "cancellation-no-retry-storm",
];
if (blocked) {
  // Every required BLOCKED result fails the gate.
  for (const name of ALL_CHECKS) report(name, "BLOCKED", blocked);
}
if (!blocked) {
try {
const ver = spawnSync(bin, ["--version"], { env: hermeticEnv(harnessIso), encoding: "utf8", timeout: 30000 });
const binaryHash = createHash("sha256").update(readFileSync(bin)).digest("hex");
if (ver.status !== 0 || ver.stdout?.trim() !== `opencode v${VERSION}` || binaryHash !== CLI_SHA256) {
  fail("binary-version", `expected pinned Linux x64 ${VERSION} artifact; version=${JSON.stringify(ver.stdout?.trim())}, sha256=${binaryHash}`);
  printSummary();
  process.exit(1);
} else report("binary-version", "PASS", `${ver.stdout.trim()} sha256=${binaryHash}`);

const iso = {
  home: join(work, "home"), config: join(work, "home/.config"), data: join(work, "home/.local/share"),
  cache: join(work, "home/.cache"), state: join(work, "home/.local/state"),
};
const project = join(work, "project");
mkdirSync(project, { recursive: true });
for (const d of [iso.home, iso.config, iso.data, iso.cache, iso.state]) mkdirSync(d, { recursive: true });

const writeProject = (providerBase, extra = {}) => {
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    model: "acc-probe/acc-model", small_model: "acc-probe/acc-model",
    provider: {
      "acc-probe": {
        npm: "@ai-sdk/openai-compatible", name: "Acceptance Probe",
        options: { baseURL: providerBase, apiKey: "client-sentinel", timeout: 60000 },
        models: { "acc-model": { name: "Acceptance Model", tools: true, limit: { context: 100000, output: 8000 } } },
      },
    },
    mcp: { servers: {
      fixture: {
        type: "local", command: ["node", join(ROOT, "test/fixtures/acceptance-mcp.mjs")],
        timeout: { startup: 30000, catalog: 30000, execution: 30000 },
        codemode: false,
        environment: { FIXTURE_COUNTER: join(project, "counter.log") },
      },
    } },
    permission: { fixture_test_read: "allow", fixture_test_write: "allow", ...extra.permission },
    ...extra.rest,
  };
  writeFileSync(join(project, "opencode.json"), JSON.stringify(cfg, null, 2));
  writeFileSync(join(project, "counter.log"), "");
  try { rmSync(join(project, "toolmode")); } catch {}
};
const FIX = (name) => name === "acceptance-jev-auth.mjs" ? join(ROOT, "integration/qualification", name) : join(ROOT, "test/fixtures", name);

// model stub + mock jev stay up for the whole run
writeFileSync(join(project, "counter.log"), "");
const model = spawnLogged("model", "node", [FIX("acceptance-model.mjs")],
  { PORT: String(MODEL_PORT), LOG: join(work, "model-requests.log"), SCENARIO_FILE: join(project, "toolmode"), DELAY_FILE: join(project, "delayms") });
let jev = spawnLogged("jev", "node", [join(ROOT, "scripts/mock-jev.mjs")],
  { MOCK_JEV_PORT: String(JEV_PORT), MOCK_JEV_SCRIPT: "no_tool_needed", MOCK_JEV_CONFIDENCE: "0.95", MOCK_JEV_ARG_CERTAINTY: "0.5" });
try {
  await waitFor(() => model.log.join("").includes(`acceptance-model on 127.0.0.1:${MODEL_PORT}`), 15000, "model stub");
} catch (e) {
  fail("preflight", e.message);
  printSummary();
  process.exit(1);
}
try {
  await waitFor(() => jev.log.join("").includes("mock-jev on"), 15000, "mock jev");
} catch (e) {
  fail("preflight", e.message);
  printSummary();
  process.exit(1);
}
const jevCalls = () => jev.log.join("").split("\n").filter((l) => l.includes('"n":')).length;
// Restart mock-jev with a new script (selection scenarios need picked tools).
async function rejev(script, confidence = "0.95") {
  killChild(jev.child);
  await waitFor(() => jev.child.exitCode !== null || jev.child.signalCode !== null, 5000, "previous Jev process exit");
  jev = spawnLogged("jev", "node", [join(ROOT, "scripts/mock-jev.mjs")],
    { MOCK_JEV_PORT: String(JEV_PORT), MOCK_JEV_SCRIPT: script, MOCK_JEV_CONFIDENCE: confidence, MOCK_JEV_ARG_CERTAINTY: "0.5" });
  try {
  await waitFor(() => jev.log.join("").includes("mock-jev on"), 15000, "mock jev respawn");
} catch (e) {
  fail("preflight", e.message);
  printSummary();
  process.exit(1);
}
}

// Installed artifact under test: pack the gateway checkout and install the
// tarball without dev dependencies. BOTH the gateway server and the plugin
// run from this installation, never from checkout dist/ or source paths.
const GW = `http://127.0.0.1:${GW_PORT}/v1`;
let packagedPluginDir = "";
let installedGateway = "";
let installedDigest = "";
try {
  const packDest = join(work, "pack");
  const dirty = execFileSync("git", ["status", "--porcelain"], { env: hermeticEnv(harnessIso), cwd: GATEWAY_ROOT, encoding: "utf8", timeout: 10000 });
  if (dirty.trim()) throw new Error("qualification requires a clean source checkout");
  mkdirSync(packDest, { recursive: true });
  execFileSync("npm", ["pack", "--pack-destination", packDest, "--ignore-scripts"], { env: hermeticEnv(harnessIso), cwd: GATEWAY_ROOT, stdio: "pipe", timeout: 120000 });
  const tgz = readdirSync(packDest).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("no tarball produced");
  const digest = createHash("sha256").update(readFileSync(join(packDest, tgz))).digest("hex");
  installedDigest = `sha256:${digest}`;
  execFileSync("npm", ["install", "--prefix", join(work, "pkginstall"), "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", join(packDest, tgz)],
    { env: hermeticEnv(harnessIso), stdio: "pipe", timeout: 180000 });
  packagedPluginDir = join(work, "pkginstall/node_modules/jev-gateway/dist/plugin/jev");
  installedGateway = join(work, "pkginstall/node_modules/jev-gateway/dist/index.js");
  if (!existsSync(join(packagedPluginDir, "index.js"))) throw new Error("tarball lacks compiled plugin");
  if (!existsSync(installedGateway)) throw new Error("tarball lacks dist/index.js");
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { env: hermeticEnv(harnessIso), cwd: GATEWAY_ROOT, encoding: "utf8", timeout: 10000 }).trim();
  report("installed-artifact", "PASS", `source=${sourceSha}, tarball=${installedDigest}, gateway+plugin installed without devDeps`);
} catch (e) {
  fail("preflight", `installed artifact setup failed: ${String(e.message ?? e).slice(0, 200)}`);
  printSummary();
  process.exit(1);
}
const gateway = spawnLogged("gateway", "node", [installedGateway], {
  PORT: String(GW_PORT), UPSTREAM_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1`,
  TYPESAFE_BASE_URL: `http://127.0.0.1:${JEV_PORT}`, TYPESAFE_API_KEY: "jev-sentinel", JEV_CLIENT: "acceptance",
});
try {
  await waitFor(async (signal) => {
    try { const r = await httpGet(GW_PORT, "/health", signal); return r === 200; } catch { return false; }
  }, 60000, "gateway health");
} catch (e) {
  fail("preflight", `${e.message} gateway-log=${JSON.stringify(gateway.log.join("").slice(-800))}`);
  printSummary();
  process.exit(1);
}

// --- scenarios (direct-to-stub) -------------------------------------------
writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`);
{
  const r = await runOpencode(bin, iso, project, ["run", "--standalone", "say hello"]);
  if (r.code === 0 && r.out.includes("acceptance-final-answer")) report("text-roundtrip", "PASS", "stub text reached session");
  else fail("text-roundtrip", `exit=${r.code} out=${JSON.stringify(r.out.slice(0, 200))} err=${JSON.stringify(r.err.slice(0, 200))} serverlog=${JSON.stringify(serverLogTail(iso).slice(-1200))}`);
}
{
  writeFileSync(join(project, "readable.txt"), "fixture content\n");
  writeFileSync(join(project, "toolmode"), `read {"path":"${join(project, "readable.txt")}"}`);
  const r = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "read the fixture file"]);
  const entries = modelLog();
  const posts = entries.filter((e) => e.url?.startsWith("/v1/chat/completions"));
  const callIds = new Set();
  let linked = false;
  for (const e of posts) {
    try {
      const j = JSON.parse(e.body);
      for (const m of j.messages ?? []) {
        for (const c of m.tool_calls ?? []) if (c.id) callIds.add(c.id);
        if (m.role === "tool" && m.tool_call_id && callIds.has(m.tool_call_id)) linked = true;
      }
    } catch {}
  }
  try { rmSync(join(project, "toolmode")); } catch {}
  if (r.code === 0 && r.out.includes("acceptance-final-answer") && linked) report("native-tool-loop", "PASS", "call/result linked by id, final answer shown");
  else fail("native-tool-loop", `exit=${r.code} linked=${linked} out=${JSON.stringify(r.out.slice(0, 160))}`);
}
{
  const logFile = join(iso.data, "opencode/log/opencode.log");
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  if (/mcp connected.*fixture.*tools=3/.test(log))
    report("mcp-connection", "PASS", "server connected fixture with 3 tools (log evidence only)");
  else fail("mcp-connection", "no fixture-tools=3 line in server log");
}
const allowedMcp = new Set();
for (const codemode of [false, true]) for (const denied of [false, true]) {
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`, { permission: { fixture_test_write: denied ? "deny" : "allow" } });
  const configPath = join(project, "opencode.json");
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  cfg.mcp.servers.fixture.codemode = codemode;
  writeFileSync(configPath, JSON.stringify(cfg));
  const marker = codemode ? "nested-mcp-proof" : "direct-mcp-proof";
  writeFileSync(join(project, "toolmode"), `@mcp ${JSON.stringify({ codemode, denied, marker, warmup: configPath, noWarmup: pin.firstTurnReady })}`);
  // The first-turn snapshot races MCP startup in v2.0.12. A realistic
  // response delay lets its debounced catalog update precede continuation.
  writeFileSync(join(project, "delayms"), pin.firstTurnReady ? "0" : "1200");
  const before = modelLog().length;
  const result = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "Use the disposable fixture tool once."]);
  rmSync(join(project, "delayms"));
  rmSync(join(project, "toolmode"));
  const counter = readFileSync(join(project, "counter.log"), "utf8");
  const bodies = modelLog().slice(before).map((e) => JSON.parse(e.body || "{}"));
  const roster = bodies.flatMap((b) => (b.tools ?? []).map((t) => t.function?.name ?? t.name));
  const results = bodies.flatMap((b) => b.messages ?? []).filter((m) => m.role === "tool");
  const searchIds = new Set(bodies.flatMap((body) => body.messages ?? []).flatMap((message) => message.tool_calls ?? [])
    .filter((call) => call.function?.name === "execute" && call.function.arguments.includes("search("))
    .map((call) => call.id));
  const searchResults = results.filter((message) => searchIds.has(message.tool_call_id));
  const discovered = codemode
    ? searchResults.some((m) => JSON.stringify(m.content).includes("tools.fixture.test_write"))
    : roster.includes("fixture_test_write");
  const check = `${codemode ? "mcp-codemode" : "mcp"}-${denied ? "denial" : "invocation"}`;
  const attempts = bodies.flatMap((b) => b.messages ?? []).flatMap((m) => m.tool_calls ?? []);
  const attempted = attempts.some((c) => codemode
    ? c.function?.name === "execute" && c.function.arguments.includes("test_write")
    : c.function?.name === "fixture_test_write");
  const refusal = results.some((m) => /not available|Unknown tool|No tool named|denied|not allowed|not currently available/i.test(JSON.stringify(m.content)));
  // The same connected fixture must first execute successfully under allow. Under deny its
  // exact action disappears from the model-visible catalog and the attempted call has no effect.
  const hidden = codemode ? searchResults.length > 0 && !discovered : !roster.includes("fixture_test_write");
  const verified = denied ? allowedMcp.has(codemode) && hidden && counter === "" && attempted && refusal
    : counter === `write:${marker}\n` && discovered;
  if (!denied && verified && result.code === 0) allowedMcp.add(codemode);
  if (result.code === 0 && verified && result.out.includes("acceptance-final-answer")) {
    report(check, "PASS", denied ? "adversarial call refused; zero MCP side effects" : "actual discovery, one tools/call side effect, final answer");
  } else {
    fail(check, `exit=${result.code} discovered=${discovered} counter=${JSON.stringify(counter)} output=${JSON.stringify(result.out.slice(-400))}`);
  }
}
{
  // Exercise actual pending permissions on the supported v2 server API.
  // Unlike CLI --auto / no-TTY refusal, the model pauses before an MCP
  // mutation and the test explicitly approves or rejects that request.
  const { OpenCode } = await import("@opencode/client");
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`);
  const server = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(SERVER_PORT)], {
    detached: true, cwd: project, env: hermeticEnv(iso), stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  server.on("error", (error) => serverLog.push(`spawn error: ${error.message}`));
  server.stdout.on("data", (d) => serverLog.push(d.toString()));
  server.stderr.on("data", (d) => serverLog.push(d.toString()));
  children.push({ name: "permission-server", child: server, log: serverLog });
  try {
    await waitFor(() => /server password (\S+)/.test(serverLog.join("")), 20000, "ephemeral server authentication");
    const password = serverLog.join("").match(/server password (\S+)/)[1];
    const client = OpenCode.make({
      fetch: boundedFetch,
      baseUrl: `http://127.0.0.1:${SERVER_PORT}`,
      headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
    });
    await waitFor(async (signal) => {
      try { await client.server.info({ signal }); return true; } catch { return false; }
    }, 20000, "permission server");
    for (const codemode of [false, true]) for (const decision of ["once", "reject"]) {
      writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`);
      const path = join(project, "opencode.json");
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      cfg.mcp.servers.fixture.codemode = codemode;
      writeFileSync(path, JSON.stringify(cfg));
      await client.location.reload();
      await waitFor(async (signal) => {
        const servers = await client.mcp.list({ location: { directory: project } }, { signal });
        return servers.data.some((s) => s.name === "fixture" && s.status.status === "connected");
      }, 30000, "MCP server startup before first prompt");
      const marker = `${codemode ? "nested" : "direct"}-${decision}`;
      // Connected status precedes the debounced tool-registry refresh.
      // Retain the bounded harmless first turn; this suite qualifies
      // permission decisions, not cold first-request catalog readiness.
      writeFileSync(join(project, "toolmode"), `@mcp ${JSON.stringify({ codemode, marker, warmup: path, noWarmup: pin.firstTurnReady })}`);
      writeFileSync(join(project, "delayms"), pin.firstTurnReady ? "0" : "1200");
      const session = await client.session.create({
        location: { directory: project }, model: { providerID: "acc-probe", id: "acc-model" },
        permissions: [
          { action: "*", resource: "*", effect: "allow" },
          { action: "fixture_test_write", resource: "*", effect: "ask" },
        ],
      });
      await client.session.prompt({ sessionID: session.id, text: "Invoke the disposable MCP fixture once." });
      let pending;
      await waitFor(async (signal) => {
        pending = (await client.permission.list({ sessionID: session.id }, { signal })).find((p) => p.action === "fixture_test_write");
        return Boolean(pending);
      }, 30000, "pending MCP permission");
      const before = readFileSync(join(project, "counter.log"), "utf8");
      if (before !== "") throw new Error("MCP mutated before approval");
      await client.permission.reply({ sessionID: session.id, requestID: pending.id, decision });
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30000) });
      const actual = readFileSync(join(project, "counter.log"), "utf8");
      const expected = decision === "once" ? `write:${marker}\n` : "";
      const check = `mcp-${codemode ? "nested" : "direct"}-ask-${decision}`;
      if (actual === expected) report(check, "PASS", "pending request observed; no pre-approval mutation; exact post-reply counter");
      else fail(check, `counter=${JSON.stringify(actual)}`);
      rmSync(join(project, "delayms"));
      rmSync(join(project, "toolmode"));
    }
    for (const phase of ["before-approval", "before-commit", "after-commit"]) {
      writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`);
      const path = join(project, "opencode.json");
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      const eventsPath = join(project, `events-${phase}.jsonl`);
      const releasePath = join(project, `release-${phase}`);
      cfg.mcp.servers.fixture.environment.FIXTURE_EVENTS = eventsPath;
      if (phase === "before-commit") cfg.mcp.servers.fixture.environment.FIXTURE_BEFORE_COMMIT = releasePath;
      if (phase === "after-commit") cfg.mcp.servers.fixture.environment.FIXTURE_AFTER_COMMIT = releasePath;
      writeFileSync(path, JSON.stringify(cfg));
      await client.location.reload();
      const events = () => existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
      writeFileSync(join(project, "toolmode"), `@mcp ${JSON.stringify({ marker: phase, warmup: path })}`);
      writeFileSync(join(project, "delayms"), "1200");
      const session = await client.session.create({
        location: { directory: project }, model: { providerID: "acc-probe", id: "acc-model" },
        permissions: [
          { action: "*", resource: "*", effect: "allow" },
          { action: "fixture_test_write", resource: "*", effect: phase === "before-approval" ? "ask" : "allow" },
        ],
      });
      const prompt = { sessionID: session.id, id: `msg_fixture_${phase}`, text: "One disposable fixture mutation." };
      await client.session.prompt(prompt);
      await waitFor(async (signal) => phase === "before-approval"
        ? (await client.permission.list({ sessionID: session.id }, { signal })).some((p) => p.action === "fixture_test_write")
        : events().some((e) => e.event === (phase === "before-commit" ? "started" : "committed")),
      30000, `mutation checkpoint ${phase}`);
      const expected = phase === "after-commit" ? `write:${phase}\n` : "";
      if (readFileSync(join(project, "counter.log"), "utf8") !== expected) throw new Error(`wrong pre-interrupt counter at ${phase}`);
      await client.session.interrupt({ sessionID: session.id });
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30000) });
      if (phase !== "before-approval") await waitFor(() => events().some((e) => e.event === "cancelled"), 5000, "MCP cancellation notification");
      writeFileSync(releasePath, "release");
      rmSync(join(project, "toolmode"));
      rmSync(join(project, "delayms"));
      // Exact retry of the same admitted input must not replay a committed
      // or cancelled tool call. The scripted model now returns text only.
      await client.session.prompt(prompt);
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30000) });
      const commits = events().filter((e) => e.event === "committed").length;
      const starts = events().filter((e) => e.event === "started").length;
      const valid = readFileSync(join(project, "counter.log"), "utf8") === expected
        && commits === Number(phase === "after-commit") && starts === Number(phase !== "before-approval");
      if (valid) report(`mcp-cancel-${phase}`, "PASS", `exact prompt retry: starts=${starts}, commits=${commits}`);
      else fail(`mcp-cancel-${phase}`, `starts=${starts}, commits=${commits}`);
    }
    // Keep the same authenticated server alive across plugin changes. Each
    // primary request must consult Jev once when enabled, zero when disabled,
    // including a repeated reload that used to be untested by fresh CLIs.
    await rejev("read");
    for (const phase of ["enable", "disable", "reenable", "reload"]) {
      const enabled = phase !== "disable";
      writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`, {
        rest: { plugins: [{ package: packagedPluginDir, options: { gatewayUrl: GW.replace(/\/v1$/, ""), timeoutMs: 8000, enabled } }] },
      });
      await client.location.reload();
      const before = modelLog().length;
      const consultations = jevCalls();
      const session = await client.session.create({ location: { directory: project }, model: { providerID: "acc-probe", id: "acc-model" } });
      await client.session.prompt({ sessionID: session.id, text: `Plugin lifecycle ${phase}.` });
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30000) });
      const sent = modelLog().slice(before);
      const hints = sent.filter((r) => (r.body ?? "").includes("[jev-routing]")).length;
      const delta = jevCalls() - consultations;
      if (delta === Number(enabled) && hints === Number(enabled)) {
        report(`plugin-lifecycle-${phase}`, "PASS", `Jev calls=${delta}, hint-bearing requests=${hints}`);
      } else fail(`plugin-lifecycle-${phase}`, `Jev calls=${delta}, hint-bearing requests=${hints}`);
    }
    await rejev("no_tool_needed");
  } catch (error) {
    fail("mcp-interactive-permissions", error.message);
  } finally {
    killChild(server, "SIGTERM");
  }
}
{
  // selection through the real binary + gateway: mock-jev picks read (open
  // schema, so delegation must be forced with tool_choice, never direct).
  await rejev("read,no_tool_needed");
  writeProject(GW);
  const marker = "selection-read-proof";
  writeFileSync(join(project, "readable.txt"), `${marker}\n`);
  writeFileSync(join(project, "toolmode"), `read ${JSON.stringify({ path: join(project, "readable.txt") })}`);
  const before = modelLog().length;
  const jevBefore = jevCalls();
  const r = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "read the fixture file"]);
  const entries = modelLog().slice(before);
  const forced = entries.some((e) => {
    try { return JSON.stringify(JSON.parse(e.body).tool_choice ?? "").includes("read"); } catch { return false; }
  });
  const jevDelta = jevCalls() - jevBefore;
  const executed = entries.some((e) => {
    try { return (JSON.parse(e.body).messages ?? []).some((m) => m.role === "tool" && JSON.stringify(m.content).includes(marker)); } catch { return false; }
  });
  rmSync(join(project, "toolmode"));
  await rejev("no_tool_needed");
  if (r.code === 0 && forced && executed && jevDelta > 0 && r.out.includes("acceptance-final-answer"))
    report("selection-via-opencode", "PASS", "Jev selection reached model as forced tool_choice, tool ran");
  else fail("selection-via-opencode", `exit=${r.code} forced=${forced} jevDelta=${jevDelta}`);
}
{
  // Direct synthesis through OpenCode must actually invoke the MCP tool
  // once, return its result to the model, and skip the corresponding model
  // request. A log mode alone or a fabricated result is insufficient.
  await rejev("read,fixture_test_status,no_tool_needed");
  writeProject(GW);
  writeFileSync(join(project, "toolmode"), `@status ${JSON.stringify({ warmup: join(project, "opencode.json") })}`);
  writeFileSync(join(project, "delayms"), "1200");
  rmSync(join(project, "counter.log.status"), { force: true });
  const before = modelLog().length;
  const logBefore = gateway.log.join("").length;
  const result = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "Read the fixture status once."]);
  const requests = modelLog().slice(before).map((e) => JSON.parse(e.body || "{}"));
  const primary = requests.filter((b) => (b.tools ?? []).length);
  const seenResult = primary.some((b) => (b.messages ?? []).some((m) => m.role === "tool" && JSON.stringify(m.content).includes("fixture-status:ready")));
  const direct = gateway.log.join("").slice(logBefore).split("\n").some((line) => {
    try { const e = JSON.parse(line); return e.mode === "direct" && e.tool === "fixture_test_status"; } catch { return false; }
  });
  const count = existsSync(join(project, "counter.log.status")) ? readFileSync(join(project, "counter.log.status"), "utf8") : "";
  if (result.code === 0 && direct && count === "read\n" && primary.length === 2 && seenResult && result.out.includes("acceptance-final-answer"))
    report("direct-via-opencode", "PASS", "one real MCP status call; result returned; one model request skipped");
  else fail("direct-via-opencode", `exit=${result.code} direct=${direct} count=${JSON.stringify(count)} modelRequests=${primary.length} result=${seenResult}`);
  rmSync(join(project, "toolmode"));
  rmSync(join(project, "delayms"));
  await rejev("no_tool_needed");
}
{
  // Plugin influence + lifecycle through the real binary, using the
  // PACKAGED plugin directory (installed tarball, no dev dependencies).
  // It must load, run its context hook once per primary request, and
  // append the routing hint to the outgoing traffic. mock-jev is scripted
  // to pick `read` so a hint is expected.
  {
    const pluginDir = packagedPluginDir;
    await rejev("read");
    writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`, { rest: { plugins: [{ package: pluginDir, options: { gatewayUrl: GW.replace(/\/v1$/, ""), timeoutMs: 8000 } }] } });
    const first = modelLog().length;
    const r = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "read the fixture file"]);
    const hints = modelLog().slice(first).filter((e) => (e.body ?? "").includes("[jev-routing]")).length;
    await rejev("no_tool_needed");
    if (r.code === 0 && hints === 1 && r.out.includes("acceptance-final-answer"))
      report("plugin-influence", "PASS", `routing hint reached model traffic ${hints}x, session completed (load+hook proven)`);
    else fail("plugin-influence", `exit=${r.code} hints=${hints}`);

    // Fail-open: with the gateway down, the loaded plugin must not break
    // the run and must append no hint.
    writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`, { rest: { plugins: [{ package: pluginDir, options: { gatewayUrl: "http://127.0.0.1:19999", timeoutMs: 2000 } }] } });
    const before = modelLog().length;
    const r2 = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "read the fixture file"]);
    const hints2 = modelLog().slice(before).filter((e) => (e.body ?? "").includes("[jev-routing]")).length;
    writeProject(GW);
    if (r2.code === 0 && hints2 === 0 && r2.out.includes("acceptance-final-answer"))
      report("plugin-fail-open", "PASS", "dead gateway left the run untouched, no hint");
    else fail("plugin-fail-open", `exit=${r2.code} hints=${hints2}`);
  }
  {
    // Plugin-only isolation: the provider talks straight to the stub (the
    // proxy is nowhere in the path), so any routing hint can only come
    // from the plugin's own context hook.
    const pluginDir = packagedPluginDir;
    await rejev("read");
    writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`, {
      rest: { plugins: [{ package: pluginDir, options: { gatewayUrl: GW.replace(/\/v1$/, ""), timeoutMs: 8000 } }] },
    });
    const before = modelLog().length;
    const jevBefore = jevCalls();
    const r = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "read the fixture file"]);
    const hints = modelLog().slice(before).filter((e) => (e.body ?? "").includes("[jev-routing]")).length;
    // Provider baseURL above points at the stub, so the proxy is
    // structurally absent: hints plus a Jev consultation prove the plugin
    // path alone.
    const jevDelta = jevCalls() - jevBefore;
    await rejev("no_tool_needed");
    writeProject(GW);
    if (r.code === 0 && hints === 1 && jevDelta === 1 && r.out.includes("acceptance-final-answer"))
      report("plugin-only-influence", "PASS", `hint from plugin alone ${hints}x, Jev consulted ${jevDelta}x`);
    else fail("plugin-only-influence", `exit=${r.code} hints=${hints} jevDelta=${jevDelta}`);
  }
}
{
  // multi-turn: continue latest session, assert history grows without server refs
  const list = spawnSync(bin, ["session", "list"], { cwd: project, env: hermeticEnv(iso), encoding: "utf8", timeout: 30000 });
  const id = (list.stdout.match(/ses_[a-zA-Z0-9]+/) || [])[0];
  const before = modelLog().length;
  const r = await runOpencode(bin, iso, project, ["run", "--standalone", "--continue", "--session", id, "and again"]);
  const after = modelLog().slice(before).filter((e) => e.url?.startsWith("/v1/chat/completions"));
  const last = after.at(-1);
  let grew = false, noRefs = true, noStaleHints = false;
  try {
    const j = JSON.parse(last.body);
    grew = (j.messages?.length ?? 0) > 2;
    noRefs = !JSON.stringify(j).includes("previous_response_id");
    noStaleHints = !JSON.stringify(j.messages).includes("[jev-routing]");
  } catch {}
  if (r.code === 0 && grew && noRefs && noStaleHints) report("multi-turn-continuity", "PASS", "full history resent, no server refs or persisted advisory hints");
  else fail("multi-turn-continuity", `exit=${r.code} grew=${grew} noRefs=${noRefs} noStaleHints=${noStaleHints}`);
}
{
  // First prove this exact native tool works; missing tools are not permission evidence.
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`, { permission: { edit: "allow" } });
  const allowedPath = join(project, "allowed-write.txt");
  writeFileSync(join(project, "toolmode"), `write ${JSON.stringify({ path: allowedPath, content: "allowed-sentinel" })}`);
  const allowed = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "write the allowed fixture file"]);
  const allowVerified = allowed.code === 0 && existsSync(allowedPath) && readFileSync(allowedPath, "utf8") === "allowed-sentinel";
  // Deny removes the same native action and must prevent its adversarial invocation.
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`, { permission: { edit: "deny" } });
  writeFileSync(join(project, "toolmode"), `@adversarial-write {"path":"${join(project, "must-not-exist.txt")}", "content": "x"}`);
  const before = modelLog().length;
  const r = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "write the file"]);
  try { rmSync(join(project, "toolmode")); } catch {}
  const absent = !existsSync(join(project, "must-not-exist.txt"));
  const attempted = modelLog().slice(before).some((entry) => JSON.parse(entry.body || "{}").messages?.some((message) =>
    message.tool_calls?.some((call) => call.function?.name === "write")));
  if (r.code === 0 && absent && attempted && allowVerified) report("deny-write-side-effect-free", "PASS", "allow control executed; denied adversarial write left no file");
  else fail("deny-write-side-effect-free", `exit=${r.code} absent=${absent}`);
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`);
}
{
  // ask: interactive approval has no TTY here; the run must still be safe
  // (no execution) whether it errors or completes.
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`, { permission: { edit: "ask" } });
  writeFileSync(join(project, "toolmode"), `write {"path":"${join(project, "must-not-exist-ask.txt")}", "content": "x"}`);
  const before = modelLog().length;
  const r = await runOpencode(bin, iso, project, ["run", "--standalone", "write the file"]);
  try { rmSync(join(project, "toolmode")); } catch {}
  const absent = !existsSync(join(project, "must-not-exist-ask.txt"));
  const attempted = modelLog().slice(before).some((entry) => entry.plannedTool === "write");
  if (absent && attempted && r.signal === null && typeof r.code === "number") report("ask-write-safe-default", "PASS", `no TTY approval executed nothing (exit=${r.code})`);
  else fail("ask-write-safe-default", `exit=${r.code} absent=${absent}`);
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`);
}

// --- scenarios (gateway in loop) ------------------------------------------
{
  // image bypass: provider -> gateway with the plugin enabled, screenshot
  // attached. Both the proxy guard and the plugin's multimodal skip must
  // hold: the image reaches the model while Jev sees zero calls across the
  // whole session.
  writeProject(GW, { rest: { plugins: [{ package: packagedPluginDir, options: { gatewayUrl: GW.replace(/\/v1$/, ""), timeoutMs: 8000 } }] } });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  writeFileSync(join(project, "shot.png"), png);
  const jevBefore = jevCalls();
  const r = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "-f", join(project, "shot.png"), "describe this screenshot"]);
  const entries = modelLog();
  const sawImage = entries.some((e) => /image_url|input_image|inlineData/.test(e.body ?? ""));
  const jevDelta = jevCalls() - jevBefore;
  // NOTE: jevDelta===0 is asserted (not just reported): with an image in
  // the conversation neither the proxy nor the plugin may consult Jev.
  if (r.code === 0 && sawImage && jevDelta === 0 && r.out.includes("acceptance-final-answer"))
    report("image-bypass-via-gateway", "PASS", "image reached model, 0 Jev calls");
  else fail("image-bypass-via-gateway", `exit=${r.code} sawImage=${sawImage} jevDelta=${jevDelta}`);
}
{
  // credentials: every stub hit carries the client sentinel and never the Jev one
  const entries = modelLog();
  const ok = entries.length > 0 && entries.every((e) => e.hasClientSentinel && !e.hasJevSentinel);
  if (ok) report("credentials-routing", "PASS", `${entries.length} stub hits all client-sentinel, none jev-sentinel`);
  else fail("credentials-routing", "missing client sentinel or leaked jev sentinel in stub log");
}
{
  // Jev-side credential: a dedicated gateway pointed at the auth shim must
  // present exactly the Jev sentinel (dummy values only, isolated temp dir).
  const authLog = join(work, "jev-auth.log");
  const auth = spawnLogged("authshim", "node", [FIX("acceptance-jev-auth.mjs")], { PORT: String(AUTH_PORT), LOG: authLog });
  const gw2 = spawnLogged("gateway2", "node", [installedGateway], {
    PORT: String(GW2_PORT), UPSTREAM_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1`,
    TYPESAFE_BASE_URL: `http://127.0.0.1:${AUTH_PORT}`, TYPESAFE_API_KEY: "jev-sentinel", JEV_CLIENT: "acceptance",
  });
  try {
    await waitFor(async (signal) => {
      try { const r = await httpGet(GW2_PORT, "/health", signal); return r === 200; } catch { return false; }
    }, 60000, "gateway2 health");
  } catch (e) {
    fail("preflight", e.message);
    printSummary();
    process.exit(1);
  }
  writeProject(`http://127.0.0.1:${GW2_PORT}/v1`);
  await runOpencode(bin, iso, project, ["run", "--standalone", "credential probe"]);
  killChild(gw2.child); killChild(auth.child);
  const lines = existsSync(authLog) ? readFileSync(authLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const good = lines.length > 0 && lines.every((l) => l.expectedSentinel === true);
  if (good) report("jev-auth-credential", "PASS", `${lines.length} Jev hits all Bearer jev-sentinel`);
  else fail("jev-auth-credential", `hits=${lines.length}, sentinel equality failed`);
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`);
}
{
  // standalone isolation: no shared service needed; explicit dead --server fails fast (honored, not ignored)
  spawnSync(bin, ["service", "stop"], { cwd: project, env: hermeticEnv(iso), timeout: 30000 });
  const r = await runOpencode(bin, iso, project, ["run", "--standalone", "isolation check"]);
  const solo = r.code === 0 && r.out.includes("acceptance-final-answer");
  const dead = await runOpencode(bin, iso, project, ["run", "--server", "http://127.0.0.1:19999", "dead server check"], {}, 45000);
  const honored = dead.code !== 0;
  if (solo && honored) report("standalone-isolation", "PASS", "private server works; explicit --server honored (fast fail)");
  else fail("standalone-isolation", `solo=${solo} honored=${honored}`);
  const api = await httpGet(GW_PORT, "/health").catch(() => 0) === 200;
  // This verifies an explicit address reaches the intended service; the
  // dead --server run above verifies OpenCode honors (not ignores) the flag.
  if (api) report("gateway-health", "PASS", "explicit gateway URL serves /health (not a remote-session test)");
  else fail("gateway-health", "explicit gateway URL unreachable");
}
{
  // Existing shared service: the service runs on its own stub-backed
  // project (separate port), so any traffic the dead attached run sends to
  // the service's stub is unambiguous cross-talk. Observed: an attached run
  // resolves its own project config and never touches the service endpoint.
  const model2 = spawnLogged("model2", "node", [FIX("acceptance-model.mjs")],
    { PORT: String(MODEL2_PORT), LOG: join(work, "model2-requests.log"), SCENARIO_FILE: join(work, "nosuchtoolmode") });
  try {
  await waitFor(() => model2.log.join("").includes(`acceptance-model on 127.0.0.1:${MODEL2_PORT}`), 15000, "model2 stub");
} catch (e) {
  fail("preflight", e.message);
  printSummary();
  process.exit(1);
}
  const model2Log = () => readFileSync(join(work, "model2-requests.log"), "utf8").split("\n").filter(Boolean);
  const svcCfg = {
    $schema: "https://opencode.ai/config.json", model: "acc-probe/acc-model", small_model: "acc-probe/acc-model",
    provider: { "acc-probe": { npm: "@ai-sdk/openai-compatible", name: "Svc",
      options: { baseURL: `http://127.0.0.1:${MODEL2_PORT}/v1`, apiKey: "k", timeout: 15000 },
      models: { "acc-model": { name: "Svc", tools: false } } } },
  };
  writeFileSync(join(project, "opencode.json"), JSON.stringify(svcCfg, null, 2));
  const startedService = spawnSync(bin, ["service", "start"], { cwd: project, env: hermeticEnv(iso), timeout: 30000 });
  const controlBefore = model2Log().length;
  const control = await runOpencode(bin, iso, project, ["run", "shared service control"]);
  const sharedVerified = startedService.status === 0 && control.code === 0
    && control.out.includes("acceptance-final-answer") && model2Log().length > controlBefore;
  // Let any straggler traffic from earlier scenarios land before measuring.
  await sleep(3000);
  const deadProject = join(work, "deadproject");
  mkdirSync(deadProject, { recursive: true });
  const deadCfg = {
    $schema: "https://opencode.ai/config.json", model: "acc-probe/acc-model", small_model: "acc-probe/acc-model",
    provider: { "acc-probe": { npm: "@ai-sdk/openai-compatible", name: "Dead",
      options: { baseURL: "http://127.0.0.1:19999/v1", apiKey: "dead", timeout: 15000 },
      models: { "acc-model": { name: "Dead", tools: false } } } },
  };
  writeFileSync(join(deadProject, "opencode.json"), JSON.stringify(deadCfg));
  const svcBefore = model2Log().length;
  const r = await runOpencode(bin, iso, deadProject, ["run", "attached probe"], {}, 90000);
  const svcAfter = model2Log().length;
  spawnSync(bin, ["service", "stop"], { cwd: project, env: hermeticEnv(iso), timeout: 30000 });
  killChild(model2.child);
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`);
  if (sharedVerified && r.code !== 0 && r.signal === null && svcAfter === svcBefore)
    report("shared-service-existing", "PASS", `attached dead-config run failed (exit=${r.code}), 0 service-stub hits`);
  else fail("shared-service-existing", `exit=${r.code} serviceStubDelta=${svcAfter - svcBefore}`);
}
{
  // No duplicate invocation: history legitimately repeats prior calls, so
  // balance is checked per request — every call in a request's history must
  // have exactly one matching result, and ids must be unique within a
  // request. A retried/duplicated execution would show an unbalanced pair.
  const entries = modelLog();
  let pairs = 0, unbalanced = 0;
  const seenResponses = new Set();
  for (const e of entries) {
    let j;
    try { j = JSON.parse(e.body); } catch { continue; }
    const inReq = [];
    const outs = [];
    for (const m of j.messages ?? []) {
      for (const c of m.tool_calls ?? []) inReq.push(c.id);
      if (m.role === "tool") outs.push(m.tool_call_id);
    }
    for (const it of j.input ?? []) {
      if (it.type === "function_call" && it.call_id) inReq.push(it.call_id);
      if (typeof it.type === "string" && it.type.endsWith("_call_output") && it.call_id) outs.push(it.call_id);
    }
    const reqIds = new Set(inReq);
    if (reqIds.size !== inReq.length) unbalanced++;
    for (const id of reqIds) {
      if (seenResponses.has(id)) continue; // history echo of an earlier call
      seenResponses.add(id);
    }
    for (const id of new Set(outs)) {
      if (seenResponses.has(id)) pairs++;
      else unbalanced++;
    }
  }
  if (pairs > 0 && unbalanced === 0) report("balanced-tool-execution", "PASS", `${pairs} call/result pairs balanced, no orphaned or duplicated calls`);
  else fail("balanced-tool-execution", `pairs=${pairs} unbalanced=${unbalanced}`);
}
{
  // Cancellation: with the model delayed past the kill, SIGINT must stop
  // the run without executing the tool and without later retry traffic.
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`);
  writeFileSync(join(project, "readable.txt"), "fixture content\n");
  writeFileSync(join(project, "toolmode"), `read {"path":"${join(project, "readable.txt")}"}`);
  writeFileSync(join(project, "delayms"), "20000");
  const before = modelLog().length;
  const killed = await new Promise((resolve) => {
    const env = hermeticEnv(iso);
    const child = spawn(bin, ["run", "--standalone", "--auto", "read the fixture file"],
      { detached: true, cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push({ name: "cancel-run", child, log: [] });
    child.stderr.resume();
    let out = "";
    let interrupt;
    child.stdout.on("data", (d) => (out += d.toString()));
    // SIGINT only after the first stub hit proves the run is in flight;
    // node reports SIGINT deaths as code 130 with null signal.
    const poll = setInterval(() => {
      if (modelLog().length > before) {
        clearInterval(poll);
        interrupt = setTimeout(() => { try { child.kill("SIGINT"); } catch {} }, 2000);
      }
    }, 500);
    const guard = setTimeout(() => { clearInterval(poll); killChild(child); }, 60000);
    const finish = (code, signal) => { clearInterval(poll); clearTimeout(guard); clearTimeout(interrupt); resolve({ code, signal, out }); };
    child.on("error", () => finish(null, "spawn-error"));
    child.on("close", finish);
  });
  await sleep(8000);
  try { rmSync(join(project, "delayms")); rmSync(join(project, "toolmode")); } catch {}
  const after = modelLog().length;
  await sleep(1000);
  const settled = modelLog().length;
  const sigintDeath = killed.signal === "SIGINT" || killed.code === 130;
  if (sigintDeath && after > before && settled === after)
    report("cancellation-no-retry-storm", "PASS", `SIGINT stopped run, stub traffic settled at ${settled - before} (no post-kill retries)`);
  else fail("cancellation-no-retry-storm", `signal=${killed.signal} code=${killed.code} before=${before} after=${after} settled=${settled}`);
}

} catch (error) {
  fail("harness", String(error.message ?? error).replace(/(Bearer|Basic)\s+\S+/gi, "$1 [redacted]"));
}
} // end if (!blocked): binary-driven scenarios require a usable binary

function printSummary() {
  for (const name of ALL_CHECKS) {
    if (!results.some((r) => r.name === name)) fail(name, "required check did not execute");
  }
  const blockedNames = results.filter((r) => r.status === "BLOCKED").map((r) => r.name);
  // Required checks are never exempted from the gate.
  const unexpectedBlocked = blockedNames;
  if (unexpectedBlocked.length) {
    console.log(`\nFAIL: unexpected BLOCKED checks: ${unexpectedBlocked.join(", ")}`);
    process.exit(1);
  }
  console.log(`\n${results.filter((r) => r.status === "PASS").length} passed, ${failed} failed, ${blockedNames.length} blocked`);
}
printSummary();
process.exit(failed ? 1 : 0);
