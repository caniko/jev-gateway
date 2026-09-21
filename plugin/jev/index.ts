import { Plugin } from "@opencode/plugin";

// Thin OpenCode v2 integration for jev-gateway.
//
// What this does: on each primary agent-loop model request, it asks the
// gateway's /router/decide endpoint which tool Jev would select for the
// visible tool snapshot, and appends that selection as a routing *hint* to
// the system prompt. The main model still decides, executes, and owns
// approvals; nothing is forced, nothing is executed here.
//
// What this deliberately does NOT do:
// - No direct/synthetic model responses (the `context` hook exposes no
//   result field; that capability stays in the gateway proxy transport).
// - No MCP client, no tool execution, no agent loop, no captioning.
// - No network calls except the single gateway decision fetch, bounded by
//   timeout and fail-open: any failure leaves the request untouched.
//
// Multimodal requests (anything Jev cannot inspect) skip the gateway call
// entirely, mirroring the proxy's conservative passthrough.
export interface JevPluginOptions {
  /** Gateway origin, e.g. http://127.0.0.1:8791. Defaults to the launcher port. */
  gatewayUrl?: string;
  /** Decision fetch budget in ms. Defaults to 1500. */
  timeoutMs?: number;
  /** Set to false to load the plugin without registering the hook. */
  enabled?: boolean;
}

export interface HintOutcome {
  applied: boolean;
  reason: string;
  tool?: string;
}

type FetchImpl = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Map a v2 session `context` event to a chat-completions request preserving
 * the full routing context: system instructions, every text turn, and
 * tool-call/result association by call ID. Returns `opaque` when any part
 * is something Jev cannot inspect (images, files, audio, unknown shapes),
 * in which case the caller must skip the gateway entirely rather than
 * present chopped evidence as complete.
 *
 * Observed v2 shapes (pinned 2.0.12): content parts carry
 * `{type:"text",text}`, `{type:"tool-call",id,name,input}`, or
 * `{type:"tool-result",id,name,result:{type:"text",value}}`; system is
 * `[{type:"text",text}]`.
 */
export interface ChatMessage {
  role: string;
  content?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export function toChatMessages(event: {
  system?: unknown;
  messages?: unknown;
}): { messages?: ChatMessage[]; opaque?: boolean } {
  const out: ChatMessage[] = [];
  const system = event.system;
  if (Array.isArray(system)) {
    const texts: string[] = [];
    for (const part of system) {
      if (!isRecord(part) || (part as { type?: unknown }).type !== "text" || typeof (part as { text?: unknown }).text !== "string") {
        return { opaque: true };
      }
      texts.push((part as { text: string }).text);
    }
    const joined = texts.join("\n\n");
    if (joined.trim() !== "") out.push({ role: "system", content: joined });
  } else if (system !== undefined) {
    return { opaque: true };
  }
  if (!Array.isArray(event.messages)) return out.length > 0 ? { messages: out } : {};
  for (const message of event.messages) {
    if (!isRecord(message)) continue;
    const role = typeof (message as { role?: unknown }).role === "string" ? ((message as { role: string }).role) : undefined;
    if (role === undefined) continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    const calls: ChatMessage["tool_calls"] = [];
    let toolTurn: ChatMessage | undefined;
    for (const part of content) {
      if (!isRecord(part)) return { opaque: true };
      const type = (part as { type?: unknown }).type;
      if (
        "image_url" in part || "input_audio" in part || "file" in part || "inlineData" in part || "fileData" in part
      ) {
        return { opaque: true };
      }
      if (type === "text" && typeof (part as { text?: unknown }).text === "string") {
        texts.push((part as { text: string }).text);
        continue;
      }
      if (type === "tool-call") {
        const p = part as { id?: unknown; name?: unknown; input?: unknown };
        if (typeof p.id !== "string" || typeof p.name !== "string") return { opaque: true };
        calls.push({
          id: p.id,
          type: "function",
          function: { name: p.name, arguments: typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {}) },
        });
        continue;
      }
      if (type === "tool-result") {
        const p = part as { id?: unknown; result?: unknown };
        if (typeof p.id !== "string") return { opaque: true };
        const result = p.result as { type?: unknown; value?: unknown } | undefined;
        const text = isRecord(result) && result.type === "text" && typeof result.value === "string"
          ? result.value
          : JSON.stringify(result ?? null);
        out.push({ role: "tool", tool_call_id: p.id, content: text });
        toolTurn = out[out.length - 1];
        continue;
      }
      return { opaque: true };
    }
    if (role === "tool") {
      if (!toolTurn && texts.join("").trim() !== "") out.push({ role, content: texts.join("\n") });
      continue;
    }
    if (texts.join("").trim() !== "" || calls.length > 0) {
      out.push({ role, ...(texts.join("").trim() !== "" ? { content: texts.join("\n") } : {}), ...(calls.length > 0 ? { tool_calls: calls } : {}) });
    }
  }
  return out.length > 0 ? { messages: out } : {};
}

