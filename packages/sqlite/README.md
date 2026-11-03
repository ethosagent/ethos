# @ethosagent/sqlite

## Purpose

A synchronous shim over Node 24's built-in `node:sqlite` (`DatabaseSync`) that gives callers a `prepare`/`run`/`get`/`all` style API with number-typed `changes` and `lastInsertRowid`, plus `backup()` and a versioned `migrate()` helper. It has no native dependencies and carries no Ethos semantics.

## Public surface

| Export | Kind | One line |
|---|---|---|
| `default` (`Database`) | class | Database handle; `new Database(path, { readonly })`. |
| `backup` | function | Copies a database to a destination path; resolves to a number. |
| `migrate` | function | Runs an ordered migration chain tracked by `user_version`. |
| `MigrationConfig` | interface | Target version and steps for `migrate`. |
| `BackupOptions` | type | Re-exported from `node:sqlite`. |
| `BackupProgressInfo` | type | Re-exported from `node:sqlite`. |

## Seam

Archcheck layer `vendored`: the shim may import only contracts (archcheck rule `vendored-shim` in `architecture.config.ts`). Durability and STRICT/FTS5 conventions for callers are in `.claude/rules/sqlite-durability.md` and `.claude/rules/sqlite-gotchas.md`.

## Testing

```
pnpm vitest run packages/sqlite
```

- `src/__tests__/database.test.ts`: open, read-only mode, `run`/`get`/`all` result shapes, multi-statement `exec`, `backup`.
- `src/__tests__/migrate.test.ts`: fresh DB is stamped to the target version, a DB newer than the code is refused with `IMPORT_NEWER_SCHEMA`, steps run in order, a failing step rolls back atomically, re-running is idempotent.
