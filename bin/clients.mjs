// How each coding agent is pointed at a gateway. Shared by the launchers and the benchmark runner,
// so a benchmark drives an agent exactly the way `jev-codex`, `jev-claude`, and `jev-opencode` do.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Codex talks to a different backend depending on how the user logged in. */
function codexUpstream() {
  if (process.env.JEV_CODEX_UPSTREAM_BASE_URL) return process.env.JEV_CODEX_UPSTREAM_BASE_URL;
  try {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
    if (auth.auth_mode === "chatgpt" || (auth.tokens && !auth.OPENAI_API_KEY)) {
      return "https://chatgpt.com/backend-api/codex";
    }
  } catch {
    // No readable login: assume API-key usage.
  }
  return "https://api.openai.com/v1";
}

const codexProvider = (origin) => ({
  name: `"jev-gateway"`,
  base_url: `"${origin}/v1"`,
  wire_api: `"responses"`,
  // Reuse whatever login Codex already has; the gateway forwards it upstream untouched.
  requires_openai_auth: "true",
});

export const codex = {
  name: "jev-codex",
  client: "codex",
  portEnv: "JEV_CODEX_PORT",
  defaultPort: 8790,
  upstream: codexUpstream,
  upstreamHelp:
    "JEV_CODEX_UPSTREAM_BASE_URL   where Codex traffic goes; default follows your Codex login:\n" +
    "                                ChatGPT login → https://chatgpt.com/backend-api/codex\n" +
    "                                API key       → https://api.openai.com/v1",
  args: (origin) => [
    "-c",
    `model_provider="jev-gateway"`,
    ...Object.entries(codexProvider(origin)).flatMap(([key, value]) => ["-c", `model_providers.jev-gateway.${key}=${value}`]),
  ],
  configHelp: (origin) =>
    `# Save as ~/.codex/jev.config.toml, keep the gateway running (jev-codex --start),\n` +
    `# then use: codex --profile jev\n` +
    `model_provider = "jev-gateway"\n\n[model_providers.jev-gateway]\n` +
    Object.entries(codexProvider(origin))
      .map(([key, value]) => `${key} = ${value}`)
      .join("\n"),
};

export const claude = {
  name: "jev-claude",
  client: "claude",
  portEnv: "JEV_CLAUDE_PORT",
  defaultPort: 8789,
  upstream: () => process.env.JEV_CLAUDE_UPSTREAM_BASE_URL ?? "https://api.anthropic.com/v1",
  upstreamHelp: "JEV_CLAUDE_UPSTREAM_BASE_URL   where Claude traffic goes (default https://api.anthropic.com/v1)",
  // Only the base URL is set. With no gateway credential alongside it, Claude Code keeps using its
  // saved claude.ai login, so a Pro/Max subscription (or an existing API key) keeps working as is.
  env: (origin) => ({ ANTHROPIC_BASE_URL: origin }),
  configHelp: (origin) =>
    `# Keep the gateway running (jev-claude --start), then either:\n` +
    `#   ANTHROPIC_BASE_URL=${origin} claude\n` +
    `# or add to ~/.claude/settings.json:\n` +
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: origin } }, null, 2),
};

/** Where OpenCode traffic goes by default; override with JEV_OPENCODE_UPSTREAM_BASE_URL. */
function opencodeUpstream() {
  return process.env.JEV_OPENCODE_UPSTREAM_BASE_URL ?? "https://api.openai.com/v1";
}

/** Model id selected as `jev-gateway/<model>`; override with JEV_OPENCODE_MODEL. */
function opencodeModel() {
  return process.env.JEV_OPENCODE_MODEL ?? "gpt-5";
}

const OPENCODE_PROVIDER = "jev-gateway";

/**
 * Custom-provider config for the launched OpenCode process, verified against
 * the pinned binary (`@opencode/cli@2.0.12`, see docs/opencode-v2.md).
 * Injected through OPENCODE_CONFIG_CONTENT — inline config merges over the
 * user's global/project files, which are never written. The provider entry
 * uses the shape 2.0.12 honors (`npm: "@ai-sdk/openai-compatible"` with
 * `options.baseURL/apiKey`); it speaks `/v1/chat/completions` off
 * `${origin}/v1`, an endpoint the gateway routes (verified with a loopback
 * stub). `{env:OPENAI_API_KEY}` reuses the user's own OpenAI credential
 * untouched (resolving to empty when unset, like OpenCode's own
 * local-provider examples). The launcher-spawned gateway forwards that
 * client credential untouched: launcher.mjs strips UPSTREAM_API_KEY /
 * ROUTER_API_KEY by design, so no gateway key swap applies here.
 * TYPESAFE_API_KEY is separate — it only authorizes the Jev tool-selection
 * call and is never sent as the LLM upstream credential.
 *
 * No capabilities or limits are declared for the gateway model: whatever the
 * catalog assumes for an undeclared model applies, and the gateway never
 * presents fallback defaults as detected capabilities.
 *
 * Model selection: JEV_OPENCODE_MODEL forces `jev-gateway/<model>`; when it
 * is unset, an inherited non-gateway model is preserved as-is and only the
 * provider entry is added. Explicit `opencode -m provider/model` keeps top
 * priority because the launcher injects no leading args. ARGS_MODEL
 * (gateway forced-path model) defaults to the request's own model; when set
 * it is used verbatim and must be valid for the upstream provider.
 *
 * Everything else in an inherited OPENCODE_CONFIG_CONTENT (MCP servers,
 * agents, permissions, plugins, title settings) is preserved key by key.
 */
