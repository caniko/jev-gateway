import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
const clients = await import("../bin/clients.mjs");

interface LauncherSpec {
  name: string;
  client: string;
  portEnv: string;
  defaultPort: number;
  upstream: () => string;
  upstreamHelp: string;
  args?: (origin: string) => string[];
  env?: (origin: string) => Record<string, string>;
  configHelp: (origin: string) => string;
}

const opencode = clients.opencode as LauncherSpec;
const codex = clients.codex as LauncherSpec;
const claude = clients.claude as LauncherSpec;

const origin = "http://127.0.0.1:8791";
const launcherBin = fileURLToPath(new URL("../bin/jev-opencode.mjs", import.meta.url));

const managedEnv = ["JEV_OPENCODE_UPSTREAM_BASE_URL", "JEV_OPENCODE_MODEL", "JEV_CODEX_UPSTREAM_BASE_URL", "JEV_CLAUDE_UPSTREAM_BASE_URL", "CODEX_HOME", "OPENCODE_CONFIG_CONTENT"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of managedEnv) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of managedEnv) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const inlineConfig = (originOverride = origin) => {
  const env = opencode.env?.(originOverride);
  expect(env).toBeDefined();
  return JSON.parse(env!.OPENCODE_CONFIG_CONTENT as string) as any;
};

