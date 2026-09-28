// `(?<![A-Za-z0-9_-])` — used as the LEFT BOUNDARY of every prefixed vendor
// pattern below (UBP-045). Without it a prefix matched mid-identifier:
// `disk-usage-report-…` became `di[REDACTED:openai-key]`, and the model then
// asked for a path that does not exist. Pinned by the 'UBP-045' cases in
// __tests__/redact-roster-s13.test.ts.
const PATTERNS: ReadonlyArray<{ label: string; tag: string; regex: RegExp }> = [
  {
    label: 'GitHub PAT',
    tag: '[REDACTED:github-pat]',
    regex: /(?<![A-Za-z0-9_-])ghp_[A-Za-z0-9]{36}/g,
  },
  {
    label: 'GitHub PAT',
    tag: '[REDACTED:github-pat]',
    regex: /(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{82}/g,
  },
  {
    label: 'Anthropic API key',
    tag: '[REDACTED:anthropic-key]',
    regex: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{93,}/g,
  },
  // The left boundary is what keeps `disk-…`, `risk-…` and `task-…` out: each
  // contains `sk-` mid-word. The body is deliberately NOT required to look
  // mixed-case — an identifier that literally STARTS with `sk-` and runs 40+
  // chars is rare, and a lowercase synthetic key is how several callers' tests
  // (packages/wiring decision-site/decision-tool) exercise redaction.
  {
    label: 'OpenAI API key',
    tag: '[REDACTED:openai-key]',
    regex: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{40,}/g,
  },
  {
    label: 'AWS access key',
    tag: '[REDACTED:aws-key]',
    regex: /(?<![A-Za-z0-9_-])AKIA[0-9A-Z]{16}/g,
  },
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
    regex: /(?<![A-Za-z0-9_-])xox[bpoa]-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}/g,
  },
  {
    label: 'Slack app token',
    tag: '[REDACTED:slack-token]',
    regex: /(?<![A-Za-z0-9_-])xapp-[0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+/g,
  },
  {
    label: 'Stripe key',
    tag: '[REDACTED:stripe-key]',
    regex: /(?<![A-Za-z0-9_-])sk_live_[A-Za-z0-9]{24,}/g,
  },
  {
    label: 'Groq API key',
    tag: '[REDACTED:groq-key]',
    regex: /(?<![A-Za-z0-9_-])gsk_[A-Za-z0-9]{20,}/g,
  },
  // xAI documents keys only as "xai- followed by a long alphanumeric string" and
  // publishes no fixed length, so the floor is a conservative 20 (same as Groq's)
  // rather than a guessed exact width: long enough that prose cannot trip it,
  // short enough that no real key is missed. Confidence: MED on the body length,
  // HIGH on the `xai-` prefix.
  {
    label: 'xAI API key',
    tag: '[REDACTED:xai-key]',
    regex: /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9]{20,}/g,
  },
  // UBP-044. `<base64 bot id>.<6-char timestamp>.<27+ char HMAC>`; the first
  // segment of every bot id Discord issues today begins M, N or O. Matching all
  // three segments here, before the generic rules, is what keeps
  // `token=<discord>` from leaving the 2nd and 3rd segments behind.
  {
    label: 'Discord bot token',
    tag: '[REDACTED:discord-token]',
    // biome-ignore format: long regex must stay on one line
    regex: /(?<![A-Za-z0-9_-])[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}(?![A-Za-z0-9_-])/g,
  },
  {
    label: 'Generic secret',
    tag: '[REDACTED:generic-secret]',
    // biome-ignore format: long regex must stay on one line
    regex: /(?<=^|[\s,{;(])(?:key|token|password|secret)=["']?[A-Za-z0-9+/=_-]{20,}["']?/gi,
  },
  // UBP-044. A value assigned to an UPPER_SNAKE name that says it is a secret
  // (`DISCORD_BOT_TOKEN=`, `export ELEVENLABS_API_KEY=`, `DB_PASSWORD: `) — the
  // shape `env`, a `.env` file and YAML config print. Only the value is
  // replaced, so the model still sees which variable was set. Case-sensitive on
  // purpose: `MAX_TOKENS=4096` (suffix is TOKENS) and `tokenizer=` do not match.
  // A value already tagged by a vendor pattern above, or a `$VAR` / `${{ … }}`
  // reference, is left as it is.
  {
    label: 'Secret-named value',
    tag: '[REDACTED:secret-value]',
    // biome-ignore format: long regex must stay on one line
    regex: /(?<=\b[A-Z0-9_]*(?:API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|AUTH_KEY|TOKEN|SECRET|PASSWORD|PASSWD)[ \t]*[=:][ \t]*["']?)(?![$[])[^\s"'`]{8,}/g,
  },
  // UBP-044. The JSON-key form, `"elevenlabs_api_key": "…"` / `"apiKey":"…"`.
  // A bare `"key"` (an S3 object key, a map key) is NOT a secret name, and a
  // pagination `"nextPageToken"` / `"page_token"` is a cursor the model must be
  // able to pass back, so both are excluded.
  {
    label: 'Secret-named value',
    tag: '[REDACTED:secret-value]',
    // biome-ignore format: long regex must stay on one line
    regex: /(?<="[A-Za-z0-9_-]*(?:(?:api|access|secret|private|auth)[_-]?key|(?<![Pp]age_?)token|secret|password|passwd)"\s*:\s*")(?!\[REDACTED:)[^"\\]{8,}(?=")/gi,
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
