# Fork qualification

Portable fixtures live in `test/fixtures/`; this directory owns the full qualification harness.
No host cutover is performed. Use disposable client data and application documents only.

```bash
pnpm install --frozen-lockfile
pnpm --dir integration/qualification install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build
node integration/qualification/v2-acceptance.mjs --binary=/absolute/path/to/opencode --keep
```

The default binary pin is OpenCode 2.0.12, **Linux x64 glibc AVX2**. It deliberately does not
qualify macOS, musl, or baseline variants. Use `--runtime-pin=integration/opencode-candidate.json`
with the separately built candidate executable to test the recorded readiness fix. An explicit
pin includes platform, architecture, variant, version, executable SHA-256, and readiness status.
Every run reports the actual binary hash, source revision, and packed gateway hash.

Package installation and optional `--install-binary` bootstrap can contact registries. Scenario
traffic is loopback, uses sentinels, and runs the gateway/plugin from a production-only package
installation. The SDK is an explicit development dependency of this private qualification package,
not a transitive runtime dependency of the gateway. Every child receives the same environment
allowlist with isolated HOME/XDG directories. HTTP and polling operations have cancellation and
deadlines; predicates doing IO must propagate their supplied AbortSignal.

```bash
OPENCODE_V2_BIN=/absolute/path/to/opencode \
OPENCODE_V2_VERSION=2.0.12+1b894b926a \
OPENCODE_V2_SHA256=a3f84d86349cf91c6eb46424f503895fe6e6354d3301fa41d17b1c2554ffbaab \
node integration/qualification/v2-cold-start.mjs
```

Cold-start checks make the first model response immediately and do not warm up or poll the MCP
catalog. They are separate from the lifecycle suite's explicitly bounded readiness setup.
Direct MCP and Code Mode, actual pending permission replies, zero pre-approval effects, exact
mutation counts, reload/disposal, and cancellation/retry are distinct assertions. Required
BLOCKED checks fail the gate. Historical reports are not fresh validation evidence.

Live CAD, image interpretation, and terminal UI approval remain separately reported production
qualification gates. An API permission reply is not evidence of a terminal UI interaction.
