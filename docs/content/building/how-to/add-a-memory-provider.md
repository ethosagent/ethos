---
title: "Add a memory provider"
description: "Implement the five-method MemoryProvider contract against your own backend, register it from a plugin, and select it per personality with memory.provider."
kind: how-to
audience: developer
slug: add-a-memory-provider
time: "15 min"
updated: 2026-09-13
---

## Task

Implement the [MemoryProvider](../../getting-started/glossary.md#memory-provider) interface against a backend of your choice — Postgres, a vector store, a remote API — register it from a plugin, and point a [personality](../../getting-started/glossary.md#personality) at it.

## Result

At the start of every [turn](../../getting-started/glossary.md#turn) for that personality, `prefetch()` reads your backend and the entries land in the system prompt. A personality whose `config.yaml` does not name your provider keeps the deployment backend.

## Prereqs

- TypeScript familiarity, Node 24+, pnpm on `PATH`.
- A backend ready to talk to — a Postgres database, a vector store, an API endpoint. The interface is backend-agnostic.
- `@ethosagent/types` and `@ethosagent/plugin-sdk` (`workspace:*` inside the monorepo, or the published packages from npm).

## Steps

### 1. Read the interface

`MemoryProvider` is five methods, and every one receives a `MemoryContext`. The drift gate `packages/types/src/__tests__/memory-method-count.test.ts` fails if a sixth appears.

```ts title="packages/types/src/memory.ts"
export interface MemoryContext {
  /** Opaque scope id. Conventional prefixes: `personality:<id>`, `team:<id>`. */
  scopeId: string;
  sessionId: string;
  sessionKey: string;
  platform: string;
  workingDir: string;
}

export interface MemorySnapshot {
  entries: Array<{ key: string; content: string }>;
}

export type MemoryUpdate =
  | { action: 'add'; key: string; content: string }
  | { action: 'replace'; key: string; content: string }
  | { action: 'remove'; key: string; substringMatch: string }
  | { action: 'delete'; key: string };

export interface MemoryProvider {
  prefetch(ctx: MemoryContext): Promise<MemorySnapshot | null>;
  read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null>;
  search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]>;
  sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void>;
  list(ctx: MemoryContext, opts?: ListOpts): Promise<MemoryEntryRef[]>;
}
```

The provider never decides whose memory it is reading. Ethos issues the scope id, and your backend partitions by it:

| `scopeId` | Issued by | Keys you will see |
|---|---|---|
| `personality:<id>` | Turn setup, for every turn (`memScopeId` in `packages/core/src/agent-loop/stages/turn-setup.ts`). There is no setting that changes it | `MEMORY.md`, `USER.md`, arbitrary keys via `memory_read { key }` |
| `user:<userId>` | Context assembly, when the turn carries a user id — a gateway sender its identity map resolved (`context-assembly.ts`) | `USER.md` |
| `team:<id>` | The `team_memory_*` tools only | One key per topic |

Three rules are non-negotiable:

- `prefetch` returns `null` when there is nothing to inject. An empty `entries` array renders an empty memory section.
- `sync` may be called with an empty array. Return early; do not write.
- A scope id you do not recognise is an error. The built-in backends throw `unrecognised memory scope` (`resolveScopeDir` in `extensions/memory-markdown/src/index.ts`); a provider that quietly maps it to a shared row leaks memory across personalities.

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

### 3. Register it from a plugin

`registerMemoryProvider` qualifies a bare name with your plugin id, so `postgres` registers as `<plugin-id>/postgres` (`EthosPluginApi.registerMemoryProvider`, `packages/plugin-sdk/src/index.ts`). The factory receives the personality's `memory.options.*` values as `config`.

```ts title="src/index.ts"
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { PostgresMemoryProvider } from './postgres-memory';

export function activate(api: EthosPluginApi): void {
  api.registerMemoryProvider('postgres', ({ config }) => {
    const url = typeof config.connectionString === 'string' ? config.connectionString : '';
    return new PostgresMemoryProvider(url || process.env.ETHOS_PG_URL || '');
  });
}

const plugin: EthosPlugin = { activate };
export default plugin;
```

Install the plugin as described in [Publish a plugin](publish-a-plugin.md). Wiring runs `loadPlugins` before it builds the agent loop, so the provider is in the registry when the loop maps provider names (`packages/wiring/src/index.ts`, `build-agent-loop.ts`).

### 4. Select it on a personality

Add two keys to the personality's `config.yaml`:

```yaml title="~/.ethos/personalities/researcher/config.yaml"
memory.provider: <plugin-id>/postgres
memory.options.connectionString: postgres://localhost/ethos_dev
```

Know what this switches. Context assembly resolves `personality.memory.provider` for the turn-start `prefetch` and its `search` fallback, and nothing else (`packages/core/src/agent-loop/stages/context-assembly.ts`). The `memory_read` and `memory_write` tools stay bound to the deployment backend (`createMemoryTools(memory, session)` in `packages/wiring/src/build-agent-loop.ts`), and the deployment-wide `memory:` key in `~/.ethos/config.yaml` accepts only `markdown`, `vector` or `vault` (`packages/config/src/index.ts`). Your backend therefore feeds the prompt; writes the agent makes mid-turn still land in the deployment store. Populate your rows from your own pipeline, or treat this as a read path.

### 5. Cover the contract with tests

A provider that violates the "`prefetch` returns null when empty" rule silently adds an empty memory block to every system prompt. Pin that, a round trip, and the scope refusal.

```ts title="src/__tests__/postgres-memory.test.ts"
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresMemoryProvider } from '../postgres-memory';

const ctx = {
  scopeId: 'personality:researcher',
  sessionId: 's1',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
};
const provider = new PostgresMemoryProvider(process.env.TEST_PG_URL ?? '');

describe('PostgresMemoryProvider', () => {
  beforeEach(async () => {
    await provider.pool.query('TRUNCATE memory_rows');
  });
  afterAll(() => provider.pool.end());

  it('returns null when the scope is empty', async () => {
    expect(await provider.prefetch(ctx)).toBeNull();
  });

  it('round-trips an add then a remove', async () => {
    await provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'first fact' }], ctx);
    expect((await provider.prefetch(ctx))?.entries[0]?.content).toContain('first fact');
    await provider.sync([{ action: 'remove', key: 'MEMORY.md', substringMatch: 'first' }], ctx);
    expect(await provider.prefetch(ctx)).toBeNull();
  });

  it('refuses a scope id Ethos never issues', async () => {
    await expect(provider.prefetch({ ...ctx, scopeId: 'global' })).rejects.toThrow(
      'unrecognised memory scope',
    );
  });
});
```

## Verify

Seed a row for the personality, then ask it something only that row answers.

```bash
psql "$ETHOS_PG_URL" -c "INSERT INTO memory_rows (scope_id, key, content) VALUES ('personality:researcher', 'MEMORY.md', 'The project deadline is Friday.')"
```

```
INSERT 0 1
```

```bash
ethos -z "what is the project deadline?" --personality researcher
```

```
The project deadline is Friday.
```

A correct answer means `prefetch` read your row into the prompt. [Zero mode](../../getting-started/glossary.md#zero-mode) runs one turn and exits, so nothing else touched the store.

## Troubleshoot

**The agent never sees your rows.** — `memory.provider` names something the registry does not hold, and context assembly falls back to the deployment backend without an error (`?? deps.memory` in `context-assembly.ts`). Check the qualified name is `<plugin-id>/postgres` and that the plugin activated.

**`memory_write` writes do not appear in Postgres.** — Expected. The memory tools use the deployment backend, not the personality's `memory.provider` (step 4).

**Every turn appends an empty memory block to the prompt.** — `prefetch` is returning `{ entries: [] }` instead of `null`. Return `null` when nothing is non-empty.

**`unrecognised memory scope: global`.** — A tool ran without a `memoryScopeId` on its context and fell back to the scope id `global` (`buildMemoryContext`, `extensions/tools-memory/src/index.ts`). That is a wiring bug upstream; do not map `global` to a row.

**`'remove'` does nothing.** — The update carries `substringMatch`, not `content`. Filter on `update.substringMatch`.

**`prefetch` is the slow path of every turn.** — It runs before the LLM call. Index `memory_rows (scope_id, key)` (the primary key above does) and cache hot scopes, invalidated in `sync`.
