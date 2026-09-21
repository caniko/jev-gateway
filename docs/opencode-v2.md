# OpenCode v2 support

Pinned CLI: `@opencode/cli@2.0.12`
(`https://registry.npmjs.org/@opencode/cli/-/cli-2.0.12.tgz`,
`sha512-LwB0LD7LXZbfFDU12KwiUq5nPcjW1BzYpp81UPzEBpeZSNvszKXnTUa3l8JmLi6I6/WtQx/Z/8n2743FyY6lpg==`).
Standalone binaries: `https://opencode.ai/files/bin/2.0.6/...` (docs snapshot;
prefer the pinned npm artifact for verification).

## Launcher

`jev-opencode` injects `OPENCODE_CONFIG_CONTENT` (never writes user files) with:

- `model` / `small_model`: `jev-gateway/<model>` (`JEV_OPENCODE_MODEL`, default `gpt-5`);
  explicit `opencode -m provider/model` keeps top priority (no leading args).
- v2 native `providers.jev-gateway` (`@opencode/ai/providers/openai-compatible`,
  `settings.baseURL: <origin>/v1`, `env: ["OPENAI_API_KEY"]`);
- legacy v1 `provider.jev-gateway` retained so v1 clients keep working.
- No obsolete `OPENCODE_EXPERIMENTAL_*` flags. Code Mode stays enabled globally.

Unrelated MCP, agents, permissions, plugins, and title-model settings merge untouched.

## Shared service vs isolated

By default OpenCode discovers/starts one shared background server per user.
That server started without launcher env, so `jev-opencode` without flags may
attach to it and ignore gateway config. Use:

- `jev-opencode --standalone` — private server for the gateway session;
- `jev-opencode --server http://127.0.0.1:4096` — explicit remote (forwarded untouched).

Never silently reconfigure or terminate unrelated sessions. Cold startup and
existing-service presence are both tested in acceptance (`test/v2-acceptance`).

## CAD profile

Expose Blender/FreeCAD with per-server `codemode: false`, preserving full
server definitions (command, environment, protocol, timeouts):

```jsonc
{ "mcp": { "servers": {
  "blender": { "type": "local", "command": ["blender-mcp-launcher"], "codemode": false, "timeout": 210000 },
  "freecad": { "type": "local", "command": ["freecad-mcp"], "codemode": false }
}}}
```

Do not set global Code Mode off. Gateway compatibility with the outer
`execute` tool is tested separately; Jev never selects inner tools hidden in
generated code, and nested OpenCode permissions remain effective.

## Wire formats

Observed native roster (v1 capture, still valid): `apply_patch, bash, glob,
grep, read, skill, task, todowrite, webfetch`. MCP tools appear flattened
(`mcp__home__set_light`) on the same function shape; provider namespaces
(Responses `namespace` groups, Codex `additional_tools`) are qualified
(`ns.name`) and never forced.

Streaming, tool-call IDs, results, errors, cancellation, and multi-turn
continuity are exercised in acceptance. Server-side history
(`previous_response_id`), opaque refs, unsupported namespaces, and dynamic
tool declarations stay passthrough; no synthetic response IDs are generated,
and direct mode is disabled on incompatible sessions rather than adding a
gateway history database. Transports not exercised are not claimed supported;
use the documented HTTP provider config above.
