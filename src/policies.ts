export type ToolPolicy = "passthrough" | "selection-only" | "direct-eligible";
interface PolicyRule {
  match: string;
  tokens: string[];
  exact: boolean;
  specificity: number;
  policy: ToolPolicy;
}
export interface PolicyConfig { default: ToolPolicy; rules: PolicyRule[] }
export const normalizeToolName = (name: string): string => name.toLowerCase();
const ORDER: Record<ToolPolicy, number> = { passthrough: 0, "selection-only": 1, "direct-eligible": 2 };
const isPolicy = (value: unknown): value is ToolPolicy => typeof value === "string" && Object.hasOwn(ORDER, value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parsePolicyConfig(raw: unknown): PolicyConfig {
  if (raw === undefined || raw === "") return { default: "direct-eligible", rules: [] };
  const fail = (detail: string): never => { throw new Error(`JEV_TOOL_POLICIES ${detail}, got ${JSON.stringify(raw)}`); };
  let value: unknown;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return fail("must be a JSON object"); }
  if (!isRecord(value) || Object.keys(value).some((key) => !["default", "rules", "$comment"].includes(key))) return fail("must contain only default, rules, and $comment");
  const defaultPolicy = Object.hasOwn(value, "default") ? value.default : "direct-eligible";
  if (!isPolicy(defaultPolicy)) return fail("has an invalid default policy");
  const rules = Object.hasOwn(value, "rules") ? value.rules : [];
  if (!Array.isArray(rules) || rules.length > 128) return fail("must contain at most 128 rules");
  return { default: defaultPolicy, rules: rules.map((rule: unknown) => {
    if (!isRecord(rule) || Object.keys(rule).some((key) => !["match", "policy"].includes(key))) return fail("has an invalid rule");
    if (typeof rule.match !== "string" || rule.match.length > 128 || !/^[\p{L}\p{N}_.:/\-*?]+$/u.test(rule.match)) return fail("has an invalid match pattern");
    if (!isPolicy(rule.policy)) return fail("has an invalid rule policy");
    const match = normalizeToolName(rule.match);
    const tokens = Array.from(match);
    return { match, tokens, exact: !tokens.includes("*") && !tokens.includes("?"),
      specificity: rule.match.replace(/[*?]/g, "").length, policy: rule.policy };
  }) };
}

/** Dynamic programming avoids regex backtracking: O(pattern × name) time, O(pattern) space. */
function matches(tokens: string[], name: string): boolean {
  let previous = new Array<boolean>(tokens.length + 1).fill(false);
  previous[0] = true;
  for (let j = 1; j <= tokens.length; j++) previous[j] = tokens[j - 1] === "*" && previous[j - 1]!;
  for (const char of name) {
    const next = new Array<boolean>(tokens.length + 1).fill(false);
    for (let j = 1; j <= tokens.length; j++) {
      const token = tokens[j - 1];
      next[j] = token === "*" ? next[j - 1]! || previous[j]! : (token === "?" || token === char) && previous[j - 1]!;
    }
    previous = next;
  }
  return previous[tokens.length]!;
}

export function policyFor(name: string, config: PolicyConfig, roster: string[] = []): ToolPolicy {
  const normalized = normalizeToolName(name);
  if (roster.some((other) => other !== name && normalizeToolName(other) === normalized)) return "passthrough";
  let best = -1;
  let policy = config.default;
  for (const rule of config.rules) {
    if (!(rule.exact ? rule.match === normalized : matches(rule.tokens, normalized))) continue;
    const rank = rule.exact ? 129 : rule.specificity;
    if (rank > best || (rank === best && ORDER[rule.policy] < ORDER[policy])) {
      best = rank;
      policy = rule.policy;
    }
  }
  return policy;
}
