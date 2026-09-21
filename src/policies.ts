// Per-tool routing policies: passthrough | selection-only | direct-eligible.
// Global JEV_DIRECT_CALLS=false always wins. Policies never remove tools
// from the upstream request and never infer trust from names or MCP
// descriptions. OpenCode approvals stay authoritative.

export type ToolPolicy = "passthrough" | "selection-only" | "direct-eligible";

export interface PolicyRule {
  match: string;
  policy: ToolPolicy;
}

export interface PolicyConfig {
  /** Default for unknown tools. Absent config defaults to direct-eligible (existing behavior). */
  default: ToolPolicy;
  rules: PolicyRule[];
}

export const normalizeToolName = (name: string): string => name.trim().toLowerCase();

const POLICY_ORDER: Record<ToolPolicy, number> = {
  passthrough: 0,
  "selection-only": 1,
  "direct-eligible": 2,
};

/** Most restrictive wins on ties: passthrough > selection-only > direct-eligible. */
function moreRestrictive(a: ToolPolicy, b: ToolPolicy): ToolPolicy {
  return POLICY_ORDER[a] <= POLICY_ORDER[b] ? a : b;
}

function isValidPattern(pattern: string): boolean {
  if (!pattern || pattern.length > 128) return false;
  // Documented simple patterns: exact names plus `*`/`?` wildcards
  // (whole-value, matched case-insensitively after normalization).
  if (!/^[\p{L}\p{N}_.:/\-*?]+$/u.test(pattern)) return false;
  return true;
}

function patternToRegExp(pattern: string): RegExp {
  const esc = pattern
    .toLowerCase()
    .split("")
    .map((ch) => {
      if (ch === "*") return ".*";
      if (ch === "?") return ".";
      return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    })
    .join("");
  return new RegExp(`^${esc}$`);
}

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

export function parsePolicyConfig(raw: unknown): PolicyConfig {
  if (raw === undefined || raw === null || raw === "") return { default: "direct-eligible", rules: [] };
  const obj: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new Error("tool policies must be an object");
  // Unknown fields are rejected: a typo like {defualt: ...} must throw,
  // never silently fall back to the permissive default.
  for (const k of Object.keys(obj)) {
    if (k !== "default" && k !== "rules" && k !== "$comment")
      throw new Error(`unknown tool policy field: ${k}`);
  }
  const def = hasOwn(obj, "default") ? (obj as any).default : "direct-eligible";
  if (def !== "passthrough" && def !== "selection-only" && def !== "direct-eligible")
    throw new Error(`invalid default policy: ${def}`);
  const rulesRaw = hasOwn(obj, "rules") ? (obj as any).rules : [];
  if (!Array.isArray(rulesRaw)) throw new Error("tool policy rules must be an array");
  const rules: PolicyRule[] = rulesRaw.map((r: any, i: number) => {
    if (typeof r !== "object" || r === null || Array.isArray(r)) throw new Error(`policy rule ${i} must be an object`);
    for (const k of Object.keys(r)) {
      if (k !== "match" && k !== "policy") throw new Error(`unknown policy rule field: ${k}`);
    }
    if (typeof r.match !== "string" || !isValidPattern(r.match)) throw new Error(`invalid policy match: ${r.match}`);
    if (r.policy !== "passthrough" && r.policy !== "selection-only" && r.policy !== "direct-eligible")
      throw new Error(`invalid policy: ${r.policy}`);
    return { match: r.match, policy: r.policy as ToolPolicy };
  });
  return { default: def as ToolPolicy, rules };
}

/**
 * Resolve policy for a tool name.
 * Precedence: exact normalized match > pattern (longer pattern wins) >
 * default. Same-specificity conflicts resolve to the most restrictive.
 * When `roster` is given and two distinct roster names share a normalized
 * form with the selected tool, the identity is ambiguous and resolves to
 * passthrough regardless of rules.
 */
export function policyFor(toolName: string, config: PolicyConfig, roster: string[] = []): ToolPolicy {
  const norm = normalizeToolName(toolName);
  if (roster.some((other) => other !== toolName && normalizeToolName(other) === norm)) return "passthrough";
  // Exact normalized matches first.
  const exact = config.rules.filter((r) => !r.match.includes("*") && !r.match.includes("?") && normalizeToolName(r.match) === norm);
  if (exact.length) {
    return exact.reduce((a, b) => moreRestrictive(a, b.policy), exact[0]!.policy);
  }
  let best: { rule: PolicyRule; len: number } | undefined;
  let bestPolicy: ToolPolicy | undefined;
  for (const rule of config.rules) {
    if (!rule.match.includes("*") && !rule.match.includes("?")) continue;
    if (!patternToRegExp(rule.match).test(norm)) continue;
    const len = rule.match.replace(/[*?]/g, "").length;
    if (!best || len > best.len) {
      best = { rule, len };
      bestPolicy = rule.policy;
    } else if (len === best.len && bestPolicy) {
      bestPolicy = moreRestrictive(bestPolicy, rule.policy);
    }
  }
  return bestPolicy ?? config.default;
}
