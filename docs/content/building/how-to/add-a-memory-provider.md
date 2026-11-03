---
title: "Add a memory provider"
description: "Implement the five-method MemoryProvider contract against your own backend, register it from a plugin, and select it per personality. Three parts."
kind: how-to
audience: developer
slug: add-a-memory-provider
time: "15 min"
updated: 2026-11-03
---

## Task

Implement the [MemoryProvider](../../getting-started/glossary.md#memory-provider) interface against a backend of your choice — Postgres, a vector store, a remote API — register it from a plugin, and point a [personality](../../getting-started/glossary.md#personality) at it.

## Result

At the start of every [turn](../../getting-started/glossary.md#turn) for that personality, `prefetch()` reads your backend and the entries land in the system prompt. A personality whose `config.yaml` does not name your provider keeps the deployment backend.
## Parts

| Part | Covers |
|---|---|
| 1. Read the interface (this page) | The five methods, the scope ids Ethos issues, the three rules |
| [2. Implement the provider](add-a-memory-provider/implement.md) | Step 2: a Postgres-backed `PostgresMemoryProvider` |
| [3. Register, select and test](add-a-memory-provider/register-and-test.md) | Steps 3-5, the end-to-end check and troubleshooting |

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
Continue with [part 2](add-a-memory-provider/implement.md).

## Verify

Open `packages/types/src/memory.ts` and confirm `MemoryProvider` declares `prefetch`, `read`, `search`, `sync` and `list`. The end-to-end check is in [part 3](add-a-memory-provider/register-and-test.md#verify).

## Troubleshoot

**You want to add a sixth method.** — `packages/types/src/__tests__/memory-method-count.test.ts` fails. Keep to the five and put extra logic behind them.
