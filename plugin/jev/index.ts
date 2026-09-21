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

/** Best-effort user text; undefined when absent or when opaque parts exist. */
export function extractUserText(messages: unknown): { text?: string; opaque?: boolean } {
  if (!Array.isArray(messages)) return {};
  let text: string | undefined;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      if ((message as { role?: unknown }).role === "user") text = content;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) return { opaque: true };
      if ("image_url" in part || "input_audio" in part || "file" in part || "inlineData" in part || "fileData" in part) {
        return { opaque: true };
      }
      if (typeof (part as { text?: unknown }).text === "string") {
        if ((message as { role?: unknown }).role === "user") text = (part as { text: string }).text;
        continue;
      }
      return { opaque: true };
    }
  }
  return text === undefined || text === "" ? {} : { text };
}

export async function applyJevHint(
  event: { tools?: Record<string, { description?: unknown; input?: unknown }>; messages?: unknown; system?: Array<{ type: string; text?: string }> },
  config: { gatewayUrl: string; timeoutMs: number },
  fetchImpl: FetchImpl = fetch,
): Promise<HintOutcome> {
  const tools = event.tools ?? {};
  const names = Object.keys(tools);
  if (names.length === 0) return { applied: false, reason: "no_tools" };
  const { text, opaque } = extractUserText(event.messages);
  if (opaque) return { applied: false, reason: "multimodal" };
  if (text === undefined || text.trim() === "") return { applied: false, reason: "no_text" };
  let decision: { mode?: unknown; tool?: unknown; confidence?: unknown };
  try {
    const response = await fetchImpl(`${config.gatewayUrl.replace(/\/+$/, "")}/router/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-plugin",
        messages: [{ role: "user", content: text }],
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
  if ((mode === "forced" || mode === "hint" || mode === "direct") && typeof tool === "string" && tool !== "") {
    const confidence = typeof decision?.confidence === "number" ? decision.confidence.toFixed(2) : "n/a";
    event.system?.push({
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
