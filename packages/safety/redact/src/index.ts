const PATTERNS: ReadonlyArray<{ label: string; tag: string; regex: RegExp }> = [
  { label: 'GitHub PAT', tag: '[REDACTED:github-pat]', regex: /ghp_[A-Za-z0-9]{36}/g },
  { label: 'GitHub PAT', tag: '[REDACTED:github-pat]', regex: /github_pat_[A-Za-z0-9_]{82}/g },
  {
    label: 'Anthropic API key',
    tag: '[REDACTED:anthropic-key]',
    regex: /sk-ant-[A-Za-z0-9_-]{93,}/g,
  },
  {
    label: 'OpenAI API key',
    tag: '[REDACTED:openai-key]',
    regex: /sk-(?:proj-)?[A-Za-z0-9_-]{40,}/g,
  },
  { label: 'AWS access key', tag: '[REDACTED:aws-key]', regex: /AKIA[0-9A-Z]{16}/g },
  {
    label: 'Slack token',
    tag: '[REDACTED:slack-token]',
    regex: /xox[bpoa]-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}/g,
  },
  {
    label: 'Slack app token',
    tag: '[REDACTED:slack-token]',
    regex: /xapp-[0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+/g,
  },
  { label: 'Stripe key', tag: '[REDACTED:stripe-key]', regex: /sk_live_[A-Za-z0-9]{24,}/g },
  { label: 'Groq API key', tag: '[REDACTED:groq-key]', regex: /gsk_[A-Za-z0-9]{20,}/g },
  {
    label: 'Generic secret',
    tag: '[REDACTED:generic-secret]',
    // biome-ignore format: long regex must stay on one line
    regex: /(?<=^|[\s,{;(])(?:key|token|password|secret)=["']?[A-Za-z0-9+/=_-]{20,}["']?/gi,
  },
];

export interface SecretDetection {
  label: string;
  match: string;
}

export function detectSecrets(value: string): SecretDetection[] {
  const detections: SecretDetection[] = [];
  for (const p of PATTERNS) {
    p.regex.lastIndex = 0;
    let m = p.regex.exec(value);
    while (m !== null) {
      detections.push({ label: p.label, match: m[0] });
      m = p.regex.exec(value);
    }
  }
  return detections;
}

export function redactString(value: string, extraPatterns?: string[]): string {
  let out = value;
  for (const p of PATTERNS) {
    out = out.replace(p.regex, p.tag);
  }
  if (extraPatterns) {
    for (const pat of extraPatterns) {
      try {
        out = out.replace(new RegExp(pat, 'g'), '[REDACTED:custom]');
      } catch {
        // Invalid regex — skip silently
      }
    }
  }
  return out;
}

export function redactJson(
  obj: Record<string, unknown>,
  extraPatterns?: string[],
): Record<string, unknown> {
  return redactValue(obj, extraPatterns) as Record<string, unknown>;
}

function redactValue(v: unknown, extraPatterns?: string[]): unknown {
  if (typeof v === 'string') return redactString(v, extraPatterns);
  if (Array.isArray(v)) return v.map((item) => redactValue(item, extraPatterns));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(val, extraPatterns);
    }
    return out;
  }
  return v;
}
