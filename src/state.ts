import type { Config } from "./config.js";
import type { Json, RouterInput, Turn } from "./types.js";

export type Limits = Pick<Config, "maxStateChars" | "maxMessageChars">;

/** Keep the head and tail of long text; the middle is what matters least for routing. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = " …[truncated]… ";
  const keep = Math.max(0, max - marker.length);
  const head = Math.ceil(keep * 0.6);
  return text.slice(0, head) + marker + text.slice(text.length - (keep - head));
}

/** Jev is text-only: flatten content parts and leave a placeholder for anything else. */
export function textOf(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part: { type?: string; text?: unknown }) =>
      typeof part?.text === "string" ? part.text : `[${part?.type ?? "attachment"}]`,
    )
    .join("\n");
}

export function validateLimits(limits: Limits): void {
  for (const key of ["maxStateChars", "maxMessageChars"] as const) {
    const value = limits[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
      throw new Error(`${key} must be a positive integer, got "${String(value)}"`);
  }
}

function isToolResult(turn: Turn): boolean {
  return (turn as any).role === "tool_result";
}

function isAssistantCalls(turn: Turn): boolean {
  return Array.isArray((turn as any).tool_calls);
}

const TRUNCATED_MARKER = "[truncated]";

function callsOf(turn: Turn): Array<{ tool?: unknown; arguments?: unknown; call_id?: unknown }> {
  return isAssistantCalls(turn) ? ((turn as any).tool_calls as Array<Record<string, unknown>>) : [];
}

/** Truncation markers inside tool calls/results mean chopped structured evidence. */
function hasTruncatedStructured(turns: Turn[]): boolean {
  return turns.some((t) => {
    if (isToolResult(t) && typeof (t as any).content === "string" && (t as any).content.includes(TRUNCATED_MARKER))
      return true;
    return callsOf(t).some(
      (c) => typeof c.arguments === "string" && (c.arguments as string).includes(TRUNCATED_MARKER),
    );
  });
}

/**
 * Jev state: the content the questions are asked about.
 *
 * - Keeps a contiguous suffix of complete interaction groups: each
 *   assistant tool_calls turn plus its following tool_result turns is
 *   atomic, so a kept result always keeps its call. Once a group stops
 *   fitting, everything older is omitted (never a hole in the middle).
 * - The total serialized state, including envelope keys and omission
 *   metadata, stays within maxStateChars. An oversized newest group is
 *   deep-cloned and truncated to fit, marked explicit.
 * - Never infers identifiers and never promotes tool text to system
 *   instructions. Only Jev input is shaped here; the upstream request is
 *   untouched.
 */
export function buildState(input: Pick<RouterInput, "system" | "turns">, limits: Limits): { [key: string]: Json } {
  validateLimits(limits);
  // Fixed envelope reservation: keys plus worst-case omission metadata and
  // flags, so caps computed against it hold for the serialized total.
  const ENVELOPE_FIXED = JSON.stringify({
    assistant_instructions: "",
    earlier_turns_omitted: 10000000000,
    truncated_routing_context: true,
    conversation: [],
  }).length;
  let systemText = truncate(input.system, limits.maxMessageChars);
  // The system prompt itself is bounded: when it alone exceeds the budget
  // it is clipped to fit and marked, never allowed to silently squeeze out
  // bounded turns or blow the total.
  let systemTruncated = false;
  const maxSystem = Math.max(0, limits.maxStateChars - ENVELOPE_FIXED);
  if (systemText.length > maxSystem) {
    systemText = truncate(systemText, maxSystem);
    systemTruncated = true;
  }
  const overhead = JSON.stringify({ conversation: [] }).length + 32;
  let budget = limits.maxStateChars - systemText.length - overhead;

  type Group = { turns: Turn[]; size: number };
  const groups: Group[] = [];
  {
    let cur: Turn[] = [];
    const flush = () => {
      if (cur.length) {
        groups.push({ turns: cur, size: cur.reduce((s, t) => s + JSON.stringify(t).length, 0) });
        cur = [];
      }
    };
    for (const turn of input.turns) {
      if (isAssistantCalls(turn)) {
        flush();
        cur.push(turn);
      } else if (isToolResult(turn) && cur.length && isAssistantCalls(cur[0]!)) {
        cur.push(turn);
      } else {
        flush();
        cur.push(turn);
        flush();
      }
    }
    flush();
  }

  // Newest-first selection; the first group that stops fitting ends
  // selection so the kept suffix stays contiguous.
  const kept: Group[] = [];
  let truncatedNewest = false;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi]!;
    if (g.size <= budget) {
      kept.unshift(g);
      budget -= g.size;
      continue;
    }
    if (kept.length > 0) break;
    // Only the newest group may be fitted, and it stays whole: deep-clone
    // (never mutate the caller's turns) and shrink its text fields
    // proportionally so call/result association survives. The target is the
    // exact envelope, so the serialized total fits the budget. Marked
    // explicit. (Degenerate budgets below the minimal envelope+markers are
    // the only exception; integer validation rejects non-positive limits.)
    const clones = g.turns.map((t) => structuredClone(t) as Turn);
    const fields: Array<{ o: Record<string, unknown>; k: string }> = [];
    for (const t of clones) {
      for (const k of ["text", "content"] as const) {
        if (typeof (t as any)[k] === "string") fields.push({ o: t as unknown as Record<string, unknown>, k });
      }
      for (const c of callsOf(t)) {
        if (typeof c.arguments === "string") fields.push({ o: c as unknown as Record<string, unknown>, k: "arguments" });
      }
    }
    const fieldLen = fields.reduce((s, f) => s + ((f.o[f.k] as string) || "").length, 0);
    const fixed = JSON.stringify(clones).length - fieldLen;
    const omittedAfter = input.turns.length - g.turns.length;
    const envelope = JSON.stringify({
      ...(systemText ? { assistant_instructions: systemText } : {}),
      ...(omittedAfter ? { earlier_turns_omitted: omittedAfter } : {}),
      truncated_routing_context: true,
      conversation: [],
    }).length;
    const available = limits.maxStateChars - envelope - fixed;
    // When not even scaffolding plus truncation markers fit, keep no turns:
    // an explicitly flagged empty suffix still fits and bypasses safely.
    if (available < fields.length * 18) {
      truncatedNewest = true;
      kept.unshift({ turns: [], size: 0 });
      break;
    }
    if (available < fieldLen) {
      for (const f of fields) {
        const v = f.o[f.k] as string;
        f.o[f.k] = truncate(v, Math.max(0, Math.floor((v.length * Math.max(0, available)) / Math.max(1, fieldLen))));
      }
      truncatedNewest = true;
    }
    kept.unshift({ turns: clones, size: 0 });
    break;
  }

  // Final enforcement: the serialized state, envelope included, fits the
  // budget by dropping oldest whole groups (association-safe). A single
  // remaining turn is minimal by construction.
  while (kept.length > 1) {
    const probe: { [key: string]: Json } = {
      ...(systemText ? { assistant_instructions: systemText } : {}),
      earlier_turns_omitted: input.turns.length - kept.flatMap((g) => g.turns).length,
      ...(truncatedNewest ? { truncated_routing_context: true } : {}),
      conversation: kept.flatMap((g) => g.turns),
    };
    if (JSON.stringify(probe).length <= limits.maxStateChars) break;
    kept.shift();
  }

  const conversation = kept.flatMap((g) => g.turns);
  const omitted = input.turns.length - conversation.length;
  const result: { [key: string]: Json } = {
    ...(systemText ? { assistant_instructions: systemText } : {}),
    ...(omitted ? { earlier_turns_omitted: omitted } : {}),
    ...(truncatedNewest || systemTruncated || hasTruncatedStructured(conversation)
      ? { truncated_routing_context: true }
      : {}),
    conversation,
  };
  return result;
}

/** Call/result association check over kept turns, by preserved call IDs. */
export function danglingResult(conversation: Turn[]): boolean {
  const ids = new Set<string>();
  for (const t of conversation) {
    for (const c of callsOf(t)) if (typeof c.call_id === "string") ids.add(c.call_id);
  }
  return conversation.some((t) => isToolResult(t) && typeof (t as any).call_id === "string" && !ids.has((t as any).call_id));
}

/**
 * When routing-relevant structured results cannot be preserved safely,
 * bypass rather than presenting chopped JSON/IDs or disconnected results
 * as complete evidence. Ordinary text omission still routes.
 */
export function incompleteRoutingContext(state: { [key: string]: Json }): string | undefined {
  if (state.truncated_routing_context) return "incomplete_routing_context";
  const conversation = Array.isArray(state.conversation) ? (state.conversation as Turn[]) : [];
  if (danglingResult(conversation)) return "incomplete_routing_context";
  return undefined;
}
