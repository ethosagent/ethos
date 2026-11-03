---
title: "Add a memory provider: implement the provider"
description: "Write a Postgres-backed MemoryProvider with prefetch, read, search, sync and list."
kind: how-to
audience: developer
time: "8 min"
updated: 2026-11-03
---

## Task

Implement the five `MemoryProvider` methods against Postgres, keyed by `(scope_id, key)`.

## Result

`src/postgres-memory.ts` exports `PostgresMemoryProvider`, which returns `null` from `prefetch` when a scope is empty and throws on a scope id Ethos never issues.

## Prereqs

- Complete [part 1](../add-a-memory-provider.md) (read the interface and the three rules).
- A Postgres database you can reach, and the `pg` package installed in your plugin.

## Steps

### 2. Implement the provider

The implementation below keeps one row per `(scope_id, key)` in Postgres.

```ts title="src/postgres-memory.ts"
import type {
  ListOpts,
  MemoryContext,
  MemoryEntry,
  MemoryEntryRef,
  MemoryProvider,
  MemorySnapshot,
  MemoryUpdate,
  SearchOpts,
} from '@ethosagent/types';
import { Pool } from 'pg';

const PREFETCH_KEYS = ['MEMORY.md', 'USER.md'];

export class PostgresMemoryProvider implements MemoryProvider {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async prefetch(ctx: MemoryContext): Promise<MemorySnapshot | null> {
    const res = await this.pool.query<{ key: string; content: string }>(
      'SELECT key, content FROM memory_rows WHERE scope_id = $1 AND key = ANY($2)',
      [assertScope(ctx.scopeId), PREFETCH_KEYS],
    );
    const entries = PREFETCH_KEYS.flatMap((key) => {
      const content = res.rows.find((row) => row.key === key)?.content ?? '';
      return content.trim() ? [{ key, content }] : [];
    });
    return entries.length > 0 ? { entries } : null;
  }

  async read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null> {
    const res = await this.pool.query<{ content: string; updated_at: Date }>(
      'SELECT content, updated_at FROM memory_rows WHERE scope_id = $1 AND key = $2',
      [assertScope(ctx.scopeId), key],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { key, content: row.content, metadata: { lastUpdatedAt: row.updated_at.getTime() } };
  }

  async search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]> {
    const res = await this.pool.query<{ key: string; content: string }>(
      `SELECT key, content FROM memory_rows
       WHERE scope_id = $1 AND content ILIKE '%' || $2 || '%'
       ORDER BY updated_at DESC LIMIT $3`,
      [assertScope(ctx.scopeId), query, opts?.limit ?? 10],
    );
    return res.rows.map((row) => ({ key: row.key, content: row.content }));
  }

  async sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    if (updates.length === 0) return;
    const scopeId = assertScope(ctx.scopeId);
    for (const update of updates) {
      if (update.action === 'delete') {
        await this.pool.query('DELETE FROM memory_rows WHERE scope_id = $1 AND key = $2', [
          scopeId,
          update.key,
        ]);
        continue;
      }
      const current = (await this.read(update.key, ctx))?.content ?? '';
      await this.pool.query(
        `INSERT INTO memory_rows (scope_id, key, content, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (scope_id, key) DO UPDATE
           SET content = EXCLUDED.content, updated_at = NOW()`,
        [scopeId, update.key, applyUpdate(current, update)],
      );
    }
  }

  async list(ctx: MemoryContext, opts?: ListOpts): Promise<MemoryEntryRef[]> {
    const res = await this.pool.query<{ key: string; updated_at: Date }>(
      'SELECT key, updated_at FROM memory_rows WHERE scope_id = $1 ORDER BY key LIMIT $2',
      [assertScope(ctx.scopeId), opts?.limit ?? 1000],
    );
    return res.rows.map((row) => ({
      key: row.key,
      metadata: { lastUpdatedAt: row.updated_at.getTime() },
    }));
  }
}

/** Refuse anything but the three prefixes Ethos issues, as the built-in backends do. */
function assertScope(scopeId: string): string {
  if (/^(personality|user|team):[A-Za-z0-9_-]+$/.test(scopeId)) return scopeId;
  throw new Error(`unrecognised memory scope: ${scopeId}`);
}

function applyUpdate(current: string, update: Exclude<MemoryUpdate, { action: 'delete' }>): string {
  switch (update.action) {
    case 'add':
      return current ? `${current.trimEnd()}\n${update.content}` : update.content;
    case 'replace':
      return update.content;
    case 'remove':
      return current
        .split('\n')
        .filter((line) => !line.includes(update.substringMatch))
        .join('\n');
  }
}
```

Create the table:

```sql
CREATE TABLE memory_rows (
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_id, key)
);
```

## Verify

If your plugin has a `tsconfig.json` and `typescript` installed, type-check it.

```bash
pnpm exec tsc --noEmit
```

A clean run prints nothing and exits 0. Round-trip behaviour is pinned by the tests in [part 3](register-and-test.md#5-cover-the-contract-with-tests).

## Troubleshoot

**Every turn appends an empty memory block to the prompt.** — `prefetch` is returning `{ entries: [] }` instead of `null`. Return `null` when nothing is non-empty.

**`unrecognised memory scope: global`.** — A tool ran without a `memoryScopeId` on its context and fell back to the scope id `global` (`buildMemoryContext`, `extensions/tools-memory/src/index.ts`). That is a wiring bug upstream; do not map `global` to a row.

**`'remove'` does nothing.** — The update carries `substringMatch`, not `content`. Filter on `update.substringMatch`.

**`prefetch` is the slow path of every turn.** — It runs before the LLM call. Index `memory_rows (scope_id, key)` (the primary key above does) and cache hot scopes, invalidated in `sync`.
