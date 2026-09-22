export type ToolPolicy = "passthrough" | "selection-only" | "direct-eligible";
interface PolicyRule {
  match: string;
  tokens: string[];
  exact: boolean;
  specificity: number;
  policy: ToolPolicy;
}
export interface PolicyConfig {
  default: ToolPolicy;
  rules: PolicyRule[];
  /**
   * Memoized roster-independent answers by folded name: explicit-rule hit or `default`.
   * Case-collision protection is roster-dependent, so it is applied outside this cache and
   * never stored in it. The map lives on the parsed config, so replacing the configuration
   * replaces the cache; it drops the oldest entry past 512 names.
   */
  cache: Map<string, ToolPolicy>;
}
/** Case-folded comparison: folding can expand a name, so matching scans the folded form. */
export const normalizeToolName = (name: string): string => name.toLowerCase();
const ORDER: Record<ToolPolicy, number> = { passthrough: 0, "selection-only": 1, "direct-eligible": 2 };
const isPolicy = (value: unknown): value is ToolPolicy => typeof value === "string" && Object.hasOwn(ORDER, value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Names cached per parsed configuration before the oldest is dropped. */
const POLICY_CACHE_LIMIT = 512;

export function parsePolicyConfig(raw: unknown): PolicyConfig {
  if (raw === undefined || raw === "") return { default: "direct-eligible", rules: [], cache: new Map() };
  const fail = (detail: string): never => { throw new Error(`JEV_TOOL_POLICIES ${detail}, got ${JSON.stringify(raw)}`); };
  let value: unknown;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return fail("must be a JSON object"); }
  if (value === null) return fail("must be a JSON object, got null");
  if (Array.isArray(value)) return fail("must be a JSON object, not an array");
  if (!isRecord(value) || Object.keys(value).some((key) => !["default", "rules"].includes(key))) {
    return fail("must contain only default and rules");
  }
  const defaultPolicy = Object.hasOwn(value, "default") ? value.default : "direct-eligible";
  if (!isPolicy(defaultPolicy)) return fail("has an invalid default policy");
  const rules = Object.hasOwn(value, "rules") ? value.rules : [];
  if (!Array.isArray(rules)) return fail("rules must be an array");
  if (rules.length > 128) return fail("must contain at most 128 rules");
  return { default: defaultPolicy, rules: rules.map((rule: unknown, index: number) => {
    if (!isRecord(rule)) return fail(`rule ${index} must be an object`);
    if (Object.keys(rule).some((key) => !["match", "policy"].includes(key))) {
      return fail(`rule ${index} must contain only match and policy`);
    }
    if (typeof rule.match !== "string" || rule.match.length === 0) return fail(`rule ${index} has an empty match pattern`);
    // Patterns are capped at 128 UTF-16 code units; routing limits names to 128 code points.
    if (rule.match.length > 128) return fail(`rule ${index} match exceeds 128 characters`);
    if (!/^[\p{L}\p{N}_.:/\-*?]+$/u.test(rule.match)) return fail(`rule ${index} has an invalid match pattern`);
    if (!isPolicy(rule.policy)) return fail(`rule ${index} has an invalid rule policy`);
    const match = normalizeToolName(rule.match);
    // Prepared once at startup: matching below then scans code points, never backtracking.
    const tokens = Array.from(match);
    return { match, tokens, exact: !tokens.includes("*") && !tokens.includes("?"),
      specificity: rule.match.replace(/[*?]/g, "").length, policy: rule.policy };
  }), cache: new Map() };
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

/**
 * Folded roster names with more than one spelling (`Read` vs `read`): callers compute this once
 * from the full roster and hand it to `policyFor`, so shortlisting can never hide a colliding
 * sibling. Exact duplicates are not collisions — they are rejected before routing — so a name
 * repeated with one spelling is absent from the set.
 */
export function caseCollisions(names: string[]): Set<string> {
  const spellings = new Map<string, Set<string>>();
  for (const name of names) {
    const folded = normalizeToolName(name);
    let seen = spellings.get(folded);
    if (!seen) spellings.set(folded, (seen = new Set()));
    seen.add(name);
  }
  return new Set([...spellings].filter(([, seen]) => seen.size > 1).map(([folded]) => folded));
}

/**
 * The roster-independent answer for one folded name: explicit-rule hit, else `default`. Memoized
 * on the parsed config because a "no tool" answer otherwise evaluates every roster tool against
 * every rule on every request (~10 ms for 10 short rules over a 280-tool roster, seconds at the
 * documented limits), while rosters repeat nearly unchanged.
 */
function resolvePolicyForName(normalized: string, config: PolicyConfig): ToolPolicy {
  const hit = config.cache.get(normalized);
  if (hit !== undefined) return hit;
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
  if (config.cache.size >= POLICY_CACHE_LIMIT) {
    const oldest = config.cache.keys().next();
    if (!oldest.done) config.cache.delete(oldest.value);
  }
  config.cache.set(normalized, policy);
  return policy;
}

export function policyFor(
  name: string,
  config: PolicyConfig,
  rosterOrCollisions: string[] | Set<string> = [],
): ToolPolicy {
  const normalized = normalizeToolName(name);
  const colliding = rosterOrCollisions instanceof Set
    ? rosterOrCollisions.has(normalized)
    : rosterOrCollisions.some((other) => other !== name && normalizeToolName(other) === normalized);
  // Collision protection only constrains operators who configured rules: unset or empty
  // configuration preserves direct-eligible behavior.
  if (colliding && config.rules.length > 0) return "passthrough";
  return resolvePolicyForName(normalized, config);
}
