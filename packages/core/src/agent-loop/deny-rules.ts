// ---------------------------------------------------------------------------
// Personality deny rules (`PersonalityConfig.safety.denyRules`) — the matcher.
//
// Pure and import-free, so core can own it (core imports only
// `@ethosagent/types`, ARCHITECTURE.md §II). The one caller that ENFORCES a match is
// `enforceBeforeToolCall` in `./stages/per-call-enforcement.ts`, which runs it
// before any `before_tool_call` hook fires; pinned by
// `./__tests__/deny-rule-gate.test.ts`.
// ---------------------------------------------------------------------------

/**
 * Stable stringification of tool args — sorted keys, so `{a:1,b:2}` and
 * `{b:2,a:1}` produce the same text. Shared with `createSmartApprover`
 * (`@ethosagent/wiring`), whose verdict cache keys off the same canonical form.
 */
export function canonicalizeArgs(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalizeArgs).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeArgs(v)}`).join(',')}}`;
}

/**
 * First deny rule matching this call, or null. Each rule is a case-sensitive
 * substring of `` `${toolName} ${canonical-json-args}` ``; zero-length rules
 * never match.
 */
export function matchDenyRule(
  rules: ReadonlyArray<string> | undefined,
  toolName: string,
  args: unknown,
): string | null {
  if (!rules?.length) return null;
  const subject = `${toolName} ${canonicalizeArgs(args)}`;
  return rules.find((rule) => rule.length > 0 && subject.includes(rule)) ?? null;
}

/** The rejection text a deny-rule match surfaces to the agent. */
export function denyRuleReason(rule: string): string {
  return `denied by personality deny rule: ${rule}`;
}