function opencodeInlineConfig(origin) {
  const forced = process.env.JEV_OPENCODE_MODEL;
  const inherited = inheritedInlineConfig();
  const inheritedId =
    typeof inherited?.model === "string" && inherited.model.startsWith(`${OPENCODE_PROVIDER}/`)
      ? inherited.model.slice(OPENCODE_PROVIDER.length + 1)
      : undefined;
  const model = forced ?? inheritedId ?? opencodeModel();
  const provider = {
    ...(inherited?.provider?.[OPENCODE_PROVIDER] && typeof inherited.provider[OPENCODE_PROVIDER] === "object"
      ? inherited.provider[OPENCODE_PROVIDER]
      : {}),
    npm: "@ai-sdk/openai-compatible",
    name: "Jev Gateway",
    options: { baseURL: `${origin}/v1`, apiKey: "{env:OPENAI_API_KEY}" },
    models: { [model]: { name: `Jev Gateway (${model})` } },
  };
  // Preserve a configured non-gateway model unless JEV_OPENCODE_MODEL
  // explicitly asks for gateway routing (the launcher's default purpose is
  // routing through Jev, so an unset default still selects it).
  const selected = forced ? `${OPENCODE_PROVIDER}/${model}` : (inherited?.model ?? `${OPENCODE_PROVIDER}/${model}`);
  const selectedSmall = forced
    ? `${OPENCODE_PROVIDER}/${model}`
    : (inherited?.small_model ?? `${OPENCODE_PROVIDER}/${model}`);
  return {
    ...(inherited ?? {}),
    $schema: "https://opencode.ai/config.json",
    model: selected,
    small_model: selectedSmall,
    provider: { ...inherited?.provider, [OPENCODE_PROVIDER]: provider },
  };
}

/** Parse an inherited OPENCODE_CONFIG_CONTENT, or undefined when absent/unreadable. */
function inheritedInlineConfig() {
  const raw = process.env.OPENCODE_CONFIG_CONTENT;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export const opencode = {
  name: "jev-opencode",
  client: "opencode",
  portEnv: "JEV_OPENCODE_PORT",
  defaultPort: 8791,
  upstream: opencodeUpstream,
  upstreamHelp:
    "JEV_OPENCODE_UPSTREAM_BASE_URL   where OpenCode traffic goes (default https://api.openai.com/v1)\n" +
    "JEV_OPENCODE_MODEL               model selected as jev-gateway/<model> (default gpt-5)",
  // No `args`: the model default comes from the injected config below, so a user `-m provider/model`
  // keeps its documented top priority and every other `opencode` flag — including `--standalone`
  // for an isolated gateway session and explicit `--server` for a remote server — forwards
  // untouched and is never silently ignored. An inherited OPENCODE_CONFIG_CONTENT is merged,
  // not replaced; obsolete v1 experimental flags are not set.
  env: (origin) => ({
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeInlineConfig(origin)),
  }),
  configHelp: (origin) => {
    // No OPENCODE_CONFIG_CONTENT one-liner here: single-quoting raw JSON breaks when a custom
    // model ID contains an apostrophe. The opencode.json file workflow below needs no shell
    // quoting and matches what `jev-opencode --print-config` documents.
    const config = opencodeInlineConfig(origin);
    const manual = JSON.stringify(
      { model: config.model, small_model: config.small_model, provider: config.provider },
      null,
      2,
    );
    return (
      `# Keep the gateway running (jev-opencode --start), then add to opencode.json\n` +
      `# (project root or ~/.config/opencode/opencode.json):\n` +
      `${manual}\n` +
      `# then select it with: opencode --model ${config.model}\n` +
      `# Isolated gateway session (recommended when a shared service is already running):\n` +
      `#   jev-opencode --standalone\n` +
      `# Explicit remote server is forwarded untouched:\n` +
      `#   jev-opencode --server http://127.0.0.1:4096`
    );
  },
};
export const gemini = {
  name: "jev-gemini",
  client: "gemini",
  portEnv: "JEV_GEMINI_PORT",
  defaultPort: 8788,
  upstream: () => process.env.JEV_GEMINI_UPSTREAM_BASE_URL ?? "https://generativelanguage.googleapis.com",
  upstreamHelp: "JEV_GEMINI_UPSTREAM_BASE_URL   where Gemini traffic goes (default https://generativelanguage.googleapis.com)",
  env: (origin) => ({
    GEMINI_API_BASE: origin,
    GOOGLE_GEMINI_BASE_URL: origin,
  }),
  configHelp: (origin) =>
    `# Point your Gemini client or SDK at:\n` +
    `#   GEMINI_API_BASE=${origin}\n` +
    `#   or endpoint: ${origin}/v1beta\n`,
};

