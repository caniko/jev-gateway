import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("advertises fixture tools and records exactly one requested mutation", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-fixture-"));
  const counter = join(directory, "counter");
  try {
    const requests = [
      { id: 1, method: "tools/list" },
      { id: 2, method: "tools/call", params: { name: "test_read", arguments: { key: "sentinel" } } },
      { id: 3, method: "tools/call", params: { name: "test_write", arguments: { line: "sentinel" } } },
    ];
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/acceptance-mcp.mjs", import.meta.url))], {
      input: requests.map((request) => JSON.stringify({ jsonrpc: "2.0", ...request })).join("\n") + "\n",
      env: { FIXTURE_COUNTER: counter }, encoding: "utf8", timeout: 2000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const replies = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(replies.find((reply) => reply.id === 1).result.tools.map((tool: { name: string }) => tool.name))
      .toEqual(["test_status", "test_read", "test_write"]);
    expect(replies.find((reply) => reply.id === 2).result.content).toEqual([{ type: "text", text: "fixture-read:sentinel" }]);
    expect(replies.find((reply) => reply.id === 3).result.content).toEqual([{ type: "text", text: "fixture-write:ok" }]);
    expect(readFileSync(counter, "utf8")).toBe("write:sentinel\n");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
