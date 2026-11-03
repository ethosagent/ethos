# @ethosagent/tools-process

## Purpose

Background process lifecycle tools: start long-running commands (`pnpm dev`, `docker compose up`), tail their logs and stop them, tracked across agent turns. One-shot commands that wait for completion belong to `terminal`, not here.

## Public surface

From `src/index.ts`; `./compose` is a second package export.

| Export | Kind | One line |
|---|---|---|
| `createProcessTools` | function | Builds the five `process_*` tools. |
| `listProcesses` | function | Shared list logic used by the tools and `ethos process list`. |
| `readProcessLogs` | function | Shared log-tail logic. |
| `stopProcess` | function | Shared stop logic with SIGTERM-to-SIGKILL escalation. |
| `reconcileRegistry` | function | Startup scan flipping dead `running` entries to `orphan`. |
| `createProcessGuardHook` | function | Guard hook for `process_start` commands. |
| `checkCommand` | function | Checks a command against the guard. |
| `ProcessEntry` | type | One registry record. |
| `isAlive` | function | Liveness probe on a pid. |
| `saveRegistry` | function | Atomic registry write. |

## Seam

Implements the `Tool` interface from `@ethosagent/types`; archcheck layer `extensions`.

- The `process_start` argv floor mirrors the terminal guard's deny list. Pinned by `src/__tests__/deny-manifest-parity.test.ts`.
- Registry mutations are serialized through an advisory lock. Pinned by `src/__tests__/registry.test.ts` (`withRegistryLock`).
- Startup crash recovery flips dead `running` entries to `orphan`. Pinned by `src/__tests__/lifecycle.test.ts`.

## More

- [docs/tool-reference.md](./docs/tool-reference.md) -- capabilities and per-tool reference.
- [docs/internals.md](./docs/internals.md) -- CLI mirror, registry and logs, cancellation, error codes, gotchas, file map.

## Testing

```
pnpm vitest run extensions/tools-process
```

Pinning tests: `src/__tests__/process.test.ts` (real child processes), `src/__tests__/registry.test.ts`, `src/__tests__/spawn.test.ts`, `src/__tests__/operations.test.ts`, `src/__tests__/lifecycle.test.ts`, `src/__tests__/guard.test.ts`.
