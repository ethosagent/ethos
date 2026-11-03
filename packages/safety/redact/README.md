# @ethosagent/safety-redact

## Purpose

Redacts secrets and PII from strings and JSON values: vendor key formats (GitHub, Anthropic, OpenAI, AWS, Google, Telegram tokens, PEM keys, JWTs, bearer tokens and more) become `[REDACTED:<kind>]` tags, and `redactPii` handles emails and phone numbers. It has no runtime dependencies.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `redactString` | function | Replaces secrets in a string with tags. |
| `redactJson` | function | Redacts secrets in a JSON value. |
| `detectSecrets` | function | Reports the secrets found in a string. |
| `SecretDetection` | interface | One detected secret. |
| `redactPii` | function | Replaces PII in a string with tags. |
| `PII_PATTERNS` | const | The PII pattern list. |

## Seam

Security-kernel layer (`kernel-reads-contracts` in `architecture.config.ts`). It is consumed through the wiring passthrough (`packages/wiring/src/index.ts` re-exports `redactString`); `architecture.config.ts` also records exception EX-001 for the crash logger importing it directly. The tests below pin the redaction behaviour, including linear time on adversarial input; no static rule enforces that every log path redacts (limitation).

## Testing

```
pnpm vitest run packages/safety/redact
```

- `src/__tests__/redact-secrets.test.ts`: vendor key formats redacted and labelled.
- `src/__tests__/redact-roster-s13.test.ts`: roster additions and the left-boundary cases (UBP-045).
- `src/__tests__/redact-pii.test.ts`: emails and phone numbers redacted, clean text unchanged.
- `src/__tests__/redact-perf.test.ts`: redaction stays linear on adversarial input.