describe("jev-opencode spec", () => {
  it("identifies itself as the opencode launcher on its own port", () => {
    expect(opencode.name).toBe("jev-opencode");
    // launcher.mjs spawns the gateway with JEV_CLIENT: spec.client, so this is what reaches it.
    expect(opencode.client).toBe("opencode");
    expect(opencode.portEnv).toBe("JEV_OPENCODE_PORT");
    expect(opencode.defaultPort).toBe(8791);
    expect([codex.defaultPort, claude.defaultPort]).not.toContain(opencode.defaultPort);
  });

  it("defaults upstream to OpenAI with a JEV_OPENCODE_UPSTREAM_BASE_URL override", () => {
    expect(opencode.upstream()).toBe("https://api.openai.com/v1");
    process.env.JEV_OPENCODE_UPSTREAM_BASE_URL = "https://llm.test/v1";
    expect(opencode.upstream()).toBe("https://llm.test/v1");
    expect(opencode.upstreamHelp).toContain("JEV_OPENCODE_UPSTREAM_BASE_URL");
  });

  it("selects jev-gateway/<model> by default with a JEV_OPENCODE_MODEL override", () => {
    expect(inlineConfig().model).toBe("jev-gateway/gpt-5");
    expect(inlineConfig().small_model).toBe("jev-gateway/gpt-5");
    process.env.JEV_OPENCODE_MODEL = "gpt-5-mini";
    expect(inlineConfig().model).toBe("jev-gateway/gpt-5-mini");
    expect(opencode.upstreamHelp).toContain("JEV_OPENCODE_MODEL");
  });

  it("injects a stable custom-provider config pointing at the gateway, not at TypeSafe", () => {
    // Shape verified against the pinned binary: 2.0.12 honors `provider`
    // with `npm`/`options` (see README). No capabilities or
    // limits are declared: nothing invented is presented as detected.
    const config = inlineConfig();
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect(config.providers).toBeUndefined();
    const provider = config.provider["jev-gateway"];
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options.baseURL).toBe(`${origin}/v1`);
    expect(provider.options.apiKey).toBe("{env:OPENAI_API_KEY}");
    expect(Object.keys(provider.models)).toEqual(["gpt-5"]);
    expect(provider.models["gpt-5"]).toEqual({ name: "Jev Gateway (gpt-5)" });
    const raw = JSON.stringify(config);
    expect(raw.toLowerCase()).not.toContain("typesafe");
    expect(raw).not.toContain("/.config/");
    expect(raw).not.toContain("~");
  });

  it("merges an inherited inline config instead of replacing it", () => {
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: "anthropic/claude-sonnet-4-5",
      mcp: { extra: { type: "local", command: ["x"] } },
      permission: { edit: "ask" },
    });
    // No JEV_OPENCODE_MODEL: the configured provider is preserved.
    const kept = inlineConfig();
    expect(kept.model).toBe("anthropic/claude-sonnet-4-5");
    expect(kept.mcp).toEqual({ extra: { type: "local", command: ["x"] } });
    expect(kept.permission).toEqual({ edit: "ask" });
    expect(kept.provider["jev-gateway"].options.baseURL).toBe(`${origin}/v1`);
    // JEV_OPENCODE_MODEL explicitly asks for gateway routing.
    process.env.JEV_OPENCODE_MODEL = "gpt-5-mini";
    const forced = inlineConfig();
    expect(forced.model).toBe("jev-gateway/gpt-5-mini");
    expect(forced.mcp).toEqual({ extra: { type: "local", command: ["x"] } });
    // Unreadable inheritance never breaks the launcher.
    process.env.OPENCODE_CONFIG_CONTENT = "{not json";
    delete process.env.JEV_OPENCODE_MODEL;
    expect(inlineConfig().model).toBe("jev-gateway/gpt-5");
  });

  it("omits model keys when JEV_OPENCODE_MODEL is empty so file config wins", () => {
    process.env.JEV_OPENCODE_MODEL = "";
    const config = inlineConfig();
    expect("model" in config).toBe(false);
    expect("small_model" in config).toBe(false);
    // The provider entry is still offered for explicit -m selection.
    expect(config.provider["jev-gateway"].options.baseURL).toBe(`${origin}/v1`);
  });

  it.each([undefined, ""])("preserves inherited model pairs without filling a missing small model (%s)", (selection) => {
    if (selection !== undefined) process.env.JEV_OPENCODE_MODEL = selection;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "native/main" });
    expect(inlineConfig().model).toBe("native/main");
    expect(inlineConfig()).not.toHaveProperty("small_model");
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "native/main", small_model: "native/small" });
    expect(inlineConfig()).toMatchObject({ model: "native/main", small_model: "native/small" });
  });

  it.each([
    { provider: "bad" }, { provider: [] }, { provider: { "jev-gateway": [] } },
    { provider: { "jev-gateway": { options: null } } }, { provider: { "jev-gateway": { models: "bad" } } },
    { provider: { "jev-gateway": { models: { "gpt-5": [] } } } },
  ])("rejects non-object provider configuration before merging: %j", (inherited) => {
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(inherited);
    expect(() => inlineConfig()).toThrow(/OpenCode provider.*must be an object/);
  });

  it("preserves model metadata, other models, plugins, MCP, and permissions", () => {
    const inherited = { provider: { other: { options: { custom: true } }, "jev-gateway": {
      models: { "gpt-5": { name: "Reviewed", capabilities: { vision: true }, limit: { context: 12345 } },
        another: { name: "Other model" } },
      options: { timeout: 1234 },
    } }, plugin: ["other-plugin"], mcp: { server: { command: ["fixture"] } }, permission: { "*": "ask" } };
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(inherited);
    const merged = inlineConfig();
    expect(merged.provider["jev-gateway"].models).toEqual(inherited.provider["jev-gateway"].models);
    expect(merged.provider.other).toEqual(inherited.provider.other);
    expect(merged.plugin).toEqual(inherited.plugin);
    expect(merged.mcp).toEqual(inherited.mcp);
    expect(merged.permission).toEqual(inherited.permission);
  });

  it("preserves provider options, capabilities, and title settings", () => {
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: "jev-gateway/gpt-5",
      small_model: "custom/small",
      provider: { "jev-gateway": { options: { timeout: 90000, apiKey: "{env:MY_KEY}" } } },
      agent: { title: { model: "custom/small" } },
      permission: { edit: "ask" },
    });
    const config = inlineConfig();
    expect(config.small_model).toBe("custom/small");
    // Explicit timeout survives; endpoint and credential default fill in.
    expect(config.provider["jev-gateway"].options.timeout).toBe(90000);
    expect(config.provider["jev-gateway"].options.baseURL).toBe(`${origin}/v1`);
    expect(config.agent.title.model).toBe("custom/small");
    expect(config.permission).toEqual({ edit: "ask" });
  });

  it("does not override inherited v1 experimental flags", () => {
    const env = opencode.env!(origin);
    expect(env.OPENCODE_EXPERIMENTAL_NATIVE_LLM).toBeUndefined();
    expect(env.OPENCODE_EXPERIMENTAL_CODE_MODE).toBeUndefined();
    expect(Object.keys(env)).toEqual(["OPENCODE_CONFIG_CONTENT", "JEV_OPENCODE_ROUTING_OWNER"]);
    expect(env.JEV_OPENCODE_ROUTING_OWNER).toBe("proxy");
  });

  it("adds no leading client args, so user flags (including -m) forward untouched", () => {
    // launcher.mjs appends the raw argv after spec.args; with no injected --model, the injected
    // config model above stays the default while a user `-m provider/model` keeps top priority.
    expect(opencode.args).toBeUndefined();
    expect(typeof opencode.env).toBe("function");
  });

  it("prints permanent wiring help rooted at the gateway", () => {
    const help = opencode.configHelp(origin);
    expect(help).toContain(`${origin}/v1`);
    expect(help).toContain("jev-gateway/gpt-5");
    expect(help).toContain("opencode.json");
    expect(help).toContain("jev-opencode --start");
    expect(help).toContain("--model jev-gateway/gpt-5");
    expect(help).toContain("--standalone");
    expect(help).toContain("--server");
    // The file workflow below needs no shell quoting; the JSON block must parse as-is.
    const jsonBlock = help.slice(help.indexOf("{"), help.lastIndexOf("}") + 1);
    const parsed = JSON.parse(jsonBlock) as any;
    expect(parsed.model).toBe("jev-gateway/gpt-5");
    expect(parsed.provider["jev-gateway"].options.baseURL).toBe(`${origin}/v1`);
    // No raw-JSON shell one-liner: single-quoting breaks on apostrophes in custom model IDs.
    expect(help).not.toContain("OPENCODE_CONFIG_CONTENT='");
    process.env.JEV_OPENCODE_MODEL = "other-model";
    expect(opencode.configHelp(origin)).toContain("jev-gateway/other-model");
  });

  it("stays safe when a custom model ID contains an apostrophe", () => {
    process.env.JEV_OPENCODE_MODEL = "o'brien";
    const config = inlineConfig();
    expect(config.model).toBe("jev-gateway/o'brien");
    expect(Object.keys(config.provider["jev-gateway"].models)).toEqual(["o'brien"]);
    const help = opencode.configHelp(origin);
    expect(help).not.toContain("OPENCODE_CONFIG_CONTENT='");
    const jsonBlock = help.slice(help.indexOf("{"), help.lastIndexOf("}") + 1);
    expect(() => JSON.parse(jsonBlock)).not.toThrow();
    expect((JSON.parse(jsonBlock) as any).model).toBe("jev-gateway/o'brien");
  });
});

