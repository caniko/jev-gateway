#!/usr/bin/env node
// Scripted OpenAI-compatible model endpoint for acceptance. Speaks Chat
// Completions JSON and Responses SSE (chosen per request URL), logs every
// request (headers redacted to sentinel presence), and follows a semantic
// state machine: answer with a tool call until the client submits a tool
// result, then answer text. Scenario from $ACCEPTANCE_TOOL ("<name>
// <arguments-json>"); absent file means text-only.
//
// Env: PORT, LOG (request log), SCENARIO_FILE (toolmode path).
import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 18082);
const LOG = process.env.LOG ?? "./model-requests.log";
const SCENARIO_FILE = process.env.SCENARIO_FILE ?? "./toolmode";
// Optional fixed latency before every response (cancellation scenarios).
// A per-request override file (contents: milliseconds) takes precedence when
// present, so scenarios can arm delays without restarting the stub.
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);
const DELAY_FILE = process.env.DELAY_FILE ?? "";
const delayNow = () => {
  if (DELAY_FILE) {
    try {
      const v = Number(readFileSync(DELAY_FILE, "utf8").trim());
      if (Number.isFinite(v) && v >= 0) return v;
    } catch {}
  }
  return DELAY_MS;
};
writeFileSync(LOG, "");
let n = 0;

const toolSpec = () => {
  try {
    const line = readFileSync(SCENARIO_FILE, "utf8").trim();
    if (!line) return undefined;
    const sp = line.indexOf(" ");
    if (sp < 0) return { name: line, args: "{}" };
    return { name: line.slice(0, sp), args: line.slice(sp + 1) };
  } catch {
    return undefined;
  }
};

