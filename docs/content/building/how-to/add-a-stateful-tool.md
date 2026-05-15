---
title: "Add a stateful tool"
description: "Declare storage capabilities, use ctx.kvStore for tool-private, session-scoped, or personality-scoped key-value persistence."
kind: how-to
audience: developer
slug: add-a-stateful-tool
updated: 2026-05-14
---

## Task

Build a [tool](../../getting-started/glossary.md#tool) that persists state across invocations using the capability framework's key-value store. The framework resolves the storage declaration into a scoped `ctx.kvStore` accessor whose namespace is determined by the declared scope.

## Result

A tool whose storage scope is declared in `capabilities.storage`. At execution time the framework provides `ctx.kvStore` with `get`, `set`, `delete`, and `list` methods. The store's namespace is derived from the declared scope -- tool-private, session, or [personality](../../getting-started/glossary.md#personality) -- so data isolation is enforced without manual key prefixing.

## Prereqs

- `@ethosagent/types` (for `Tool`, `ToolResult`, `ToolCapabilities`, `KeyValueStore`).
- A wiring layer that provides `CapabilityBackends.kvStoreFactory`. In production this is wired in `packages/wiring/src/index.ts`; in tests, supply a mock factory.

## Steps

### 1. Pick the right scope

The `storage.scope` field controls namespace isolation. Pick based on who should see the data and how long it should live.

| Scope | Namespace key | Survives sessions | Shared across tools | When to use |
|---|---|---|---|---|
| `'tool-private'` | `tool:<toolName>` | Yes | No | Caches, learned preferences, per-tool counters. Data belongs to this tool alone and persists across sessions and personalities. |
| `'session'` | `session:<sessionId>` | No | Yes (within session) | Scratch state for a multi-turn workflow. All tools in the same session share the namespace. Destroyed when the session ends. |
| `'personality'` | `personality:<personalityId>` | Yes | Yes (within personality) | Shared configuration or accumulated knowledge across tools and sessions for one personality. Falls back to `personality:<sessionId>` when no personality is active. |

### 2. Declare the capability

A tool that tracks how many times the user has asked a question:

```ts title="src/counter-tool.ts"
import type { Tool, ToolResult } from '@ethosagent/types';

export const counterTool: Tool = {
  name: 'usage_counter',
  description: 'Track per-topic usage counts across sessions.',
  toolset: 'analytics',
  capabilities: {
    storage: {
      scope: 'tool-private',
      kind: 'kv',
    },
  },
  schema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Topic to increment' },
    },
    required: ['topic'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    // ... (see step 3)
  },
};
```

`kind: 'kv'` is currently the only storage kind. The field exists for forward compatibility with future storage backends (queues, blobs).

### 3. Use ctx.kvStore for persistence

`ctx.kvStore` exposes four methods. All keys are strings; all values are strings (serialize complex data with `JSON.stringify`).

```ts
async execute(args, ctx): Promise<ToolResult> {
  const { topic } = args as { topic: string };
  if (!topic) return { ok: false, error: 'topic is required', code: 'input_invalid' };

  const kv = ctx.kvStore;
  if (!kv) {
    return { ok: false, error: 'Storage capability not configured', code: 'not_available' };
  }

  const current = await kv.get(topic);
  const count = (current ? Number.parseInt(current, 10) : 0) + 1;
  await kv.set(topic, String(count));

  return { ok: true, value: `Topic "${topic}" has been queried ${count} time(s).` };
},
```

The four methods:

| Method | Signature | Behaviour |
|---|---|---|
| `get` | `(key: string) => Promise<string \| null>` | Returns the value or `null` if the key does not exist. |
| `set` | `(key: string, value: string, opts?) => Promise<void>` | Upserts the key. Accepts an optional `{ ttlSeconds }` (see step 4). |
| `delete` | `(key: string) => Promise<void>` | Removes the key. No-op if absent. |
| `list` | `(prefix: string) => Promise<string[]>` | Returns all keys matching the prefix. Use for enumeration and cleanup. |

### 4. Use TTL for expiring entries

Pass `{ ttlSeconds }` to `set` for data that should auto-expire. The default TTL can also be set in the capability declaration via `ttlSecondsDefault`.

```ts
// Expire after 1 hour
await kv.set('rate-limit:user-42', '1', { ttlSeconds: 3600 });

// Use a default TTL for all keys written by this tool
capabilities: {
  storage: {
    scope: 'session',
    kind: 'kv',
    ttlSecondsDefault: 1800, // 30 minutes
  },
},
```

Per-call `ttlSeconds` overrides the default when both are set. Omit both for keys that should live as long as the scope itself.

### 5. Understand scope semantics

The framework resolves the scope into a namespace key at execution time. This happens inside `resolveCapabilities()` in `packages/core/src/capability-resolver.ts`:

```text
scope: 'tool-private'   -->  scopeId = 'tool:usage_counter'
scope: 'session'         -->  scopeId = 'session:sess-abc123'
scope: 'personality'     -->  scopeId = 'personality:researcher'
```

The `kvStoreFactory(toolName, scopeId)` receives both the tool name and the resolved scope id. The factory implementation decides the physical storage (SQLite, filesystem, in-memory map). Tools never see the scope id directly -- they call `kv.get('mykey')` and the factory has already partitioned the namespace.

**tool-private** data survives session restarts. A counter tool will remember counts from yesterday's session. The namespace is keyed by tool name, so renaming the tool creates a fresh partition.

**session** data is scoped to one session id. When the user runs `/new` or starts a fresh session, the old namespace is unreachable. Multiple tools in the same session share the namespace -- coordinate key names to avoid collisions (prefix with the tool name if needed).

**personality** data is scoped to the active personality id. It persists across sessions and is shared by all tools running under that personality. When no personality is active, the scope falls back to the session id. Use this for accumulated knowledge that the personality carries forward.

## Verify

Write a test with a mock factory:

```ts
import { describe, expect, it, vi } from 'vitest';
import { resolveCapabilities } from '@ethosagent/core';

const store = new Map<string, string>();
const mockKv = {
  get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
  set: vi.fn((k: string, v: string) => { store.set(k, v); return Promise.resolve(); }),
  delete: vi.fn((k: string) => { store.delete(k); return Promise.resolve(); }),
  list: vi.fn((prefix: string) =>
    Promise.resolve([...store.keys()].filter((k) => k.startsWith(prefix))),
  ),
};
const backends = { kvStoreFactory: vi.fn().mockReturnValue(mockKv) };

const result = resolveCapabilities(
  'usage_counter',
  { storage: { scope: 'tool-private', kind: 'kv' } },
  { sessionId: 'sess-1' },
  backends,
);
expect(result.kvStore).toBeDefined();
expect(backends.kvStoreFactory).toHaveBeenCalledWith('usage_counter', 'tool:usage_counter');
```

Run `pnpm check` to confirm typecheck, lint, and tests pass.

## Troubleshoot

**`ctx.kvStore` is undefined.** -- The tool declared `storage` but no `CapabilityBackends.kvStoreFactory` was provided to the registry. In production wiring, confirm the factory is passed. In tests, supply a mock.

**Data disappears between sessions.** -- The scope is `'session'`. Switch to `'tool-private'` or `'personality'` if the data should survive session boundaries.

**Two tools in the same session overwrite each other's keys.** -- Both use `scope: 'session'` and the same key names. Prefix keys with the tool name (`usage_counter:topic`) or switch to `'tool-private'` for isolated storage.

**Personality scope falls back to session id.** -- No personality is active (`ctx.personalityId` is undefined). The resolver uses `personality:<sessionId>` as the fallback. If the tool requires a real personality scope, check `ctx.personalityId` and return an error when absent.

**Renamed tool loses its data.** -- `tool-private` scope is keyed by tool name. Renaming `usage_counter` to `query_counter` creates a new `tool:query_counter` namespace. Migrate data manually or keep the old name.
