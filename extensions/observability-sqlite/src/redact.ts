// Credential redaction filter — always-on, applied before any write to observability.db.
// Mutates no external state; pure string -> string transform.

const PATTERNS: Array<[RegExp, string]> = [
  [/ghp_[A-Za-z0-9]{36}/g, '[REDACTED:github-pat]'],
  [/github_pat_[A-Za-z0-9_]{82}/g, '[REDACTED:github-pat]'],
  [/sk-ant-[A-Za-z0-9_-]{93,}/g, '[REDACTED:anthropic-key]'],
  [/sk-(?:proj-)?[A-Za-z0-9_-]{40,}/g, '[REDACTED:openai-key]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws-key]'],
  [/xox[bpoa]-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}/g, '[REDACTED:slack-token]'],
  [/sk_live_[A-Za-z0-9]{24,}/g, '[REDACTED:stripe-key]'],
  [/(?:key|token|password|secret)=["']?[A-Za-z0-9+/=_-]{20,}["']?/gi, '[REDACTED:generic-secret]'],
];

/** Redact known credential patterns from a string. */
export function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Redact all string values in a JSON-serialisable object (deep). */
export function redactJson(obj: Record<string, unknown>): Record<string, unknown> {
  return redactValue(obj) as Record<string, unknown>;
}

function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(val);
    }
    return out;
  }
  return v;
}
