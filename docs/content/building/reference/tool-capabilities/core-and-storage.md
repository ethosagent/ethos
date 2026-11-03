---
title: "Tool capabilities: ToolCapabilities, StorageScope and KeyValueStore"
description: "ToolCapabilities, StorageScope and KeyValueStore interfaces."
kind: reference
audience: developer
updated: 2026-11-03
---

## Synopsis {#synopsis}

The capability bundle a tool receives and its scoped key-value store. Part of the [Tool capabilities reference](../tool-capabilities.md).

## ToolCapabilities {#tool-capabilities}

### Signature {#tool-capabilities-signature}

```ts
import type { ToolCapabilities, SecretRef, StorageScope } from '@ethosagent/types';

export type SecretRef = string;

export type StorageScope = 'tool-private' | 'session' | 'personality';

export interface ToolCapabilities {
  network?: {
    allowedHosts: string[];
  };
  secrets?: SecretRef[];
  storage?: {
    scope: StorageScope;
    kind: 'kv';
    ttlSecondsDefault?: number;
  };
  fs_reach?: {
    read?: string[] | 'from-personality';
    write?: string[] | 'from-personality';
  };
  process?: {
    allowedBinaries: string[];
  };
}
```

### Fields {#tool-capabilities-fields}

| Field | Type | Description |
|---|---|---|
| `network` | `{ allowedHosts: string[] } \| undefined` | Hosts the tool may fetch. Supports exact match (`api.github.com`), wildcard (`*`), and subdomain wildcard (`*.github.com`). Intersected with personality `safety.network.allow` at call time. |
| `secrets` | `SecretRef[] \| undefined` | Secret reference names the tool may read. Each ref is resolved by the configured secrets backend at call time. |
| `storage` | `{ scope, kind, ttlSecondsDefault? } \| undefined` | Key-value storage request. `scope` determines the namespace; `kind` is always `'kv'`; `ttlSecondsDefault` sets a default TTL in seconds for entries (optional). |
| `fs_reach` | `{ read?, write? } \| undefined` | Filesystem paths the tool may access. Each direction is either a `string[]` of absolute paths or `'from-personality'` to defer to the personality's `fs_reach` config. |
| `process` | `{ allowedBinaries: string[] } \| undefined` | Binary names the tool may spawn. Supports exact match (`git`, `npm`) and wildcard (`*`). |

### Notes {#tool-capabilities-notes}

- A tool that touches no external surface declares `capabilities: {}`. The `capabilities` field is required on `Tool<TArgs>`.
- `network.allowedHosts: ['*']` means "whatever the personality allows." The wildcard defers to the personality's `safety.network.allow` list. If the personality has no allow list (absent or `[]`), the tool can reach any public host; `safeFetch` still refuses private ranges, cloud-metadata hosts, non-http(s) schemes and the `deny` list (`resolveCapabilities` in `packages/core/src/capability-resolver.ts`).
- `fs_reach.read: 'from-personality'` and `fs_reach.write: 'from-personality'` are the conventional choice for generic file tools (`read_file`, `write_file`). Tool-specific paths are for tools that know their exact filesystem footprint (e.g. a config reader that only touches `~/.ethos/config.yaml`).

## StorageScope {#storage-scope}

### Signature {#storage-scope-signature}

```ts
export type StorageScope = 'tool-private' | 'session' | 'personality';
```

### Values {#storage-scope-values}

| Value | Resolved scope id | Lifecycle | Typical use |
|---|---|---|---|
| `'tool-private'` | `tool:<toolName>` | Persists across sessions. Private to this tool. | Caches, tool-internal state, rate-limit counters. |
| `'session'` | `session:<sessionId>` | Lives for the duration of the session. Shared across tools in the same session. | Scratch state, session-local accumulators. |
| `'personality'` | `personality:<personalityId>` | Persists across sessions. Scoped to the active personality. Falls back to `session:<sessionId>` if no personality is active. | Personality-specific tool state, cross-session memory. |

### Notes {#storage-scope-notes}

- The scope id is computed by `resolveCapabilities` in `packages/core/src/capability-resolver.ts`. The tool never constructs its own scope id.
- The `KeyValueStore` instance the tool receives is already namespaced. Calling `kvStore.set('foo', 'bar')` stores under the resolved scope id; the tool does not prefix keys.
- `ttlSecondsDefault` on the `storage` declaration sets a default TTL for all entries. Individual `set` calls can override with `{ ttlSeconds }` in the options.

## KeyValueStore {#key-value-store}

### Signature {#key-value-store-signature}

```ts
import type { KeyValueStore } from '@ethosagent/types';

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
```

### Methods {#key-value-store-methods}

| Method | Returns | Description |
|---|---|---|
| `get(key)` | `string \| null` | Read a value by key. Returns `null` if the key does not exist or has expired. |
| `set(key, value, opts?)` | `void` | Write a value. `opts.ttlSeconds` overrides the default TTL from the capability declaration. |
| `delete(key)` | `void` | Remove a key. No-op if the key does not exist. |
| `list(prefix)` | `string[]` | List keys matching a prefix. Returns key names, not values. |

### Notes {#key-value-store-notes}

- The store is injected into `ToolContext.kvStore` when the tool declares `storage` in its capabilities. Absent if the tool does not declare storage or no `kvStoreFactory` backend is configured.
- Values are strings. Tools that need structured data should serialise to JSON.

## See also {#see-also}

- [Tool capabilities reference](../tool-capabilities.md): the index of every section and its page.
