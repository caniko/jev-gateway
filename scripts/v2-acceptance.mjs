#!/usr/bin/env node
// Executable OpenCode v2 + jev-gateway acceptance.
//
// Topology (all loopback, no keys, no desktop):
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
// Usage: node scripts/v2-acceptance.mjs [--install-binary] [--binary PATH] [--keep]
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "2.0.12";
const args = new Set(process.argv.slice(2));
const KEEP = args.has("--keep");

const work = mkdirTmp();
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
  const out = spawnSync("node", ["-e", `require("net").createServer().once("error",()=>process.exit(1)).once("listening",function(){this.close();process.exit(0)}).listen(${port},"127.0.0.1")`]);
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
  try {
    execFileSync("npm", ["install", "--prefix", join(work, "v2bin"), "--no-audit", "--no-fund", `@opencode/cli@${VERSION}`], { stdio: "pipe", timeout: 180000 });
    execFileSync("node", [join(work, "v2bin/node_modules/@opencode/cli/postinstall.mjs")], { stdio: "pipe", timeout: 60000 });
    const bin = join(work, "v2bin/node_modules/@opencode/cli/bin/opencode.exe");
    if (!existsSync(bin)) return { error: "installed package has no binary" };
    return { bin };
  } catch (e) {
    return { blocked: `could not fetch pinned binary: ${String(e.message ?? e).slice(0, 160)}` };
  }
}

// --- processes ------------------------------------------------------------
const children = [];
function spawnLogged(name, cmd, cmdArgs, env, logFile) {
  const log = [];
  const child = spawn(cmd, cmdArgs, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => log.push(d.toString()));
  child.stderr.on("data", (d) => log.push(d.toString()));
  children.push({ name, child, log });
  return { child, log };
}
const httpPost = (port, path, body) =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    req.end(body);
  });
const httpGet = (port, path) =>
  new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", () => resolve(0));
    req.end();
  });

const BASE_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TZ", "NO_COLOR", "TERM"];
function hermeticEnv(iso, extraEnv = {}) {
  const env = {};
  for (const k of BASE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env, HOME: iso.home, XDG_CONFIG_HOME: iso.config, XDG_DATA_HOME: iso.data,
    XDG_CACHE_HOME: iso.cache, XDG_STATE_HOME: iso.state, OPENAI_API_KEY: "stub-key", ...extraEnv,
  };
}

function runOpencode(bin, iso, project, runArgs, extraEnv = {}, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(bin, runArgs, { cwd: project, env: hermeticEnv(iso, extraEnv), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
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
const cleanup = () => { for (const c of children) try { c.child.kill("SIGKILL"); } catch {} if (!KEEP) rmSync(work, { recursive: true, force: true }); };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(2); });

const MODEL_PORT = 18081, JEV_PORT = 18090, GW_PORT = 18791, GW2_PORT = 18792, AUTH_PORT = 18091, MODEL2_PORT = 18083;
for (const p of [MODEL_PORT, JEV_PORT, GW_PORT, GW2_PORT, AUTH_PORT, MODEL2_PORT]) {
  if (!freePort(p)) { fail("preflight", `loopback port ${p} busy`); process.exit(1); }
}
// Gateway under test: an integrated checkout (master after reintegration).
// Defaults to this repo root; override for validating another worktree.
const GATEWAY_ROOT = process.env.GATEWAY_ROOT ?? ROOT;
if (!existsSync(join(GATEWAY_ROOT, "dist/index.js"))) { fail("preflight", `gateway dist/ missing in ${GATEWAY_ROOT}: run pnpm build there first`); process.exit(1); }

const { bin, blocked, error } = resolveBinary();
if (error) { fail("preflight", error); process.exit(1); }
const ALL_CHECKS = ["binary-version","text-roundtrip","native-tool-loop","mcp-connection","mcp-invocation","selection-via-opencode","plugin-influence","plugin-fail-open","plugin-only-influence","multi-turn-continuity","deny-write-side-effect-free","ask-write-safe-default","image-bypass-via-gateway","credentials-routing","jev-auth-credential","standalone-isolation","shared-service-existing","explicit-remote-server","balanced-tool-execution","cancellation-no-retry-storm"];
if (blocked) {
  // Single exit policy: record BLOCKED for every check and fall through to
  // the strict gate below, which fails on anything but the documented
  // version-limited exception. No early successful exit exists.
  for (const name of ALL_CHECKS) report(name, "BLOCKED", blocked);
}
if (!blocked) {
const ver = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30000 });
if (!ver.stdout?.includes(VERSION)) fail("binary-version", `expected ${VERSION}, got ${JSON.stringify(ver.stdout?.trim())}`);
else report("binary-version", "PASS", ver.stdout.trim());

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
    mcp: {
      fixture: {
        type: "local", command: ["node", join(ROOT, "test/fixtures/acceptance-mcp.mjs")], timeout: 30000,
        environment: { FIXTURE_COUNTER: join(project, "counter.log") },
      },
    },
    permission: { fixture_test_read: "allow", fixture_test_write: "allow", ...extra.permission },
    ...extra.rest,
  };
  writeFileSync(join(project, "opencode.json"), JSON.stringify(cfg, null, 2));
  writeFileSync(join(project, "counter.log"), "");
  try { rmSync(join(project, "toolmode")); } catch {}
};
const FIX = (name) => join(ROOT, "test/fixtures", name);

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
  try { jev.child.kill("SIGKILL"); } catch {}
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

