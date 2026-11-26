# @ethosagent/share-links

## Purpose

SQLite store behind shareable read-only conversation links. A link is a 256-bit random token in a URL, backed by a frozen, already-redacted snapshot of one session. The operator can revoke it or let it expire, and either one deletes the snapshot. The store keeps no plaintext token, so a leaked database does not leak live URLs. Building the snapshot (redaction, role filter) lives in `packages/wiring/src/share-snapshot.ts`; serving the page and the RPC live in `apps/web-api`.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`). `packages/wiring` re-exports all of it, so apps import from `@ethosagent/wiring`.

| Export | Kind | One line |
|---|---|---|
| `SqliteShareLinkStore` | class | Opened on a database path. `create`, `findLive`, `recordView`, `list`, `revoke`, `revokeForSession`, `purgeExpired`, `listEvents`, `close`. |
| `hashShareToken` | function | `sha256(token)` as hex. The page handler hashes the URL token and calls `findLive`. |
| `MAX_SNAPSHOT_BYTES` | const | 2 MiB cap on the serialized snapshot. |
| `SnapshotTooLargeError` | class | Thrown by `create` over the cap; carries `limitBytes`. |
| `AmbiguousSharePrefixError` | class | Thrown by `revoke` when a prefix matches more than one live link (revoked twins do not count). |
| `SharePrefixTooShortError`, `MIN_PREFIX_LENGTH` | class, const | `revoke` refuses a prefix under 4 characters; an exact id is always accepted. |
| `CreateShareLinkInput`, `CreateShareLinkResult` | interface | Input to `create`, and the result carrying the token (returned once). |
| `ShareLinkSummary`, `ShareLinkRecord` | interface | List row without the snapshot; full row with it. |
| `ShareLinkEvent`, `ShareLinkEventKind` | interface, type | Audit row; kind is `created`, `revoked` or `purged`. |
| `ShareLinkStoreOptions` | interface | Optional clock for tests. |

## Seam

The store is a plain class with no interface above it; callers will be `ShareService` in `apps/web-api` and the `ethos sessions share` CLI, not yet written (plan `plan/phases/share-links.md` §3). Archcheck layer: `extensions`. The only raw `node:fs` use is the `mkdirSync` of the database parent directory, the same carve-out as the other SQLite stores. The database is `<dataDir>/share-links.db`.

Guarantees and what pins them, all in `src/__tests__/share-link-store.test.ts`:

- Only the hash is stored: `stores the sha256 hash, never the token, in any column`.
- Tokens are 43 base64url characters: `generates a 32-byte base64url token (43 chars)`.
- Revoke deletes the snapshot and appends the event in one transaction: `revoke purges the snapshot and appends a revoked event in one transaction` and `rolls the snapshot null-out back if the event insert fails`.
- A revoked or expired row is never served: `misses a revoked row`, `misses an expired row, including at the exact expiry instant`.
- Snapshots over 2 MiB are refused, counted in bytes: `refuses a snapshot over 2 MB with a typed error naming the limit`, `measures the cap in bytes, not characters`.
- The audit log is append-only: `exposes no update or delete method for events`.
- Both tables are STRICT and the file runs at `synchronous = FULL`, so a power cut cannot undo a revoke: `declares both tables STRICT`, `stays at synchronous = FULL in WAL mode` (`.claude/rules/sqlite-durability.md`).

Fenced off elsewhere: `share-links.db` is excluded from backups (`packages/wiring/src/backup/__tests__/scopes.test.ts`) and denied to agent file tools (`packages/storage-fs/src/__tests__/state-dir-deny.test.ts`, `extensions/tools-file/src/__tests__/blocked-paths.test.ts`).

Limitation: a shell tool on local execution can still write the database file; the deny lists cover the file tools only.

## Testing

```
pnpm vitest run extensions/share-links
```

Pinning test: `src/__tests__/share-link-store.test.ts` covers create, `findLive`, revoke by id and prefix, `purgeExpired`, `recordView`, list ordering, append-only events and the durability posture.
