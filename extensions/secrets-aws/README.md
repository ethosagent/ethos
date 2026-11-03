# @ethosagent/secrets-aws

## Purpose

AWS Secrets Manager backend for Ethos secrets. `AwsSecretsManagerResolver` reads, writes, deletes and lists secrets under a configured prefix, caches reads in memory, and turns missing-credential and access-denied failures into actionable errors. Choosing this resolver over another is wiring's job.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `AwsSecretsManagerResolver` | class | `SecretsResolver` over `@aws-sdk/client-secrets-manager` with a per-process cache. |
| `AwsSecretsManagerResolverConfig` | type | `region`, `prefix`, optional `endpoint` and an injectable `client`. |

The resolver also has `dispose()`, which removes its `SIGHUP` listener. A `SIGHUP` clears the cache so the next `get` re-fetches.

## Seam

Implements `SecretsResolver` from `@ethosagent/types` (`implements` on `AwsSecretsManagerResolver` in `src/index.ts`). Layer `extensions`.

## Testing

```
pnpm vitest run extensions/secrets-aws
```

- `src/__tests__/resolver.test.ts`: cached second read, null on `ResourceNotFoundException`, throttling propagates, actionable `AccessDeniedException` and credential errors, `set` create/restore/retry paths, idempotent delete, prefix stripped on list, `SIGHUP` clears the cache, `dispose` removes the listener.
- `src/__tests__/localstack.test.ts`: round trip against LocalStack; skipped unless `LOCALSTACK_ENDPOINT` is set.