export async function applyJevHint(
  event: {
    tools?: Record<string, { description?: unknown; input?: unknown }>;
    messages?: unknown;
    system?: unknown;
  },
  config: { gatewayUrl: string; timeoutMs: number },
  fetchImpl: FetchImpl = fetch,
): Promise<HintOutcome> {
  const tools = event.tools ?? {};
  const names = Object.keys(tools);
  if (names.length === 0) return { applied: false, reason: "no_tools" };
  const { messages, opaque } = toChatMessages({ system: event.system, messages: event.messages });
  if (opaque) return { applied: false, reason: "multimodal" };
  if (messages === undefined || messages.length === 0) return { applied: false, reason: "no_text" };
  let decision: { mode?: unknown; tool?: unknown; confidence?: unknown };
  try {
    const response = await fetchImpl(`${config.gatewayUrl.replace(/\/+$/, "")}/router/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-plugin",
        messages,
        tools: names.map((name) => ({
          type: "function",
          function: { name, description: String(tools[name]?.description ?? ""), parameters: tools[name]?.input ?? {} },
        })),
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) return { applied: false, reason: `gateway_http_${response.status}` };
    decision = (await response.json()) as typeof decision;
  } catch {
    return { applied: false, reason: "gateway_unreachable" };
  }
  const mode = decision?.mode;
  const tool = decision?.tool;
  // The gateway only ever names tools from the snapshot sent above, but
  // validate anyway: an unknown, empty, or non-string tool leaves the
  // request unchanged rather than injecting untrusted text.
  if (
    (mode === "forced" || mode === "hint" || mode === "direct") &&
    typeof tool === "string" &&
    tool !== "" &&
    names.includes(tool)
  ) {
    const confidence =
      typeof decision?.confidence === "number" && Number.isFinite(decision.confidence)
        ? decision.confidence.toFixed(2)
        : "n/a";
    // The hint needs an array to land in; anything else leaves the request
    // unchanged rather than pretending it was annotated.
    if (!Array.isArray(event.system)) return { applied: false, reason: "no_system_target" };
    event.system.push({
      type: "text",
      text: `[jev-routing] Jev suggests tool "${tool}" (confidence ${confidence}) for this request.`,
    });
    return { applied: true, reason: String(mode), tool };
  }
  return { applied: false, reason: `decision_${String(mode ?? "unknown")}` };
}

export default Plugin.define({
  id: "jev-gateway",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as JevPluginOptions;
    if (options.enabled === false) return;
    const gatewayUrl = options.gatewayUrl ?? "http://127.0.0.1:8791";
    const timeoutMs = options.timeoutMs ?? 1500;
    // Validate explicit configuration at load time; unknown option keys are
    // rejected so typos cannot silently change behavior.
    for (const key of Object.keys(options)) {
      if (key !== "gatewayUrl" && key !== "timeoutMs" && key !== "enabled") {
        throw new Error(`jev-gateway: unknown option "${key}"`);
      }
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
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`jev-gateway: timeoutMs must be a positive number, got "${String(timeoutMs)}"`);
    }
    // `context` covers the agent loop (including continuations) but not
    // title/compaction/generate, which have their own hooks.
    await ctx.session.hook("context", async (event) => {
      try {
        await applyJevHint(event as never, { gatewayUrl, timeoutMs });
      } catch {
        // Fail open: routing assistance must never break a model request.
      }
    });
  },
});
