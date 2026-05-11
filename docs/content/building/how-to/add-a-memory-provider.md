---
title: "Add a memory provider"
description: "Implement MemoryProvider against the prefetch/sync contract and wire it via @ethosagent/wiring so the agent uses your backend."
kind: how-to
audience: developer
slug: add-a-memory-provider
time: "15 min"
updated: 2026-05-12
---

## Task

Implement the [MemoryProvider](../../getting-started/glossary.md#memory-provider) interface against a backend of your choice — Postgres, a vector store, a remote API — and wire it in so it replaces `MarkdownFileMemoryProvider` in `~/.ethos/`.

## Result

`prefetch()` runs at the start of every [turn](../../getting-started/glossary.md#turn) and injects your memory into the system prompt; `sync()` runs after the turn and persists the `MemoryUpdate[]` the LLM emitted. Switching `~/.ethos/config.yaml` between `memory: markdown` and `memory: <your-id>` flips backends without code changes elsewhere.

## Prereqs

- TypeScript familiarity, Node 24+, pnpm on `PATH`.
- A backend ready to talk to — a Postgres database, a vector store, an API endpoint. The interface is backend-agnostic.
- Workspace access to `@ethosagent/types` (`workspace:*` inside the monorepo, or the published `@ethosagent/types` from npm). The provider has zero other dependencies on Ethos.

## Steps

### 1. Read the interface

`MemoryProvider` is two methods. Both receive a `MemoryLoadContext` describing the active [session](../../getting-started/glossary.md#session) and [personality](../../getting-started/glossary.md#personality); `sync` also takes the `MemoryUpdate[]` the agent decided to apply.

```ts title="packages/types/src/memory.ts"
export interface MemoryProvider {
  prefetch(ctx: MemoryLoadContext): Promise<MemoryContext | null>;
  sync(ctx: MemoryLoadContext, updates: MemoryUpdate[]): Promise<void>;
}

export interface MemoryLoadContext {
  sessionId: string;
  sessionKey: string;
  userId?: string;
  platform: string;
  personalityId?: string;
  memoryScope?: 'global' | 'per-personality';
  /** Current user message — used by VectorMemoryProvider for semantic retrieval. */
  query?: string;
}

export interface MemoryContext {
  content: string;
  source: 'markdown' | 'vector' | 'honcho' | 'custom';
  truncated: boolean;
}

export type MemoryStore = 'memory' | 'user';

export interface MemoryUpdate {
  store: MemoryStore;
  action: 'add' | 'replace' | 'remove';
  content: string;
  /** Required when action === 'remove'. */
  substringMatch?: string;
}
```

Three rules are non-negotiable:

- `prefetch` returns `null` when there is nothing to inject. Do not return an empty string — the system prompt builder will render an empty section.
- `sync` may be called with an empty array. Return early; do not write.
- `'memory'` and `'user'` are separate stores. `'memory'` is the rolling project context; `'user'` is who the human is. Apply each update against the right backing row.

### 2. Implement the provider

The implementation below is a Postgres provider. It scopes the `'memory'` store by [memory scope](../../getting-started/glossary.md#memory-scope) (per-personality vs global) and always stores `'user'` content on a single shared row keyed by `userId` or the session id.

```ts title="src/postgres-memory.ts"
import type {
  MemoryContext,
  MemoryLoadContext,
  MemoryProvider,
  MemoryStore,
  MemoryUpdate,
} from '@ethosagent/types';
import { Pool } from 'pg';

export class PostgresMemoryProvider implements MemoryProvider {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async prefetch(ctx: MemoryLoadContext): Promise<MemoryContext | null> {
    const userContent = (await this.read(this.userKey(ctx), 'user')).trim();
    const memoryContent = (await this.read(this.memoryKey(ctx), 'memory')).trim();
    const parts: string[] = [];
    if (userContent) parts.push(`## About You\n\n${userContent}`);
    if (memoryContent) parts.push(`## Memory\n\n${memoryContent}`);
    if (parts.length === 0) return null;
    return { content: parts.join('\n\n'), source: 'custom', truncated: false };
  }

  async sync(ctx: MemoryLoadContext, updates: MemoryUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    for (const update of updates) {
      const key = update.store === 'memory' ? this.memoryKey(ctx) : this.userKey(ctx);
      const next = applyUpdate(await this.read(key, update.store), update).trim();
      if (!next) {
        await this.pool.query('DELETE FROM memory_rows WHERE key = $1 AND store = $2', [
          key,
          update.store,
        ]);
        continue;
      }
      await this.pool.query(
        `INSERT INTO memory_rows (key, store, content, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key, store) DO UPDATE
           SET content = EXCLUDED.content, updated_at = NOW()`,
        [key, update.store, next],
      );
    }
  }

  private async read(key: string, store: MemoryStore): Promise<string> {
    const res = await this.pool.query(
      'SELECT content FROM memory_rows WHERE key = $1 AND store = $2',
      [key, store],
    );
    return res.rows[0]?.content ?? '';
  }

  /** Per-personality scope routes 'memory' through the personality id. */
  private memoryKey(ctx: MemoryLoadContext): string {
    if (ctx.memoryScope === 'per-personality' && ctx.personalityId) {
      return `${ctx.sessionKey}:${ctx.personalityId}`;
    }
    return ctx.sessionKey;
  }

  /** 'user' is always shared — it describes the human, not the personality. */
  private userKey(ctx: MemoryLoadContext): string {
    return ctx.userId ?? ctx.sessionKey;
  }
}

function applyUpdate(current: string, update: MemoryUpdate): string {
  switch (update.action) {
    case 'add':
      return current ? `${current.trimEnd()}\n\n${update.content.trim()}` : update.content.trim();
    case 'replace':
      return update.content.trim();
    case 'remove': {
      const needle = update.substringMatch;
      if (!needle) return current;
      return current
        .split('\n')
        .filter((line) => !line.includes(needle))
        .join('\n');
    }
  }
}
```

The table is one row per `(key, store)`. Migrate it with:

```sql
CREATE TABLE memory_rows (
  key TEXT NOT NULL,
  store TEXT NOT NULL CHECK (store IN ('memory', 'user')),
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key, store)
);
```

### 3. Wire it into the agent

`packages/wiring/src/index.ts` selects the memory provider based on `config.memory`. To plug in a custom provider without modifying the wiring package, instantiate `AgentLoop` directly:

```ts title="apps/ethos/src/wiring.ts"
import { AgentLoop } from '@ethosagent/core';
import { PostgresMemoryProvider } from './postgres-memory';

const memory = new PostgresMemoryProvider(process.env.ETHOS_PG_URL ?? '');

const loop = new AgentLoop({ llm, tools, hooks, session, personalities, memory });
```

For a packaged path, ship the provider inside a plugin and instantiate it in `activate()`. See [Publish a plugin](publish-a-plugin.md) for the activation contract.

### 4. Cover the contract with tests

A provider that violates the `prefetch returns null when empty` rule silently pollutes every system prompt with an empty memory block. Pin both branches.

```ts title="src/__tests__/postgres-memory.test.ts"
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresMemoryProvider } from '../postgres-memory';

