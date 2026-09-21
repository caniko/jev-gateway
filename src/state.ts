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
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      throw new Error(`${key} must be a positive finite number, got "${String(value)}"`);
  }
}

function isToolResult(turn: Turn): boolean {
  return (turn as any).role === "tool_result";
}

function isAssistantCalls(turn: Turn): boolean {
  return Array.isArray((turn as any).tool_calls);
}

/**
 * Jev state: the content the questions are asked about.
 * Preserves tool-call/result association and complete recent interaction
 * groups (assistant calls + following results are atomic). Truncation and
 * omission are explicit. Never infers IDs or promotes tool text to system.
 */
export function buildState(input: Pick<RouterInput, "system" | "turns">, limits: Limits): { [key: string]: Json } {
  validateLimits(limits);
  const systemText = truncate(input.system, limits.maxMessageChars);
  let budget = limits.maxStateChars - systemText.length;

  // Group from the front: each assistant tool_calls turn plus its following
  // tool_result turns is one atomic group; other turns are singletons.
  // Built newest-first so omission never keeps a result without its call.
  type Group = { turns: Turn[]; size: number };
  const groups: Group[] = [];
  {
    let cur: Turn[] = [];
    const flush = () => {
      if (cur.length) {
        const size = cur.reduce((s, t) => s + JSON.stringify(t).length, 0);
        groups.push({ turns: cur, size });
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

  const conversation: Turn[] = [];
  let omitted = 0;
  let truncatedNewest = false;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi]!;
    if (budget - g.size < 0 && conversation.length > 0) {
      omitted += g.turns.length;
      continue;
    }
    if (budget - g.size < 0) {
      // Oversized newest group: bound it by truncating text fields to fit,
      // marking explicit truncation. Structured tool results that no longer
      // fit safely are left marked truncated so decide() can bypass.
      const fitted: Turn[] = [];
      let b = budget;
      for (let ti = g.turns.length - 1; ti >= 0; ti--) {
        const t = { ...(g.turns[ti] as object) } as Turn;
        const s = JSON.stringify(t);
        if (s.length <= b || fitted.length === 0) {
          if (s.length > b) {
            for (const k of ["text", "content", "arguments"] as const) {
              const v = (t as any)[k];
              if (typeof v === "string" && v.length > 0) {
                const allow = Math.max(0, b - 100);
                (t as any)[k] = truncate(v, Math.min(v.length, allow));
                truncatedNewest = true;
              }
            }
            // Nested tool_calls arguments.
            const calls = (t as any).tool_calls;
            if (Array.isArray(calls)) {
              for (const c of calls) {
                if (c && typeof (c as any).arguments === "string") {
                  (c as any).arguments = truncate((c as any).arguments, Math.max(0, b - 100));
                  truncatedNewest = true;
                }
              }
            }
          }
          fitted.unshift(t);
          b -= JSON.stringify(t).length;
        } else {
          omitted += 1;
        }
      }
      conversation.unshift(...fitted);
      budget = b;
      break;
    }
    conversation.unshift(...g.turns);
    budget -= g.size;
  }
  // Any turns not covered (should not happen) count as omitted.
  omitted += input.turns.length - conversation.length - omitted > 0 ? input.turns.length - conversation.length - omitted : 0;

  const newestHasTruncatedToolResult = conversation.some(
    (t) => isToolResult(t) && typeof (t as any).content === "string" && (t as any).content.includes("[truncated]"),
  );
  return {
    ...(systemText ? { assistant_instructions: systemText } : {}),
    ...(omitted ? { earlier_turns_omitted: omitted } : {}),
    ...(truncatedNewest || newestHasTruncatedToolResult ? { truncated_routing_context: true } : {}),
    conversation,
  };
}

/**
 * When routing-relevant structured results cannot be preserved safely,
 * bypass rather than presenting chopped JSON/IDs as complete evidence.
 * Conservative: only the newest interaction group can trigger this; ordinary
 * text omission still routes.
 */
export function incompleteRoutingContext(state: { [key: string]: Json }): string | undefined {
  if (state.truncated_routing_context) return "incomplete_routing_context";
  return undefined;
}
