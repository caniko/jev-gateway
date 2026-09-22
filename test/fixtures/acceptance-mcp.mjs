#!/usr/bin/env node
// Acceptance MCP stdio fixture: test_read (pure) and test_write (appends one
// line to $FIXTURE_COUNTER per call, so duplicate invocations are visible).
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const counter = process.env.FIXTURE_COUNTER ?? "./counter.log";
const cancelled = new Set();
const record = (event, id) => {
  if (process.env.FIXTURE_EVENTS) appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({ event, id }) + "\n");
};
async function gate(path, id) {
  const deadline = Date.now() + 15000;
  while (path && !existsSync(path) && !cancelled.has(id)) {
    if (Date.now() > deadline) throw new Error("fixture gate timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !cancelled.has(id);
}
const tools = [
  {
    name: "test_status",
    description: "Read-only no-argument fixture status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "test_read",
    description: "Read-only fixture inspection.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "test_write",
    description: "Bounded fixture mutation (appends one line).",
    inputSchema: { type: "object", properties: { line: { type: "string" } }, required: ["line"] },
  },
];

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  if (msg.method === "notifications/cancelled") {
    cancelled.add(msg.params.requestId);
    record("cancelled", msg.params.requestId);
    return;
  }
  if (msg.method === "initialize") {
    if (process.env.FIXTURE_HANG_STARTUP === "1") return;
    setTimeout(() => reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "acceptance-fixture", version: "0.0.1" } }), Number(process.env.FIXTURE_STARTUP_DELAY_MS ?? 0));
  } else if (msg.method === "tools/list") {
    reply({ tools });
  } else if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (name === "test_status") {
      appendFileSync(counter + ".status", "read\n");
      reply({ content: [{ type: "text", text: "fixture-status:ready" }] });
    } else if (name === "test_read") {
      reply({ content: [{ type: "text", text: `fixture-read:${msg.params?.arguments?.key ?? ""}` }] });
    } else if (name === "test_write") {
      (async () => {
        record("started", msg.id);
        if (!await gate(process.env.FIXTURE_BEFORE_COMMIT, msg.id)) return;
        appendFileSync(counter, `write:${msg.params?.arguments?.line ?? ""}\n`);
        record("committed", msg.id);
        if (!await gate(process.env.FIXTURE_AFTER_COMMIT, msg.id)) return;
        reply({ content: [{ type: "text", text: "fixture-write:ok" }] });
        record("returned", msg.id);
      })().catch((error) => reply({ isError: true, content: [{ type: "text", text: error.message }] }));
    } else {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } }) + "\n",
      );
    }
  } else if (msg.method === "ping") {
    reply({});
  }
});
