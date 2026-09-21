// Conservative multimodal guard: Jev is text-only. If a request contains
// content Jev cannot inspect, route passthrough without a Jev call, without
// forcing tools/none/direct, preserving original attachments and model.
//
// Stable bypass reason: "multimodal_content" (metadata only, no payload).
// Old images in history also bypass: we do not guess an image was already
// understood.

export const MULTIMODAL_SKIP = "multimodal_content";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Chat Completions: messages[].content is string | parts[] | null.
export function hasChatMultimodal(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (!isRecord(m)) continue;
    const c = (m as any).content;
    if (c == null || typeof c === "string") continue;
    if (!Array.isArray(c)) return true;
    for (const part of c) {
      if (!isRecord(part)) return true;
      const t = (part as any).type;
      // Text parts are the only Jev-readable shape.
      if (t !== "text") return true;
      if (typeof (part as any).text !== "string") return true;
      // Even a text-typed part carrying file/image payloads is opaque.
      if ("image_url" in part || "input_audio" in part || "file" in part) return true;
    }
    // Tool-call arguments are JSON text; tool content arrays already covered.
  }
  return false;
}

// Responses: input is string | items[]. Only explicitly text-shaped items
// are Jev-readable; every other typed item (images, files, audio,
// item_reference and any future opaque kind) bypasses.
const RESPONSES_TEXT_ITEM = new Set(["message", "additional_tools", "reasoning"]);
const RESPONSES_CALL_ITEM = new Set(["function_call", "custom_tool_call", "local_shell_call"]);

export function hasResponsesMultimodal(input: unknown): boolean {
  if (input == null || typeof input === "string") return false;
  if (!Array.isArray(input)) return false;
  for (const item of input) {
    if (!isRecord(item)) continue;
    const t = (item as any).type as string | undefined;
    if (typeof t === "string") {
      if (RESPONSES_TEXT_ITEM.has(t)) {
        // message items carry their payload in content (checked below).
      } else if (RESPONSES_CALL_ITEM.has(t)) {
        continue;
      } else if (t.endsWith("_call_output")) {
        const out = (item as any).output;
        if (typeof out === "string") continue;
        // Structured output may embed screenshots: be conservative.
        if (Array.isArray(out)) {
          for (const p of out) {
            if (!isRecord(p)) continue;
            const pt = (p as any).type;
            if (pt !== undefined && pt !== "input_text" && pt !== "output_text") return true;
          }
        } else if (isRecord(out)) return true;
        continue;
      } else {
        // input_image, item_reference, hosted traces, and any unknown
        // item kind: Jev cannot see the referenced content.
        return true;
      }
    }
    const content = (item as any).content;
    if (content == null || typeof content === "string") continue;
    if (!Array.isArray(content)) return true;
    for (const part of content) {
      if (!isRecord(part)) return true;
      const pt = (part as any).type;
      if (pt !== "input_text" && pt !== "output_text" && pt !== "text") return true;
      if ("image_url" in part || "file" in part || "file_id" in part) return true;
    }
    if ("image_url" in item || "file" in item) return true;
  }
  return false;
}

// Anthropic Messages: blocks with type image/document/etc., including nested
// tool-result images and file references.
export function hasMessagesMultimodal(req: { system?: unknown; messages?: unknown }): boolean {
  const checkBlocks = (blocks: unknown): boolean => {
    if (typeof blocks === "string" || blocks == null) return false;
    if (!Array.isArray(blocks)) return true;
    for (const b of blocks) {
      if (!isRecord(b)) return true;
      const t = (b as any).type as string | undefined;
      if (t === "text") {
        if (typeof (b as any).text !== "string") return true;
        continue;
      }
      if (t === "tool_use" || t === "server_tool_use") continue;
      if (t === "thinking" || t === "redacted_thinking") continue;
      if (t === "tool_result" || (typeof t === "string" && t.endsWith("_tool_result"))) {
        const inner = (b as any).content;
        if (typeof inner === "string" || inner == null) continue;
        if (!Array.isArray(inner)) return true;
        for (const p of inner) {
          if (!isRecord(p)) return true;
          const pt = (p as any).type;
          if (pt !== "text") return true;
        }
        continue;
      }
      // Any other block (image, document, file, etc.) is opaque.
      return true;
    }
    return false;
  };
  if (checkBlocks((req as any).system)) return true;
  const msgs = (req as any).messages;
  if (!Array.isArray(msgs)) return false;
  for (const m of msgs) {
    if (!isRecord(m)) continue;
    if (checkBlocks((m as any).content)) return true;
  }
  return false;
}

// Blob keys that are never text, at any nesting depth inside a part.
const GEMINI_BLOB_KEYS = new Set(["inlineData", "inline_data", "fileData", "file_data", "media", "blob"]);

function hasBlobKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasBlobKey);
  if (isRecord(v)) return Object.entries(v).some(([k, val]) => GEMINI_BLOB_KEYS.has(k) || hasBlobKey(val));
  return false;
}

// Gemini: parts are text | functionCall | functionResponse. Anything else
// (inlineData/fileData/media, at any depth) is opaque. Never downloads URLs.
export function hasGeminiMultimodal(contents: unknown): boolean {
  if (!Array.isArray(contents)) return false;
  for (const c of contents) {
    if (!isRecord(c)) continue;
    const parts = (c as any).parts;
    if (parts == null) continue;
    if (!Array.isArray(parts)) return true;
    for (const p of parts) {
      if (!isRecord(p)) return true;
      if (hasBlobKey(p)) return true;
      if (typeof (p as any).text === "string" && Object.keys(p).length === 1) continue;
      if (Object.keys(p).length === 1 && isRecord((p as any).functionCall)) continue;
      if (Object.keys(p).length === 1 && isRecord((p as any).functionResponse)) {
        // functionResponse.response should be a JSON object; anything else
        // (including extra sibling keys) is opaque.
        const fr = (p as any).functionResponse;
        if (Object.keys(fr).some((k) => k !== "name" && k !== "response" && k !== "id")) return true;
        const r = fr.response;
        if (r != null && !isRecord(r)) return true;
        continue;
      }
      // Mixed or unknown part shape.
      return true;
    }
  }
  return false;
}
