# OpenCode v2 support

Pinned CLI: `@opencode/cli@2.0.12`
(`https://registry.npmjs.org/@opencode/cli/-/cli-2.0.12.tgz`,
`sha512-LwB0LD7LXZbfFDU12KwiUq5nPcjW1BzYpp81UPzEBpeZSNvszKXnTUa3l8JmLi6I6/WtQx/Z/8n2743FyY6lpg==`,
installed 2026-09-21, `opencode --version` → `opencode v2.0.12`).

Verified executable artifact (ELF, postinstall-resolved platform binary):
`/tmp/jev-v2prefix/node_modules/@opencode/cli/bin/opencode.exe`
`sha256:2b0825721cb12f9bca3d5099588087d557a21ed2b5b56efebea3f17dc5f79e6a`.

All behavior below was observed by driving that binary from a fully
isolated environment (`HOME` plus `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
`XDG_CACHE_HOME`, `XDG_STATE_HOME` all under `/tmp/jev-iso`; a `HOME`-only
override still reads the real `~/.config`). Loopback stub provider plus a
local MCP stdio fixture; sanitized captures only (dummy `stub-key`).

## Config shape the binary honors

The published web docs describe `providers`/`mcp.servers`/`permissions`,
but 2.0.12's own schema (`https://opencode.ai/config.json` at time of
writing) uses the flat shapes, and `debug config` shows the server
normalizing them (`permission` map → `permissions` array, `mcp.<name>` →
`mcp.servers.<name>`, `provider.<id>.options` → `providers.<id>.settings`).
The launcher therefore emits the flat shape the binary accepts **and
was observed to route**:

- `provider.jev-gateway`: `npm: "@ai-sdk/openai-compatible"`,
  `options: { baseURL: "<origin>/v1", apiKey: "{env:OPENAI_API_KEY}" }`.
- The native `providers` + `package`/`settings` shape parses (it appears
  verbatim in `debug config`) but did **not** route in testing: requests
  fell through to the default endpoint. Do not emit it until a version
  is observed to honor it.
- No capabilities/limits for the gateway model: nothing invented is
  presented as detected.
- Native `mcp.servers.<name>` objects in project config are **dropped
  entirely** by 2.0.12 (`debug config` shows no `mcp` key at all); only
  the flat `mcp.<name>` shape is accepted and normalized internally.
  Likewise no `codemode` key is honored anywhere (the published schema's
  `McpLocalConfig` omits it with `additionalProperties: false`, and
  `debug config` silently drops it). Per-server direct exposure is
  therefore unavailable in the observed version; see Code Mode below.
  The v2 web docs describe both shapes, but they do not match the pinned
  binary or its published schema — re-verify on upgrade before emitting
  either.

## Observed wire formats

Provider package selects the endpoint, both verified against the stub:

- Custom `openai-compatible` provider → `POST /v1/chat/completions`.
- Built-in `openai` provider with `options.baseURL` override →
  `POST /v1/responses` with `model`, `input[]`, `instructions`,
  `tools[]`, `store: false`, `prompt_cache_key`, `include:
  ["reasoning.encrypted_content"]`, `stream: true`, and no `tool_choice`
  field when automatic. Occasional `GET /v1/responses` polls observed.

Native roster over Responses (2.0.12): `edit, glob, grep, question,
read, shell, skill, subagent, webfetch, websearch, write, execute`.
Tool shape: `{type: "function", name, description, parameters,
required, additionalProperties: false, strict: false}`.
Calls: `{type: "function_call", id, call_id, name, arguments: string,
status}`. Results: `{type: "function_call_output", call_id, output}`.
Multi-turn sends full history as input items; no `previous_response_id`
was observed (stateless design fits the gateway; the passthrough guard
for it stays as a safe fallback).

## Code Mode (outer execution tool)

MCP tools never appear on the provider wire under 2.0.12 defaults: they
run inside generated `{ code }` through the `execute` tool, whose catalog
is discovered at runtime (`search`). Jev therefore never selects inner
MCP tools; the gateway routes only the outer `execute` selection and must
not claim otherwise. Nested OpenCode permissions remain authoritative.
Do not set a global Code Mode off switch either: no such supported key
was observed, and disabling the outer tool would remove the only path
MCP tools have.

