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
  // The body may not cross another `-----BEGIN ` (V-ES-2): a plain lazy
  // `[\s\S]*?` scanned from every unterminated header to the end of the input,
  // so a page of headers with no END line was quadratic. Pinned by
  // __tests__/redact-perf.test.ts.
  {
    label: 'PEM private key',
    tag: '[REDACTED:private-key]',
    regex:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S])*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  },
  // header.payload.signature, where header and payload are base64url JSON
  // objects (`{"` encodes to `eyJ`). Runs before the Bearer pattern. The left
  // boundary is the vendor one, not `\b` (V-ES-2): `\b` let a match start after
  // every `-`, and the header body accepts `-`, so `eyJ-eyJ-…` rescanned the
  // rest of the run from each one — quadratic. Pinned by
  // __tests__/redact-perf.test.ts.
  {
    label: 'JWT',
    tag: '[REDACTED:jwt]',
    regex: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  // Case-sensitive `Bearer` + a 20-char token floor, so prose ("the bearer of",
  // "Bearer tokenization") does not match.
  {
    label: 'Bearer token',
    tag: '[REDACTED:bearer-token]',
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  },
  // V2-SEC-4. `Authorization: Basic <base64 user:pass>` (and
  // `Proxy-Authorization:`). Anchored on the header name, not on `Basic`
  // alone. V3-5: the value must have base64's shape — whole 4-char groups,
  // `=` padding only at the end, at least 8 chars, and nothing base64 after it
  // — rather than "not one English word", which let a letters-only credential
  // (`dXNlcjpwYXNz`) through. Prose ("Authorization: Basic authentication is
  // disabled", "Basic auth") is not a whole number of groups. Bounded
  // quantifiers (V-ES-2). Pinned by the 'V3-5' cases in
  // __tests__/redact-roster-s13.test.ts.
  {
    label: 'Basic auth credentials',
    tag: '$<pre>[REDACTED:basic-auth]',
    // biome-ignore format: long regex must stay on one line
    regex: /(?<pre>\bAuthorization:[ \t]{0,32}Basic[ \t]{1,32})(?:[A-Za-z0-9+/]{4}){1,1024}(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)(?![A-Za-z0-9+/=])/gi,
  },
  // V2-SEC-4. The password in a URL's userinfo, `scheme://user:pass@host`
  // (`mysql://root:pw@db`, an authenticated proxy URL). Only the password is
  // replaced. The user part cannot contain `:`, `@` or `/`, so the match
  // commits at the first `:` and fails at the first `/` — linear, and
  // `https://host:8080/…` and `ssh://git@host/…` do not match.
  // V3-9: the user part may be empty (`redis://:pass@host`), and a templated
  // or placeholder password is left alone, so a patch to a config file still
  // matches its text. V4-1: exempt only when the WHOLE password (up to the `@`)
  // is one template shape — `${…}`, `$VAR_NAME` (upper-case, the env-var
  // convention), `{{…}}`, `%(name)s`, `%NAME%`, `<…>`, or all `*` / all `x`.
  // A first character alone proves nothing: `$ecretP4ss` is a real password,
  // and a password starting with a URL-reserved symbol is percent-encoded
  // (`%40…`). Pinned by the 'V3-9' and 'V4-1' cases in
  // __tests__/redact-roster-s13.test.ts.
  {
    label: 'URL credentials',
    tag: '$<pre>[REDACTED:url-credential]',
    // biome-ignore format: long regex must stay on one line
    regex: /(?<pre>\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/@:]{0,256}:)(?!\[REDACTED:)(?!(?:\$\{[^\s}@]{1,64}\}|\$[A-Z_][A-Z0-9_]{0,63}|\{\{[^\s}@]{1,64}\}\}|%\([A-Za-z_][A-Za-z0-9_]{0,63}\)s|%[A-Za-z_][A-Za-z0-9_]{0,63}%|<[^\s<>@]{1,64}>|\*{1,256}|[xX]{1,256})@)[^\s/@]{1,256}(?=@)/g,
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
  //
  // V-ES-2: the name and separator are CAPTURED (`$<pre>` in the tag puts them
  // back) and every quantifier before the value is bounded. The first version
  // held them in a variable-length lookbehind, which the engine re-evaluates
  // backwards at every position — 100k spaces took ~15s, on every tool result.
  // A name prefix longer than 64 chars, or more than 32 blanks around the `=`
  // (V2-SEC-4: terraform fmt and INI align columns wider than 8), is no longer
  // recognised; neither is a shape `env` or a config file prints.
  // Pinned by __tests__/redact-perf.test.ts.
  //
  // V2-SEC-4 / V3-5: after a `:` (prose, YAML, a README's config table), a
  // PLACEHOLDER is not a secret. The set is closed, case-insensitive, and only
  // ever a whole value (optionally followed by `.,;!?)`):
  //   - the words required, optional, none, null, nil, true, false, empty,
  //     unset — what a docs table or schema prints where a value goes;
  //   - `your_…_here` / `YOUR-…-HERE` — the `.env.example` spelling;
  //   - `<…>` (`<your-password>`), `***…` (3+), `xxx…` (3+).
  // `${…}` and `$VAR` are handled by the `(?![$[])` guard. Anything else —
  // including a letters-only word such as `SecretPassWord` or
  // `congratulations`, and `changeme`, which IS the password wherever it is
  // left in place — redacts. The first version exempted any 1-15 letters,
  // and under the lowercase rule's `i` flag that meant letters-only secrets.
  // After `=` (env, .env, INI, terraform) every value still redacts. Pinned by
  // the 'V2-SEC-4' and 'V3-5' cases in __tests__/redact-roster-s13.test.ts.
  {
    label: 'Secret-named value',
    tag: '$<pre>[REDACTED:secret-value]',
    // biome-ignore format: long regex must stay on one line
    regex: /(?<pre>\b[A-Z0-9_]{0,64}(?:API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|AUTH_KEY|TOKEN|SECRET|PASSWORD|PASSWD)[ \t]{0,32}[=:][ \t]{0,32}["']?)(?![$[])(?!(?<=:[ \t]{0,32}["']?)(?i:required|optional|none|null|nil|true|false|empty|unset|your[_-][a-z0-9_-]{0,48}[_-]here|<[^\s>]{1,64}>|\*{3,64}|x{3,64})[.,;!?)]{0,4}(?:[\s"'`]|$))[^\s"'`]{8,}/g,
  },
  // V-ES-4. The lowercase and camelCase assignment forms UPPER_SNAKE misses: an
  // AWS credentials-file line (`aws_secret_access_key = …`), `.npmrc`'s
  // `:_authToken=`, `api_key=`, `apiKey:`, `db_password: `, Rails'
  // `secret_key_base:`. Case-insensitive, so the name list is narrower than the
  // rule above: bare `token`/`secret`/`key` are left out, which is what keeps
  // `max_tokens:` and `tokenizer=` alone, and the 12-char value floor keeps
  // `password: required`. Bounded quantifiers and a captured name for the
  // V-ES-2 reason. Pinned by the 'V-ES-4' cases in this file's roster test.
  // V2-SEC-4: up to 32 blanks around the separator (column-aligned files),
  // `session_token` (the AWS credentials-file STS line), `api_token`,
  // `bearer_token` and the `x-api-key` header, and the same closed placeholder
  // set after `:` as the rule above (V3-5). Pinned by the 'V2-SEC-4' and
  // 'V3-5' cases.
  {
    label: 'Secret-named value',
    tag: '$<pre>[REDACTED:secret-value]',
    // biome-ignore format: long regex must stay on one line
    regex: /(?<pre>\b[A-Za-z0-9_]{0,48}(?:api[_-]?key|api_?token|access_?token|auth_?token|refresh_?token|session_?token|bearer_?token|client_?secret|secret(?:_access)?_key(?:_base)?|access_key(?:_id)?|password|passwd)[ \t]{0,32}[=:][ \t]{0,32}["']?)(?![$[])(?!(?<=:[ \t]{0,32}["']?)(?:required|optional|none|null|nil|true|false|empty|unset|your[_-][a-z0-9_-]{0,48}[_-]here|<[^\s>]{1,64}>|\*{3,64}|x{3,64})[.,;!?)]{0,4}(?:[\s"'`]|$))[^\s"'`&]{12,}/gi,
  },
  // V-ES-4. A credential in a URL query (`?access_token=`, `&api_key=`,
  // `?token=`, a maps `?key=`). A pagination cursor (`page_token`,
  // `next_page_token`, `pageToken`) is not a secret and must round-trip, so the
  // `(?<!page[_-]?)` guard excludes it; `key` counts only as the WHOLE name, so
  // `sort_key=` and `monkey=` stay.
  {
    label: 'URL credential parameter',
    tag: '$<pre>[REDACTED:secret-value]',
    // biome-ignore format: long regex must stay on one line
    regex: /(?<pre>[?&](?:(?:[A-Za-z0-9_-]{0,32}[_-])?(?:access_?token|auth_?token|id_?token|refresh_?token|api_?key|apikey|(?<!page[_-]?)token|secret|password|passwd)|key)=)(?![$[])[^\s&#"'`]{8,}/gi,
  },
  // UBP-044. The JSON-key form, `"elevenlabs_api_key": "…"` / `"apiKey":"…"`.
  // A bare `"key"` (an S3 object key, a map key) is NOT a secret name, and a
  // pagination `"nextPageToken"` / `"page_token"` is a cursor the model must be
  // able to pass back, so both are excluded. Captured and bounded for the same
  // reason as the rule above (V-ES-2).
  {
    label: 'Secret-named value',
    tag: '$<pre>[REDACTED:secret-value]',
    // biome-ignore format: long regex must stay on one line
    regex: /(?<pre>"[A-Za-z0-9_-]{0,64}(?:(?:api|access|secret|private|auth)[_-]?key|(?<![Pp]age_?)token|secret|password|passwd)"\s{0,8}:\s{0,8}")(?!\[REDACTED:)[^"\\]{8,}(?=")/gi,
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
  // The local part starts only at the beginning of a run of local-part
  // characters (V-ES-2). With `\b` a match could start after every `.` or `-`,
  // and each start rescanned the rest of the run looking for an `@`, so
  // `a.a.a.…` with no `@` was quadratic. Pinned by __tests__/redact-perf.test.ts.
  {
    label: 'Email',
    tag: '[REDACTED:email]',
    regex: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
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
