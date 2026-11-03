# @ethosagent/memory-vault

## Purpose

`MemoryProvider` that stores memory as plain markdown inside a user-supplied folder, typically an Obsidian vault. Everything the agent owns sits under one subtree of the vault (default `Ethos`); the rest of the vault is readable for search. Semantic search is left to the vector backend.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`).

| Export | Kind | One line |
|---|---|---|
| `VaultMemoryProvider` | class | Five-method `MemoryProvider` over the vault: prefetch, sync, list, search, global entries. |
| `VaultMemoryConfig` | interface | `vaultRoot`, `agentDir`, `prefetchKeys`, `exclude`, `storage`, `logger`. |

## Seam

Implements `MemoryProvider` from `@ethosagent/types` (`implements MemoryProvider` in `src/index.ts`). Takes a `Storage` instance and does no raw file I/O of its own beyond path handling. Contract rules in `.claude/rules/memory.md` and `.claude/rules/memory-tools.md`. Archcheck layer: `extensions`.

Pinned by `src/__tests__/vault.test.ts`: writes outside the agent subtree are refused while vault notes outside it stay readable for search; Obsidian conflict files and dot files are skipped; a concurrent editor's change is not clobbered on `replace` sync, and additive updates append onto the concurrent content.

## Testing

```
pnpm vitest run extensions/memory-vault
```

Pinning test: `src/__tests__/vault.test.ts` holds the five-method contract, `ScopedStorage` confinement, global entries at the agent-subtree root, and the stale-write guard.