const ctx = { sessionId: 's1', sessionKey: 'cli:test', platform: 'cli' } as const;
const provider = new PostgresMemoryProvider(process.env.TEST_PG_URL ?? '');

describe('PostgresMemoryProvider', () => {
  beforeEach(() => provider['pool'].query('TRUNCATE memory_rows'));
  afterAll(() => provider['pool'].end());

  it('returns null when both stores are empty', async () => {
    expect(await provider.prefetch(ctx)).toBeNull();
  });

  it('round-trips an add then a remove', async () => {
    await provider.sync(ctx, [{ store: 'memory', action: 'add', content: 'first fact' }]);
    expect((await provider.prefetch(ctx))?.content).toContain('first fact');
    await provider.sync(ctx, [
      { store: 'memory', action: 'remove', content: '', substringMatch: 'first' },
    ]);
    expect(await provider.prefetch(ctx)).toBeNull();
  });
});
```

## Verify

Boot the agent against the provider and confirm the memory section flows through two turns.

```bash
export ETHOS_PG_URL="postgres://localhost/ethos_dev"
ethos chat -q "remember that the project deadline is friday"
ethos chat -q "what's the project deadline?"
```

If the second turn answers correctly, `prefetch` is reading what `sync` wrote. Inspect the row directly:

```bash
psql "$ETHOS_PG_URL" -c "SELECT key, store, length(content) FROM memory_rows"
```

## Troubleshoot

**Agent never remembers anything across turns.** — `sync` is being called but writing nothing. Log the `updates` array; if it's empty, the LLM did not produce updates this turn. If it's non-empty but the row stays empty, your `applyUpdate` collapsed the content — check the `'add'` branch.

**Every turn appends an empty `## Memory` block to the prompt.** — `prefetch` is returning `{ content: '', ... }` instead of `null`. Add the empty-check before constructing the result.

**`per-personality` writes leak into the global pool.** — The provider is ignoring `ctx.memoryScope`. Route `'memory'` writes through `memoryKey()` (or its equivalent in your backend), not `sessionKey` alone. `'user'` always stays global.

**`'remove'` does nothing.** — `substringMatch` is `undefined`. The contract is `substringMatch`, not `content` — see `packages/types/src/memory.ts`.

**`prefetch` is the slow path of every turn.** — It runs before the LLM call on the critical path. Cache hot rows in memory keyed by `(memoryKey, userKey)`; invalidate on `sync`. Index `memory_rows(key, store)`.
