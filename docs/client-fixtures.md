# Client fixtures

The OpenCode integration can be exercised against disposable model and MCP fixtures without
provider credentials. These fixtures are development tools, not MCP bridges or application
controllers. They do not belong in a real user's client configuration.

Install development dependencies with `pnpm install --frozen-lockfile`; this bootstrap may use
the package registry. `pnpm test` checks the scripted model's advertised-tool and tool-choice
contract without network calls. Build the gateway and compiled advisory plugin with `pnpm build`
before testing a client against them.

`test/fixtures/acceptance-model.mjs` serves a loopback model endpoint. Set `PORT`, a disposable
`LOG` filename, and an optional `SCENARIO_FILE`. The scenario file selects the next scripted tool
response; `test/fixtures/model-contract.mjs` rejects responses incompatible with the advertised
roster or `tool_choice`, except explicitly adversarial scenarios. Use synthetic prompts only:
the request log contains entire fixture conversations.

`test/fixtures/acceptance-mcp.mjs` speaks MCP JSON-RPC over stdin/stdout and advertises
`test_status`, `test_read`, and `test_write`. Set `FIXTURE_COUNTER` to a disposable file; each
write appends one line, and status invocations append to its `.status` sibling. `FIXTURE_EVENTS`
records mutation checkpoints. `FIXTURE_BEFORE_COMMIT` and `FIXTURE_AFTER_COMMIT` hold mutations
until their specified files exist, cancellation arrives, or the bounded fixture deadline expires.
`FIXTURE_STARTUP_DELAY_MS` and `FIXTURE_HANG_STARTUP` support client startup tests.

Start clients with isolated HOME and XDG directories and an allowlisted environment. Configure
these fixtures explicitly, then verify both the client-visible result and exact side-effect
counters. An unavailable tool alone does not prove permission enforcement. Approval tests must
observe the pending request, verify zero pre-approval effects, reply, and inspect the outcome.

The full pinned-binary, cold-start, and application qualification harness is maintained in the
[integration fork](https://github.com/caniko/jev-gateway/tree/master/integration). Warm-up success
does not establish cold first-request readiness. Desktop workflows, live vision, interactive UI
approval, lifecycle, and cancellation/retry evidence remain separate from portable unit tests.