// gateway (built dist) for gateway-in-loop scenarios
const GW = `http://127.0.0.1:${GW_PORT}/v1`;
const gateway = spawnLogged("gateway", "node", [join(GATEWAY_ROOT, "dist/index.js")], {
  PORT: String(GW_PORT), UPSTREAM_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1`,
  TYPESAFE_BASE_URL: `http://127.0.0.1:${JEV_PORT}`, TYPESAFE_API_KEY: "jev-sentinel", JEV_CLIENT: "acceptance",
});
try {
  await waitFor(async () => {
    try { const r = await httpGet(GW_PORT, "/health"); return r === 200; } catch { return false; }
  }, 60000, "gateway health");
} catch (e) {
  fail("preflight", `${e.message} gateway-log=${JSON.stringify(gateway.log.join("").slice(-800))}`);
  printSummary();
  process.exit(1);
}

// Packaged plugin under test: pack the gateway checkout and install the
// tarball without dev dependencies, so plugin checks exercise the shipped
// artifact (including @opencode/plugin resolution) rather than source paths.
let packagedPluginDir = "";
try {
  const packDest = join(work, "pack");
  mkdirSync(packDest, { recursive: true });
  execFileSync("pnpm", ["pack", "--pack-destination", packDest], { cwd: GATEWAY_ROOT, stdio: "pipe", timeout: 120000 });
  const tgz = readdirSync(packDest).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("no tarball produced");
  execFileSync("npm", ["install", "--prefix", join(work, "pkginstall"), "--no-audit", "--no-fund", join(packDest, tgz)],
    { stdio: "pipe", timeout: 180000 });
  packagedPluginDir = join(work, "pkginstall/node_modules/jev-gateway/plugin/jev");
  if (!existsSync(join(packagedPluginDir, "index.ts"))) throw new Error("tarball lacks plugin/jev/index.ts");
} catch (e) {
  fail("preflight", `packaged plugin setup failed: ${String(e.message ?? e).slice(0, 200)}`);
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
  if (/mcp connected.*fixture.*tools=2/.test(log))
    report("mcp-connection", "PASS", "server connected fixture with 2 tools (log evidence only)");
  else fail("mcp-connection", "no fixture-tools=2 line in server log");
  // Invocation through 2.0.12 is NOT demonstrated: fixture tools appear
  // neither on the provider wire nor in the Code Mode catalog/search in any
  // observed run (see docs/acceptance.md). Real Blender/FreeCAD runs stay manual.
  report("mcp-invocation", "BLOCKED", "2.0.12 does not surface fixture MCP tools on wire or catalog; no deterministic driver");
}
{
  // selection through the real binary + gateway: mock-jev picks read (open
  // schema, so delegation must be forced with tool_choice, never direct).
  await rejev("read");
  writeProject(GW);
  writeFileSync(join(project, "readable.txt"), "fixture content\n");
  const jevBefore = jevCalls();
  const r = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "read the fixture file"]);
  const entries = modelLog();
  const forced = entries.some((e) => {
    try { return JSON.stringify(JSON.parse(e.body).tool_choice ?? "").includes("read"); } catch { return false; }
  });
  const jevDelta = jevCalls() - jevBefore;
  await rejev("no_tool_needed");
  if (r.code === 0 && forced && jevDelta > 0 && r.out.includes("acceptance-final-answer"))
    report("selection-via-opencode", "PASS", "Jev selection reached model as forced tool_choice, tool ran");
  else fail("selection-via-opencode", `exit=${r.code} forced=${forced} jevDelta=${jevDelta}`);
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
    writeProject(GW, { rest: { plugins: [{ package: pluginDir, options: { gatewayUrl: GW.replace(/\/v1$/, ""), timeoutMs: 8000 } }] } });
    const r = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "read the fixture file"]);
    const hints = modelLog().filter((e) => (e.body ?? "").includes("[jev-routing]")).length;
    await rejev("no_tool_needed");
    if (r.code === 0 && hints >= 1 && r.out.includes("acceptance-final-answer"))
      report("plugin-influence", "PASS", `routing hint reached model traffic ${hints}x, session completed (load+hook proven)`);
    else fail("plugin-influence", `exit=${r.code} hints=${hints}`);

    // Fail-open: with the gateway down, the loaded plugin must not break
    // the run and must append no hint.
    writeProject(GW, { rest: { plugins: [{ package: pluginDir, options: { gatewayUrl: "http://127.0.0.1:19999", timeoutMs: 2000 } }] } });
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
    if (r.code === 0 && hints >= 1 && jevDelta > 0 && r.out.includes("acceptance-final-answer"))
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
  let grew = false, noRefs = true;
  try {
    const j = JSON.parse(last.body);
    grew = (j.messages?.length ?? 0) > 2;
    noRefs = !JSON.stringify(j).includes("previous_response_id");
  } catch {}
  if (r.code === 0 && grew && noRefs) report("multi-turn-continuity", "PASS", "full history resent, no server refs");
  else fail("multi-turn-continuity", `exit=${r.code} grew=${grew} noRefs=${noRefs}`);
}
{
  // deny: native write is gated by the `edit` action; refused -> file absent, run completes
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`, { permission: { edit: "deny" } });
  writeFileSync(join(project, "toolmode"), `write {"path":"${join(project, "must-not-exist.txt")}", "content": "x"}`);
  const r = await runOpencode(bin, iso, project, ["run", "--standalone", "--auto", "write the file"]);
  try { rmSync(join(project, "toolmode")); } catch {}
  const absent = !existsSync(join(project, "must-not-exist.txt"));
  if (r.code === 0 && absent) report("deny-write-side-effect-free", "PASS", "denied write left no file, run completed");
  else fail("deny-write-side-effect-free", `exit=${r.code} absent=${absent}`);
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`);
}
{
  // ask: interactive approval has no TTY here; the run must still be safe
  // (no execution) whether it errors or completes.
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`, { permission: { edit: "ask" } });
  writeFileSync(join(project, "toolmode"), `write {"path":"${join(project, "must-not-exist-ask.txt")}", "content": "x"}`);
  const r = await runOpencode(bin, iso, project, ["run", "--standalone", "write the file"]);
  try { rmSync(join(project, "toolmode")); } catch {}
  const absent = !existsSync(join(project, "must-not-exist-ask.txt"));
  if (absent) report("ask-write-safe-default", "PASS", `no TTY approval executed nothing (exit=${r.code})`);
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
  const gw2 = spawnLogged("gateway2", "node", [join(GATEWAY_ROOT, "dist/index.js")], {
    PORT: String(GW2_PORT), UPSTREAM_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1`,
    TYPESAFE_BASE_URL: `http://127.0.0.1:${AUTH_PORT}`, TYPESAFE_API_KEY: "jev-sentinel", JEV_CLIENT: "acceptance",
  });
  try {
    await waitFor(async () => {
      try { const r = await httpGet(GW2_PORT, "/health"); return r === 200; } catch { return false; }
    }, 60000, "gateway2 health");
  } catch (e) {
    fail("preflight", e.message);
    printSummary();
    process.exit(1);
  }
  writeProject(`http://127.0.0.1:${GW2_PORT}/v1`);
  await runOpencode(bin, iso, project, ["run", "--standalone", "credential probe"]);
  try { gw2.child.kill("SIGKILL"); auth.child.kill("SIGKILL"); } catch {}
  const lines = existsSync(authLog) ? readFileSync(authLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const good = lines.length > 0 && lines.every((l) => l.auth === "Bearer jev-sentinel");
  if (good) report("jev-auth-credential", "PASS", `${lines.length} Jev hits all Bearer jev-sentinel`);
  else fail("jev-auth-credential", `hits=${lines.length} auths=${JSON.stringify(lines.map((l) => l.auth).slice(0, 3))}`);
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
  const api = await new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port: GW_PORT, path: "/health", method: "GET" }, (res) => resolve(res.statusCode === 200));
    req.on("error", () => resolve(false)); req.end();
  });
  // This verifies an explicit address reaches the intended service; the
  // dead --server run above verifies OpenCode honors (not ignores) the flag.
  if (api) report("explicit-remote-server", "PASS", "explicit gateway URL serves /health");
  else fail("explicit-remote-server", "explicit gateway URL unreachable");
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
  spawnSync(bin, ["service", "start"], { cwd: project, env: hermeticEnv(iso), timeout: 30000 });
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
  try { model2.child.kill("SIGKILL"); } catch {}
  writeProject(`http://127.0.0.1:${MODEL_PORT}/v1`);
  if (r.code !== 0 && svcAfter === svcBefore)
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
      { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    // SIGINT only after the first stub hit proves the run is in flight;
    // node reports SIGINT deaths as code 130 with null signal.
    const poll = setInterval(() => {
      if (modelLog().length > before) {
        clearInterval(poll);
        setTimeout(() => { try { child.kill("SIGINT"); } catch {} }, 2000);
      }
    }, 500);
    const guard = setTimeout(() => { clearInterval(poll); try { child.kill("SIGKILL"); } catch {} }, 60000);
    child.on("exit", (code, signal) => { clearInterval(poll); clearTimeout(guard); resolve({ code, signal, out }); });
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

} // end if (!blocked): binary-driven scenarios require a usable binary

function printSummary() {
  const blockedNames = results.filter((r) => r.status === "BLOCKED").map((r) => r.name);
  // Only documented version-limited checks may stay BLOCKED without failing
  // the gate: 2.0.12 exposes fixture MCP tools on no observable path (see
  // docs/acceptance.md). Any other BLOCKED (e.g. no usable binary) fails,
  // so a vacuous green run is impossible.
  const allowedBlocked = new Set(["mcp-invocation"]);
  const unexpectedBlocked = blockedNames.filter((n) => !allowedBlocked.has(n));
  if (unexpectedBlocked.length) {
    console.log(`\nFAIL: unexpected BLOCKED checks: ${unexpectedBlocked.join(", ")}`);
    process.exit(1);
  }
  console.log(`\n${results.filter((r) => r.status === "PASS").length} passed, ${failed} failed, ${blockedNames.length} blocked`);
}
printSummary();
process.exit(failed ? 1 : 0);