describe("jev-opencode entrypoint", () => {
  it("is registered in package.json with a runnable script", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as any;
    expect(pkg.bin["jev-opencode"]).toBe("bin/jev-opencode.mjs");
    expect(pkg.scripts.opencode).toBe("node bin/jev-opencode.mjs");
  });

  it("--gateway-help describes the opencode launcher without starting anything", () => {
    const out = execFileSync(process.execPath, [launcherBin, "--gateway-help"], { encoding: "utf8", timeout: 30_000 });
    expect(out).toContain("jev-opencode: opencode with tool selection routed through Jev");
    expect(out).toContain("--print-config");
  });

  it("--print-config prints the gateway-rooted provider config without starting anything", () => {
    const out = execFileSync(process.execPath, [launcherBin, "--print-config"], { encoding: "utf8", timeout: 30_000 });
    expect(out).toContain("http://127.0.0.1:8791/v1");
    expect(out).toContain("jev-gateway");
  });
});

describe("existing launchers", () => {
  it("keeps the codex and claude specs intact", () => {
    expect(codex.name).toBe("jev-codex");
    expect(codex.client).toBe("codex");
    expect(codex.defaultPort).toBe(8790);
    // No readable login (CODEX_HOME is pointed at nothing): falls back to the API backend.
    process.env.CODEX_HOME = "/nonexistent-jev-test-dir";
    expect(codex.upstream()).toBe("https://api.openai.com/v1");
    expect(codex.args!(origin).join(" ")).toContain('model_provider="jev-gateway"');

    expect(claude.name).toBe("jev-claude");
    expect(claude.client).toBe("claude");
    expect(claude.defaultPort).toBe(8789);
    expect(claude.upstream()).toBe("https://api.anthropic.com/v1");
    expect(claude.env!(origin)).toEqual({ ANTHROPIC_BASE_URL: origin });
  });
});
