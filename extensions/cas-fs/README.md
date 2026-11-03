# @ethosagent/cas-fs

## Purpose

Filesystem-backed content-addressed store. It hashes a string with SHA-256 and keeps the raw utf-8 bytes at `<root>/<first two hex>/<remaining 62>`, writing through `Storage.writeAtomic`. The caller supplies the absolute `root` and the `Storage`; this package decides nothing about where the store lives or what gets stored in it.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`).

| Export | Kind | One line |
|---|---|---|
| `FsContentStore` | class | `ContentStore` over a `Storage`; methods `put`, `get`, `has`, `hash`. |

## Seam

Implements `ContentStore` from `@ethosagent/types` (`packages/types/src/content-store.ts`; ARCHITECTURE.md lists its method count as a frozen contract). Archcheck layer: `extensions`.

Behaviours pinned by `src/__tests__/cas-fs.test.ts`: `put` is idempotent for identical content, `hash` does no I/O, and `get` and `has` return `null` and `false` for malformed hashes instead of throwing.

## Testing

```
pnpm vitest run extensions/cas-fs
```

Pinning tests: `src/__tests__/cas-fs.test.ts` holds the round trip, `has` after `put`, idempotent `put`, malformed-hash handling and cross-session deduplication into one blob.