const wantsTool = (raw) => {
  const spec = toolSpec();
  if (!spec || !raw) return undefined;
  try {
    const j = JSON.parse(raw);
    if (!j.tools || !j.tools.length) return undefined;
    if (spec.name === "@mcp") {
      const scenario = JSON.parse(spec.args);
      const messages = j.messages ?? [];
      const calls = messages.flatMap((m) => m.tool_calls ?? []);
      // Allow the asynchronous MCP catalog to settle during a bounded,
      // harmless first tool turn. Subsequent calls use the actual roster.
      if (calls.length === 0 && !scenario.noWarmup) return { name: "read", args: JSON.stringify({ path: scenario.warmup }) };
      if (scenario.codemode) {
        const executions = calls.filter((c) => c.function?.name === "execute");
        if (scenario.denied) {
          if (executions.length) return undefined;
          return { name: "execute", args: JSON.stringify({ code: `return await tools.fixture.test_write(${JSON.stringify({ line: scenario.marker })})` }) };
        }
        if (executions.length === 0) return { name: "execute", args: JSON.stringify({ code: 'return await search({query:"test_write"})' }) };
        if (executions.length > 1) return undefined;
        const discovery = messages.find((m) => m.role === "tool" && m.tool_call_id === executions[0].id);
        if (!JSON.stringify(discovery?.content).includes("tools.fixture.test_write")) return undefined;
        return { name: "execute", args: JSON.stringify({ code: `return await tools.fixture.test_write(${JSON.stringify({ line: scenario.marker })})` }) };
      }
      if (calls.some((c) => c.function?.name === "fixture_test_write")) return undefined;
      if (!scenario.denied && !j.tools.some((t) => (t.function?.name ?? t.name) === "fixture_test_write")) return undefined;
      return { name: "fixture_test_write", args: JSON.stringify({ line: scenario.marker }) };
    }
    if ((j.input || []).some((it) => typeof it?.type === "string" && it.type.endsWith("_call_output"))) return undefined;
    if ((j.messages || []).some((m) => m.role === "tool")) return undefined;
    return spec;
  } catch {
    return undefined;
  }
};

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: 0 })}\n\n`).join("");

const respTextSSE = () =>
  sse([
    { type: "response.created", response: { id: "resp_acc_text", object: "response", status: "in_progress", output: [] } },
    { type: "response.in_progress", response: { id: "resp_acc_text", object: "response", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_acc", role: "assistant", content: [] } },
    { type: "response.content_part.added", item_id: "msg_acc", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", item_id: "msg_acc", output_index: 0, content_index: 0, delta: "acceptance-final-answer" },
    {
      type: "response.content_part.done", item_id: "msg_acc", output_index: 0, content_index: 0,
      part: { type: "output_text", text: "acceptance-final-answer" },
    },
    {
      type: "response.output_item.done", output_index: 0,
      item: { type: "message", id: "msg_acc", role: "assistant", content: [{ type: "output_text", text: "acceptance-final-answer" }] },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_acc_text", object: "response", status: "completed",
        output: [{ type: "message", id: "msg_acc", role: "assistant", content: [{ type: "output_text", text: "acceptance-final-answer" }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);

// Call ids incorporate the request counter so every emitted call is unique;
// a repeated id in traffic then proves a real duplicate invocation.
const respToolItem = (name, args) => ({ type: "function_call", id: `fc_acc_${n}`, call_id: `call_acc_${n}`, name, arguments: args, status: "completed" });

const respToolSSE = (name, args) =>
  sse([
    { type: "response.created", response: { id: "resp_acc_tool", object: "response", status: "in_progress", output: [] } },
    { type: "response.in_progress", response: { id: "resp_acc_tool", object: "response", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...respToolItem(name, ""), status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: `fc_acc_${n}`, output_index: 0, delta: args },
    { type: "response.function_call_arguments.done", item_id: `fc_acc_${n}`, output_index: 0, arguments: args },
    { type: "response.output_item.done", output_index: 0, item: respToolItem(name, args) },
    {
      type: "response.completed",
      response: {
        id: "resp_acc_tool", object: "response", status: "completed", output: [respToolItem(name, args)],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);

const chatTool = (name, args) =>
  JSON.stringify({
    id: "chatcmpl-acc-1", object: "chat.completion", created: 1, model: "acc-model",
    choices: [{
      index: 0,
      message: {
        role: "assistant", content: null,
        tool_calls: [{ id: `call_acc_${n}`, type: "function", function: { name, arguments: args } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

const chatText = () =>
  JSON.stringify({
    id: "chatcmpl-acc-2", object: "chat.completion", created: 2, model: "acc-model",
    choices: [{ index: 0, message: { role: "assistant", content: "acceptance-final-answer" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

const chatSSE = (deltas, finish) => {
  const base = { id: "chatcmpl-acc-s", object: "chat.completion.chunk", created: 3, model: "acc-model" };
  const chunks = deltas.map((delta) => ({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }));
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  return [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
};

const chatTextSSE = () => chatSSE([{ role: "assistant", content: "" }, { content: "acceptance-final-answer" }], "stop");

const chatToolSSE = (name, args) =>
  chatSSE(
    [
      { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_acc_${n}`, type: "function", function: { name, arguments: "" } }] },
      { tool_calls: [{ index: 0, function: { arguments: args } }] },
    ],
    "tool_calls",
  );

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => setTimeout(handle, delayNow()));
  function handle() {
    n++;
    const auth = req.headers.authorization ?? "";
    const entry = {
      n, method: req.method, url: req.url, hasClientSentinel: auth.includes("client-sentinel"),
      hasJevSentinel: auth.includes("jev-sentinel"), auth: auth ? auth.slice(0, 20) : "(none)", body,
    };
    appendFileSync(LOG, JSON.stringify(entry) + "\n");
    const spec = wantsTool(body);
    let payload = chatText();
    let contentType = "application/json";
    if (req.url.startsWith("/v1/responses")) {
      payload = respTextSSE();
      contentType = "text/event-stream";
      if (spec) payload = respToolSSE(spec.name, spec.args);
    } else if (req.url.startsWith("/v1/chat/completions")) {
      let stream = true;
      try {
        stream = JSON.parse(body || "{}").stream !== false;
      } catch {}
      if (spec) {
        payload = stream ? chatToolSSE(spec.name, spec.args) : chatTool(spec.name, spec.args);
        if (stream) contentType = "text/event-stream";
      } else if (stream) {
        payload = chatTextSSE();
        contentType = "text/event-stream";
      }
    }
    res.writeHead(200, { "content-type": contentType });
    res.end(payload);
  }
}).listen(PORT, "127.0.0.1", () => console.log(`acceptance-model on 127.0.0.1:${PORT}`));
