import { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
// NOTE: @opencode/ai is a type-only import (erased at runtime, so the packed
// plugin never needs it installed). It pins the exact 2.0.12 hook payload
// shapes this adapter was verified against.
import type { Message, SystemPart } from "@opencode/ai";

// Thin OpenCode v2 integration for jev-gateway.
//
// What this does: on each primary agent-loop model request, it maps the
// visible v2 session context to the gateway's routing representation,
// asks /router/decide which tool Jev would select, and appends that
// selection as a routing *hint* to the system prompt. The main model still
// decides, executes, and owns approvals; nothing is forced, nothing is
// executed here.
//
// What this deliberately does NOT do:
// - No direct/synthetic model responses (the `context` hook exposes no
//   result field; that capability stays in the gateway proxy transport).
// - No MCP client, no tool execution, no agent loop, no captioning.
// - No network calls except the single gateway decision fetch, bounded by
//   timeout and fail-open: any failure leaves the request untouched.
//
// Mapping is conservative: anything Jev cannot inspect (images, files,
// audio, encrypted blobs, unknown part shapes, malformed calls/results)
// bypasses the gateway entirely rather than presenting chopped evidence
// as complete. Reasoning parts are skipped: model-internal thinking is
// not routing evidence.
export interface JevPluginOptions {
  /** Gateway origin, e.g. http://127.0.0.1:8791. Defaults to the launcher port. */
  gatewayUrl?: string;
  /** Decision fetch budget in ms, integer 1..120000. Defaults to 1500. */
  timeoutMs?: number;
  /** Set to false to load the plugin without registering the hook. */
  enabled?: boolean;
}

export interface HintOutcome {
  applied: boolean;
  reason: string;
  tool?: string;
}

export interface ResolvedConfig {
  gatewayUrl: string;
  timeoutMs: number;
}

type FetchImpl = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string | undefined {
  try {
    const out = JSON.stringify(value);
    return typeof out === "string" ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Explicit option contract; unknown keys and malformed values throw at load. */
export function resolveOptions(raw: unknown): ResolvedConfig {
  const options = raw === undefined ? {} : raw;
  if (!isRecord(options)) throw new Error("jev-gateway: options must be an object");
  for (const key of Object.keys(options)) {
    if (key !== "gatewayUrl" && key !== "timeoutMs" && key !== "enabled") {
      throw new Error(`jev-gateway: unknown option "${key}"`);
    }
  }
  if (options.enabled !== undefined && typeof options.enabled !== "boolean") {
    throw new Error(`jev-gateway: enabled must be a boolean, got "${String(options.enabled)}"`);
  }
  const gatewayUrl = options.gatewayUrl ?? "http://127.0.0.1:8791";
  if (typeof gatewayUrl !== "string") {
    throw new Error(`jev-gateway: gatewayUrl must be a string, got "${String(gatewayUrl)}"`);
  }
  let parsed: URL;
  try {
    parsed = new URL(gatewayUrl);
  } catch {
    throw new Error(`jev-gateway: invalid gatewayUrl "${gatewayUrl}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`jev-gateway: gatewayUrl must be http(s), got "${parsed.protocol}"`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("jev-gateway: gatewayUrl must not embed credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("jev-gateway: gatewayUrl must not carry a query string or fragment");
  }
  const timeoutMs: unknown = options.timeoutMs ?? 1500;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new Error(`jev-gateway: timeoutMs must be an integer 1..120000, got "${String(timeoutMs)}"`);
  }
  return { gatewayUrl, timeoutMs };
}

export interface ChatMessage {
  role: string;
  content?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

type TextOrOpaque = { text: string } | { opaque: true };

/** Classify one tool result: supported text/structured evidence, else opaque. */
export function toolResultText(result: unknown): TextOrOpaque {
  if (!isRecord(result)) return { opaque: true };
  const type = result.type;
  if (type === "text" || type === "error") {
    if (typeof result.value === "string") return { text: result.value };
    const json = safeJson(result.value);
    return json === undefined ? { opaque: true } : { text: json };
  }
  if (type === "json") {
    const json = safeJson(result.value);
    return json === undefined ? { opaque: true } : { text: json };
  }
  if (type === "content") {
    if (!Array.isArray(result.value)) return { opaque: true };
    const texts: string[] = [];
    for (const item of result.value) {
      if (!isRecord(item)) return { opaque: true };
      // A file entry (e.g. an MCP-returned screenshot) is evidence Jev
      // cannot inspect: bypass rather than serialize it into text.
      if (item.type === "text" && typeof item.text === "string") {
        texts.push(item.text);
        continue;
      }
      return { opaque: true };
    }
    return { text: texts.join("\n") };
  }
  return { opaque: true };
}

/**
 * Encode tool-call input as a JSON arguments string, or refuse.
 * The SDK input is a value, not source text: strings are data and always
 * encoded, never passed through as presumed JSON.
 */
function encodeArguments(input: unknown): { args: string } | { opaque: true } {
  const json = safeJson(input);
  return json === undefined ? { opaque: true } : { args: json };
}

/**
 * Map a v2 session `context` event to chat-completions messages preserving
 * routing context: system instructions, every text turn in order, and
 * tool-call/result association by call ID. Returns `opaque` when anything
 * present is something Jev cannot inspect.
 *
 * Pinned 2.0.12 shapes: content parts carry `{type:"text",text}`,
 * `{type:"tool-call",id,name,input}`, `{type:"tool-result",id,name,result}`,
 * `{type:"media",...}`, `{type:"reasoning",...}`, or
 * `{type:"compaction",...}`; system is `[{type:"text",text}]`.
 */
export function toChatMessages(event: { system?: unknown; messages?: unknown }): {
  messages?: ChatMessage[];
  opaque?: boolean;
} {
  const out: ChatMessage[] = [];
  if (event.system !== undefined && !Array.isArray(event.system)) return { opaque: true };
  const system: ReadonlyArray<SystemPart> = Array.isArray(event.system)
    ? (event.system as ReadonlyArray<SystemPart>)
    : [];
  const sysTexts: string[] = [];
  for (const part of system) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return { opaque: true };
    sysTexts.push(part.text);
  }
  const sysJoined = sysTexts.join("\n\n");
  if (sysJoined.trim() !== "") out.push({ role: "system", content: sysJoined });

  const messages: ReadonlyArray<Message> = Array.isArray(event.messages)
    ? (event.messages as ReadonlyArray<Message>)
    : [];
  if (event.messages !== undefined && !Array.isArray(event.messages)) return { opaque: true };
  if (!Array.isArray(event.messages)) return out.length > 0 ? { messages: out } : {};
  for (const message of messages) {
    // A message without a usable role, or with content that is neither
    // text nor a part list, cannot be interpreted: bypass rather than
    // silently dropping part of the conversation.
    if (!isRecord(message) || typeof message.role !== "string") return { opaque: true };
    const role: string = message.role;
    if (!["system", "user", "assistant", "tool"].includes(role)) return { opaque: true };
    const content = message.content;
    if (typeof content === "string") {
      if (role === "tool") return { opaque: true };
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) return { opaque: true };
    if (role === "tool" && content.some((part) => !isRecord(part) || part.type !== "tool-result")) {
      return { opaque: true };
    }
    const texts: string[] = [];
    const calls: NonNullable<ChatMessage["tool_calls"]> = [];
    // Result turns emitted for the current message, so trailing message
    // text can join them instead of becoming a mislabeled turn.
    const resultTurns: ChatMessage[] = [];
    const flushAssistant = () => {
      if (texts.join("").trim() !== "" || calls.length > 0) {
        out.push({
          role,
          ...(texts.join("").trim() !== "" ? { content: texts.join("\n") } : {}),
          ...(calls.length > 0 ? { tool_calls: calls.splice(0) } : {}),
        });
        texts.length = 0;
      }
    };
    for (const part of content) {
      if (!isRecord(part)) return { opaque: true };
      if (part.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
        continue;
      }
      if (part.type === "media") return { opaque: true };
      if (part.type === "reasoning") continue;
      if (part.type === "compaction") {
        if (typeof part.text === "string" && part.text.trim() !== "") {
          texts.push(part.text);
          continue;
        }
        return { opaque: true };
      }
      if (part.type === "tool-call") {
        if (role !== "assistant" || part.providerExecuted === true) return { opaque: true };
        if (typeof part.id !== "string" || typeof part.name !== "string") return { opaque: true };
        // Namespaced tools route through provider-specific handling the
        // gateway cannot reproduce; bypass rather than strip the namespace.
        if (typeof part.namespace === "string" && part.namespace !== "") return { opaque: true };
        const encoded = encodeArguments((part as { input?: unknown }).input);
        if (!("args" in encoded)) return { opaque: true };
        calls.push({ id: part.id, type: "function", function: { name: part.name, arguments: encoded.args } });
        continue;
      }
      if (part.type === "tool-result") {
        if (role !== "tool" || part.providerExecuted === true || part.namespace) return { opaque: true };
        if (typeof part.id !== "string") return { opaque: true };
        const classified = toolResultText((part as { result?: unknown }).result);
        if (!("text" in classified)) return { opaque: true };
        // Result parts always carry their call ID, whatever message role
        // they arrived in, so association survives without silent drops.
        // Pending text is NOT flushed as a separate turn here: for tool
        // messages it joins the result turns at message end.
        if (role !== "tool") flushAssistant();
        const turn: ChatMessage = { role: "tool", tool_call_id: part.id, content: classified.text };
        out.push(turn);
        resultTurns.push(turn);
        continue;
      }
      return { opaque: true };
    }
    if (role === "tool") {
      // Message-level text is attributable only when the message carries
      // exactly one result; with several results the text could belong to
      // any of them, so bypass rather than guess. With no results the text
      // stands alone; the gateway then attributes it as unknown, which the
      // test pins as the documented fallback.
      if (texts.join("").trim() !== "") {
        if (resultTurns.length === 1) {
          const last = resultTurns[resultTurns.length - 1] as { content?: string };
          last.content = `${last.content ?? ""}\n${texts.join("\n")}`;
        } else if (resultTurns.length === 0) {
          out.push({ role, content: texts.join("\n") });
        } else {
          return { opaque: true };
        }
      }
      continue;
    }
    flushAssistant();
  }
  return out.length > 0 ? { messages: out } : {};
}

export interface DecideResult {
  mode: unknown;
  tool: unknown;
  confidence: unknown;
}

/** Validate a gateway decision against the captured roster before applying. */
export function parseDecision(
  value: unknown,
  roster: ReadonlyArray<string>,
): { tool: string; confidence: number; mode: string } | { error: string } {
  if (!isRecord(value)) return { error: "decision_malformed" };
  const { mode, tool, confidence } = value as unknown as DecideResult;
  if (mode !== "forced" && mode !== "hint" && mode !== "direct") {
    return { error: `decision_${String(mode ?? "unknown")}` };
  }
  if (typeof tool !== "string" || tool === "" || !roster.includes(tool)) {
    return { error: "decision_unknown_tool" };
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { error: "decision_unverified" };
  }
  return { tool, confidence, mode };
}

function modelLabel(model: unknown): string | undefined {
  if (!isRecord(model)) return undefined;
  const { providerID, id } = model as { providerID?: unknown; id?: unknown };
  if (typeof providerID !== "string" || providerID === "" || typeof id !== "string" || id === "") return undefined;
  return `${providerID}/${id}`;
}

/** Minimal structural surface applyJevHint needs; SessionContext satisfies it. */
export interface HintEvent {
  tools?: Record<string, { description?: unknown; input?: unknown }>;
  messages?: unknown;
  system?: unknown;
  model?: unknown;
}

export async function applyJevHint(
  event: HintEvent,
  config: ResolvedConfig,
  fetchImpl: FetchImpl = fetch,
): Promise<HintOutcome> {
  const tools = event.tools ?? {};
  const names = Object.keys(tools);
  if (names.length === 0) return { applied: false, reason: "no_tools" };
  const { messages, opaque } = toChatMessages(event);
  if (opaque) return { applied: false, reason: "multimodal" };
  if (messages === undefined || messages.length === 0) return { applied: false, reason: "no_text" };
  const model = modelLabel(event.model);
  if (model === undefined) return { applied: false, reason: "malformed_model" };
  let decision: unknown;
  try {
    const response = await fetchImpl(`${config.gatewayUrl.replace(/\/+$/, "")}/router/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools: names.map((name) => ({
          type: "function",
          function: {
            name,
            description: String(tools[name]?.description ?? ""),
            parameters: tools[name]?.input ?? {},
          },
        })),
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) return { applied: false, reason: `gateway_http_${response.status}` };
    decision = (await response.json()) as unknown;
  } catch {
    return { applied: false, reason: "gateway_unreachable" };
  }
  const parsed = parseDecision(decision, names);
  if (!("tool" in parsed)) return { applied: false, reason: parsed.error };
  // The hint needs an array to land in; anything else leaves the request
  // unchanged rather than pretending it was annotated.
  if (!Array.isArray(event.system)) return { applied: false, reason: "no_system_target" };
  event.system.push({
    type: "text",
    text: `[jev-routing] Jev suggests tool "${parsed.tool}" (confidence ${parsed.confidence.toFixed(2)}) for this request.`,
  });
  return { applied: true, reason: parsed.mode, tool: parsed.tool };
}

export default Plugin.define({
  id: "jev-gateway",
  async setup(ctx) {
    const config = resolveOptions(ctx.options);
    if ((ctx.options as JevPluginOptions | undefined)?.enabled === false) return;
    // `context` covers the agent loop (including continuations) but not
    // title/compaction/generate, which have their own hooks.
    await ctx.session.hook("context", async (event) => {
      try {
        await applyJevHint(event, config);
      } catch {
        // Fail open: routing assistance must never break a model request.
      }
    });
  },
});