Stronger, verified 2026-09-21 against the pinned binary: a connected
local MCP fixture (`mcp connected … tools=2` in the server log) is
exposed **neither** on the provider wire (12 native tools only), **nor**
in the Code Mode catalog (`search({})` paginated over all 48 entries
shows no fixture paths), **nor** by direct `tools.<server>.<tool>`
invocation (`Unknown tool … Use search`). A per-server `codemode: false`
cannot be expressed (see above). Real MCP execution through 2.0.12 is
therefore not deterministically drivable here; Blender/FreeCAD workflows
stay manual until a version observably exposes them.

## v2 plugin integration (`plugin/jev`)

`@opencode/plugin@2.0.12` (integrity `sha512-eUO61AEruyxK6wrL82XhjRuZ5zvoWpLdhzAWbFgoLe3/8IgwrY/4SUKGEou5WgXtzh0zWNDQQqMpaVMe66n8cQ==`).
The gateway ships a thin plugin directory (`plugin/jev/`, file `index.ts`)
consumed as a configured local plugin directory:

```jsonc
{ "plugins": [{ "package": "<gateway>/plugin/jev", "options": { "gatewayUrl": "http://127.0.0.1:8791" } }] }
```

A bare `.ts` file path is rejected (`plugin path must be a directory`); the
directory form loads. On each primary agent-loop `context` event the plugin
asks the gateway's `/router/decide` for the visible tool snapshot and, on a
confident selection, appends a `[jev-routing]` hint to the system prompt.
The main model still decides and executes; approvals stay with OpenCode.
Fail-open always (timeout + catch → untouched request); multimodal content
skips the gateway call; title/compaction/generate requests are untouched
(they have separate hooks which this plugin does not register).

Observed 2026-09-21 against the pinned binary: the hint
(`Jev suggests tool "read" (confidence 0.99)`) appears exactly once in the
outgoing stub traffic and the session completes. What the plugin cannot do
by API design (verified in `@opencode/plugin@2.0.12` types: `SessionContext`
exposes no `result` field): return synthetic direct responses — that
capability stays in the gateway proxy transport. The plugin holds no MCP
client, executes nothing, and runs no agent loop.

## Launcher

`jev-opencode` injects `OPENCODE_CONFIG_CONTENT` (never writes user files):

- `model` / `small_model`: `jev-gateway/<model>` by default
  (`JEV_OPENCODE_MODEL`, default `gpt-5`).
- When `JEV_OPENCODE_MODEL` is unset, an inherited non-gateway model is
  preserved and only the provider entry is added; setting
  `JEV_OPENCODE_MODEL` to the empty string omits `model`/`small_model`
  entirely so file-stored configuration wins. Inherited MCP, agents,
  permissions, plugins, and title settings are preserved key by key;
  extra provider option keys (e.g. `timeout`) survive while the endpoint
  always points at the launched gateway and the credential defaults to
  the documented mechanism only when absent.
  Unparseable inheritance never breaks the launch (falls back to default).
- Explicit `opencode -m provider/model` keeps top priority (the launcher
  injects no leading args); `--standalone` and `--server` forward
  untouched and are never silently ignored.
- No obsolete `OPENCODE_EXPERIMENTAL_*` flags.

## Shared service vs isolated

A run without `--standalone` attaches to the already-running shared
service: an inline config pointing at a dead port still drove the old
behavior, proving launcher env does not reliably reach an attached
session. Use `jev-opencode --standalone` for gateway sessions. Never
silently reconfigure or terminate unrelated sessions.

## Transport safety (gateway)

- `previous_response_id`, opaque references, unsupported namespaces, and
  dynamic declarations stay passthrough.
- Direct mode runs only on explicit `store: false`: sessions are stored
  by default (explicitly or by omission), and the synthetic direct reply
  is explicitly `store: false` with `previous_response_id: null`, so it
  can never poison a later server-side chain. Selection still delegates
  via forced/hint everywhere. No gateway history database is added.
- Transports not exercised here are not claimed supported.
