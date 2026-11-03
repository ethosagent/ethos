# @ethosagent/storage-fs

## Purpose

Implementations of the `Storage` contract from `@ethosagent/types`: `FsStorage` (real filesystem), `InMemoryStorage` (tests), and `ScopedStorage`, a decorator that enforces a read/write allowlist and a non-overridable deny floor of sensitive paths. Also holds the secrets resolvers and attachment caches that sit beside storage.

## Public surface

| Export | Kind | One line |
|---|---|---|
| `FsStorage` | class | `Storage` over `node:fs`. |
| `InMemoryStorage` | class | In-memory `Storage` for tests. |
| `ScopedStorage` | class | Allowlist-enforcing `Storage` decorator; throws `BoundaryError` outside scope. |
| `ScopedStorageScope` | type | Allowlist configuration for `ScopedStorage`. |
| `defaultAlwaysDeny` | function | The deny floor, equal to `sensitiveDenyPaths`. |
| `sensitiveDenyPaths` | function | Canonical sensitive-path manifest. |
| `ethosStateDirs` | function | State directories to deny. |
| `personalityDefinitionFloor` | function | Deny entries protecting personality definitions. |
| `withRealPaths` | function | Adds real-path forms of deny entries. |
| `realPathOfLongestExistingAncestor` | function | Resolves symlinks for paths that may not exist. |
| `foldDenyKey` | function | Case-folds a deny key. |
| `CASE_INSENSITIVE_FS` | const | Whether the host filesystem folds case. |
| `isSafePathSegment` | function | Validates one path segment. |
| `resolveScopedPath` | function | Resolves a path inside a scope root. |
| `FileSecretsResolver` | class | File-backed `SecretsResolver`. |
| `EnvSecretsResolver` | class | Environment-backed `SecretsResolver`. |
| `MergedSecretsResolver` | class | Combines resolvers. |
| `InMemorySecretsResolver` | class | In-memory `SecretsResolver` for tests. |
| `PersonalityScopedSecrets` | class | Restricts secrets to a personality. |
| `FsAttachmentCache` | class | Filesystem `AttachmentCache`. |
| `InMemoryAttachmentCache` | class | In-memory `AttachmentCache`. |

Plus a few more env-secret helpers, see `src/index.ts`.

## Seam

Implements `Storage` and `AttachmentCache` from `@ethosagent/types`; guards Law 7 (ARCHITECTURE.md, "Storage abstraction guards the personality boundary"). Archcheck layer `security-kernel` (rule `kernel-reads-contracts`: may import contracts and vendored shims only). Library code must receive an injected `Storage` rather than constructing `FsStorage` (archcheck rule `p24-no-fsstorage-in-libraries`).

## Testing

```
pnpm vitest run packages/storage-fs
```

- `src/__tests__/storage-conformance.test.ts` and `src/__tests__/conformance.test.ts`: `Storage` behaviour shared across backends, including atomic writes and `BoundaryError`.
- `src/__tests__/deny-manifest-parity.test.ts`: `defaultAlwaysDeny()` equals `sensitiveDenyPaths()`.
- `src/__tests__/state-dir-deny.test.ts` and `src/__tests__/scoped-storage-casefold-statedir.test.ts`: state directories stay denied, including under case folding.
- `src/__tests__/scoped-storage.test.ts`: allowlist enforcement.
- `src/__tests__/secrets.test.ts`, `env-secrets.test.ts`, `merged-secrets.test.ts`, `personality-scoped-secrets.test.ts`: secrets resolvers.
- `src/__tests__/attachment-cache.test.ts`: attachment caches.
