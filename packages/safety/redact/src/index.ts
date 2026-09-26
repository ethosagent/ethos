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
  // S13 additions (plan openclaw-2026.9.6-gaps). Each is pinned, with a
  // near-miss that must NOT redact, by __tests__/redact-roster-s13.test.ts.
  // STS session credentials: same shape as AKIA, `ASIA` prefix.
  {
    label: 'AWS temporary access key',
    tag: '[REDACTED:aws-key]',
    regex: /\bASIA[0-9A-Z]{16}\b/g,
  },
  // GitHub OAuth (gho_), user-to-server (ghu_) and server-to-server (ghs_)
  // tokens share ghp_'s 36-char body.
  { label: 'GitHub token', tag: '[REDACTED:github-token]', regex: /\bgh[sou]_[A-Za-z0-9]{36}\b/g },
  // Refresh tokens (ghr_): the same prefix + base62 body + word boundaries,
  // with the family's 36-char body as a FLOOR rather than an exact length —
  // the refresh-token body length is not pinned here, and a floor cannot miss
  // a longer one. The `\b` pair keeps `ghrelin` and `ghr_short` out.
  { label: 'GitHub token', tag: '[REDACTED:github-token]', regex: /\bghr_[A-Za-z0-9]{36,}\b/g },
  {
    label: 'Google API key',
    tag: '[REDACTED:google-api-key]',
    regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  },
  // `<bot id>:<35-char secret>`. The digit lookbehind keeps it from starting
  // mid-number; the 35-char floor is what separates it from `12:30`-style text.
  {
    label: 'Telegram bot token',
    tag: '[REDACTED:telegram-token]',
    regex: /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
  },
  // Only the PRIVATE block is a secret; a certificate or public key is not.
  {
    label: 'PEM private key',
    tag: '[REDACTED:private-key]',
    regex:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  },
  // header.payload.signature, where header and payload are base64url JSON
  // objects (`{"` encodes to `eyJ`). Runs before the Bearer pattern.
  {
    label: 'JWT',
    tag: '[REDACTED:jwt]',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  // Case-sensitive `Bearer` + a 20-char token floor, so prose ("the bearer of",
  // "Bearer tokenization") does not match.
  {
    label: 'Bearer token',
    tag: '[REDACTED:bearer-token]',
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  },
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
  // xAI documents keys only as "xai- followed by a long alphanumeric string" and
  // publishes no fixed length, so the floor is a conservative 20 (same as Groq's)
  // rather than a guessed exact width: long enough that prose cannot trip it,
  // short enough that no real key is missed. Confidence: MED on the body length,
  // HIGH on the `xai-` prefix.
  { label: 'xAI API key', tag: '[REDACTED:xai-key]', regex: /xai-[A-Za-z0-9]{20,}/g },
  {
    label: 'Generic secret',
    tag: '[REDACTED:generic-secret]',
    // biome-ignore format: long regex must stay on one line
    regex: /(?<=^|[\s,{;(])(?:key|token|password|secret)=["']?[A-Za-z0-9+/=_-]{20,}["']?/gi,
  },
];

export interface SecretDetection {
  label: string;
}

export function detectSecrets(value: string): SecretDetection[] {
  const detections: SecretDetection[] = [];
  for (const p of PATTERNS) {
    p.regex.lastIndex = 0;
    if (p.regex.test(value)) {
      detections.push({ label: p.label });
      p.regex.lastIndex = 0;
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

export const PII_PATTERNS: ReadonlyArray<{ label: string; tag: string; regex: RegExp }> = [
  {
    label: 'Email',
    tag: '[REDACTED:email]',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  { label: 'Credit card', tag: '[REDACTED:card]', regex: /\b(?:\d[ -]?){13,16}\b/g },
  {
    label: 'Phone (E.164)',
    tag: '[REDACTED:phone]',
    regex: /\+?[1-9]\d{1,3}[\s-]?\(?\d{1,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}/g,
  },
  { label: 'SSN (US)', tag: '[REDACTED:ssn]', regex: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g },
  { label: 'IBAN', tag: '[REDACTED:iban]', regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{1,30}\b/g },
];

export function redactPii(value: string, extraPatterns?: string[]): string {
  let out = value;
  for (const p of PII_PATTERNS) {
    p.regex.lastIndex = 0;
    out = out.replace(p.regex, p.tag);
  }
  if (extraPatterns) {
    for (const pat of extraPatterns) {
      if (pat.length > 200) continue;
      try {
        const re = new RegExp(pat, 'g');
        const before = out;
        out = out.replace(re, '[REDACTED:custom]');
        if (out === before) continue;
      } catch {
        /* skip malformed patterns */
      }
    }
  }
  return out;
}
