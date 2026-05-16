---
title: "Write a memory backend plugin"
description: "Ship a plugin that registers a custom memory provider via registerMemoryProvider so personalities can persist memory through your backend."
kind: how-to
audience: developer
slug: write-a-memory-backend-plugin
time: "15 min"
updated: 2026-05-14
---

## Task

Create a plugin that registers a custom [memory provider](../../getting-started/glossary.md#memory-provider) into the memory provider registry. Once installed, set `memory: <your-plugin-id>/<name>` in `~/.ethos/config.yaml` to route all memory reads and writes through your backend.

## Result

`prefetch()` runs at session start and injects your stored memory into the system prompt. `sync()` runs after each turn and persists the agent's memory updates. Per-personality memory routing resolves your provider by name from the registry. The 5-method contract (`prefetch`, `read`, `search`, `sync`, `list`) stays frozen; your implementation slots in without any core changes.

## Prereqs

- TypeScript familiarity, Node 24+, pnpm on `PATH`.
- A backend ready to talk to (Mem0, Letta, Zep, Redis, a custom API).
- Understanding of the `MemoryProvider` interface (5 methods in `packages/types/src/memory.ts`).

## Steps

### 1. Scaffold the plugin

```json title="package.json"
{
  "name": "ethos-plugin-mem0",
  "version": "1.0.0",
  "description": "Mem0 memory backend for Ethos",
  "main": "src/index.ts",
  "ethos": {
    "type": "plugin",
    "pluginContractMajor": 2
  },
  "dependencies": {
    "@ethosagent/types": "workspace:*"
  }
}
```

### 2. Implement MemoryProvider

The 5-method contract:

```ts title="src/mem0-provider.ts"
import type {
  MemoryContext,
  MemoryEntryRef,
  MemoryProvider,
  MemoryUpdate,
} from '@ethosagent/types';

interface MemoryCtx {
  scopeId: string;
  sessionId: string;
  sessionKey: string;
  platform: string;
  workingDir: string;
}

export class Mem0Provider implements MemoryProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async prefetch(ctx: MemoryCtx): Promise<{ content: string; keys: string[] } | null> {
    const memories = await this.fetchMemories(ctx.scopeId);
    if (memories.length === 0) return null;
    const content = memories.map((m) => `- ${m.text}`).join('\n');
    return { content, keys: ['MEMORY.md', 'USER.md'] };
  }

  async read(key: string, ctx: MemoryCtx): Promise<string | null> {
    const memories = await this.fetchMemories(ctx.scopeId, key);
    if (memories.length === 0) return null;
    return memories.map((m) => m.text).join('\n');
  }

  async search(query: string, ctx: MemoryCtx): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/v1/memories/search`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ query, user_id: ctx.scopeId, limit: 10 }),
    });
    const data = (await res.json()) as { results: { memory: string }[] };
    return data.results.map((r) => r.memory);
  }

  async sync(updates: MemoryUpdate[], ctx: MemoryCtx): Promise<void> {
    for (const update of updates) {
      if (update.action === 'add') {
        await fetch(`${this.baseUrl}/v1/memories`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            messages: [{ role: 'user', content: update.content }],
            user_id: ctx.scopeId,
            metadata: { key: update.key },
          }),
        });
      } else if (update.action === 'replace') {
        await this.deleteByKey(ctx.scopeId, update.key);
        await fetch(`${this.baseUrl}/v1/memories`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            messages: [{ role: 'user', content: update.content }],
            user_id: ctx.scopeId,
            metadata: { key: update.key },
          }),
        });
      }
    }
  }

  async list(ctx: MemoryCtx): Promise<MemoryEntryRef[]> {
    const memories = await this.fetchMemories(ctx.scopeId);
    const keys = new Set(memories.map((m) => m.metadata?.key ?? 'MEMORY.md'));
    return [...keys].map((key) => ({ key }));
  }

  private async fetchMemories(userId: string, key?: string) {
    const url = new URL(`${this.baseUrl}/v1/memories`);
    url.searchParams.set('user_id', userId);
    const res = await fetch(url, { headers: this.headers() });
    const data = (await res.json()) as { results: { text: string; metadata?: { key?: string } }[] };
    if (key) return data.results.filter((m) => m.metadata?.key === key);
    return data.results;
  }

  private async deleteByKey(userId: string, key: string) {
    const memories = await this.fetchMemories(userId, key);
    for (const m of memories) {
      await fetch(`${this.baseUrl}/v1/memories/${(m as { id: string }).id}`, {
        method: 'DELETE',
        headers: this.headers(),
      });
    }
  }

  private headers() {
    return { Authorization: `Token ${this.apiKey}`, 'Content-Type': 'application/json' };
  }
}
```

### 3. Register via activate

```ts title="src/index.ts"
import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import { Mem0Provider } from './mem0-provider';

export function activate(api: EthosPluginApi): void {
  api.registerMemoryProvider('mem0', async ({ secrets, logger }) => {
    const apiKey = await secrets.get('providers/mem0/apiKey');
    if (!apiKey) {
      throw new Error('Mem0 API key not found in secrets store');
    }
    logger.info('Mem0 memory provider activated');
    return new Mem0Provider(apiKey, 'https://api.mem0.ai');
  });
}
```

The registered name becomes `ethos-plugin-mem0/mem0`.

### 4. Configure

```yaml title="~/.ethos/config.yaml"
memory: ethos-plugin-mem0/mem0
```

```bash
ethos secrets set providers/mem0/apiKey <your-key>
```

### 5. Per-personality routing (optional)

A personality can override the global memory backend:

```yaml title="~/.ethos/personalities/researcher/config.yaml"
memory:
  provider: ethos-plugin-mem0/mem0
  options:
    collection: researcher
```

The `options` dict is passed as `config` to your factory.

## Verify

```bash
ethos chat -q "remember that I prefer dark mode"
ethos chat -q "what are my preferences?"
```

The second turn should recall the preference via your Mem0 backend.

## Troubleshoot

**"Memory provider X is not registered"** — The plugin did not load. Check `ethos plugins list` and ensure `ethos.pluginContractMajor: 2` is set.

**prefetch returns null but memories exist** — Your `fetchMemories` call may be scoping incorrectly. The `scopeId` is `personality:<id>` for per-personality scope or `global` for shared.

**Factory throws "API key not found"** — Run `ethos secrets set providers/mem0/apiKey <key>`. Network-only backends still need credentials even though they ignore `dataDir`.

**The drift-gate rejects your plugin** — Your `package.json` must declare `ethos.pluginContractMajor: 2`. Plugins declaring v1 (or omitting the field from older versions) are accepted; plugins declaring a future major are rejected.
