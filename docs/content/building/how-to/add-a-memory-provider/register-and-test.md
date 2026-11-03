---
title: "Add a memory provider: register, select and test"
description: "Register a MemoryProvider from a plugin, select it per personality, and test it."
kind: how-to
audience: developer
time: "7 min"
updated: 2026-11-03
---

## Task

Register `PostgresMemoryProvider` from a plugin, select it in a personality's `config.yaml`, and pin its contract with tests.

## Result

A personality with `memory.provider: <plugin-id>/postgres` reads your rows at the start of every turn, and the vitest suite passes.

## Prereqs

- Complete [part 2](implement.md): `src/postgres-memory.ts` exists.
- A plugin package with an `activate` entry point.

## Steps

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

Install the plugin as described in [Publish a plugin](../publish-a-plugin.md). Wiring runs `loadPlugins` before it builds the agent loop, so the provider is in the registry when the loop maps provider names (`packages/wiring/src/index.ts`, `build-agent-loop.ts`).

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

A correct answer means `prefetch` read your row into the prompt. [Zero mode](../../../getting-started/glossary.md#zero-mode) runs one turn and exits, so nothing else touched the store.

## Troubleshoot

**The agent never sees your rows.** — `memory.provider` names something the registry does not hold, and context assembly falls back to the deployment backend without an error (`?? deps.memory` in `context-assembly.ts`). Check the qualified name is `<plugin-id>/postgres` and that the plugin activated.

**`memory_write` writes do not appear in Postgres.** — Expected. The memory tools use the deployment backend, not the personality's `memory.provider` (step 4).
