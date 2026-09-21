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

// Responses: input is string | items[]. Items may carry input_text,
// input_image, file refs, or nested tool-result images.
export function hasResponsesMultimodal(input: unknown): boolean {
  if (input == null || typeof input === "string") return false;
  if (!Array.isArray(input)) return false;
  for (const item of input) {
    if (!isRecord(item)) continue;
    const t = (item as any).type as string | undefined;
    if (typeof t === "string") {
      if (t === "input_image" || t === "output_image") return true;
      if (t.includes("image") || t.includes("audio") || t.includes("video") || t.includes("file") || t.includes("document"))
        return true;
      if (t === "additional_tools") continue;
      if (t.endsWith("_call_output")) {
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

// Gemini: parts are text | functionCall | functionResponse. Anything else
// (inlineData/fileData/media) is opaque. Never downloads URLs.
export function hasGeminiMultimodal(contents: unknown): boolean {
  if (!Array.isArray(contents)) return false;
  for (const c of contents) {
    if (!isRecord(c)) continue;
    const parts = (c as any).parts;
    if (parts == null) continue;
    if (!Array.isArray(parts)) return true;
    for (const p of parts) {
      if (!isRecord(p)) return true;
      if (typeof (p as any).text === "string" && Object.keys(p).length === 1) continue;
      if ((p as any).functionCall && Object.keys(p).every((k) => k === "functionCall" || k === "text")) continue;
      if ((p as any).functionResponse) {
        // functionResponse.response should be JSON; embedded blobs are opaque.
        const r = (p as any).functionResponse.response;
        if (r != null && typeof r !== "object") return true;
        if (isRecord(r)) {
          const s = JSON.stringify(r);
          if (s.includes("inlineData") || s.includes("fileData") || s.includes("base64")) return true;
        }
        continue;
      }
      // Unknown part shape (inlineData, fileData, etc.).
      if ("inlineData" in p || "inline_data" in p || "fileData" in p || "file_data" in p || "media" in p) return true;
      if (!("text" in p) && !("functionCall" in p) && !("functionResponse" in p)) return true;
    }
  }
  return false;
}
