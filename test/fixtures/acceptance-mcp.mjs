#!/usr/bin/env node
// Acceptance MCP stdio fixture: test_read (pure) and test_write (appends one
// line to $FIXTURE_COUNTER per call, so duplicate invocations are visible).
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const counter = process.env.FIXTURE_COUNTER ?? "./counter.log";
const tools = [
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
  if (msg.method === "initialize") {
    reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "acceptance-fixture", version: "0.0.1" } });
  } else if (msg.method === "tools/list") {
    reply({ tools });
  } else if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (name === "test_read") {
      reply({ content: [{ type: "text", text: `fixture-read:${msg.params?.arguments?.key ?? ""}` }] });
    } else if (name === "test_write") {
      appendFileSync(counter, `write:${msg.params?.arguments?.line ?? ""}\n`);
      reply({ content: [{ type: "text", text: "fixture-write:ok" }] });
    } else {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } }) + "\n",
      );
    }
  } else if (msg.method === "ping") {
    reply({});
  }
});
