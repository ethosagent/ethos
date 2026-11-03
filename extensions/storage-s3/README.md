# @ethosagent/storage-s3

## Purpose

S3-backed `Storage`. `S3Storage` maps absolute paths to object keys under an optional prefix and reconciles object-store semantics with the `Storage` contract; `createS3Storage` builds one from the `storage` config block, resolving static credentials through a `SecretsResolver` or falling back to the SDK default chain. Which backend a deployment uses is decided by wiring.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `S3Storage` | class | `Storage` over `@aws-sdk/client-s3`; constructor takes `{ client, bucket, prefix? }`. |
| `createS3Storage` | function | Builds an `S3Storage` from config and a `SecretsResolver`. |

Object-store differences, documented in `src/index.ts`: `mkdir` and `chmod` are no-ops, `writeAtomic` equals `write`, and `append` is a read-modify-write. Missing objects read as `null`. `createS3Storage` throws when `storage.s3.bucket` is not set.

## Seam

Implements `Storage` from `@ethosagent/types` (`implements` on `S3Storage` in `src/index.ts`). Layer `extensions`. Consumes `SecretsResolver` and `SecretRef` from the same package for credentials. The test file runs the shared conformance expectations (null on missing, `BoundaryError` passes through a `ScopedStorage` wrapper) against a mocked client.

## Testing

```
pnpm vitest run extensions/storage-s3
```

`src/__tests__/storage-s3.test.ts` holds, against `aws-sdk-client-mock`: conformance (`writeAtomic` read-back, null for missing `read`, `exists` and `mtime`, `chmod` does not throw, `BoundaryError` passthrough), object-store semantics (binary round trip, `mtime` from `LastModified`, `list` and `listEntries` with prefix and delimiter, recursive remove, `append` creates a missing object, `rename` moves a subtree). A real-bucket block is skipped unless `ETHOS_S3_TEST_BUCKET` is set.
