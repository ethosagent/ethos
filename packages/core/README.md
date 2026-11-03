# @ethosagent/core

## Purpose

The agent runtime: `AgentLoop` (an async generator of `AgentEvent`), the tool, hook, plugin and provider registries, session management, context-compaction engines, and scoped storage. It depends only on `@ethosagent/types` and implements the contracts defined there.

## Public surface

`package.json` `exports` points at `dist`, so build first to consume it. The surface is defined by `src/index.ts`, 115 export statements. Main entry points:

| Export | Kind | One line |
|---|---|---|
| `AgentLoop` | class | Runs a turn and yields `AgentEvent`s. |
| `isKnownAgentEvent` | function | Checks whether an event type is known. |
| `DefaultHookRegistry` | class | Hook registry. |
| `DefaultToolRegistry` | class | Tool registry. |
| `PluginRegistry` | class | Plugin registry. |
| `DefaultLLMProviderRegistry` | class | LLM provider registry. |
| `DefaultMemoryProviderRegistry` | class | Memory provider registry. |
| `DefaultStorageRegistry` | class | Storage registry. |
| `DefaultExecutionBackendRegistry` | class | Execution backend registry. |
| `DefaultPersonalityRegistry` | class | Personality registry default. |
| `DefaultNotificationRouter` | class | Notification router. |
| `SessionManager` | class | Execution session manager. |
| `InMemorySessionStore` | class | In-memory session store. |
| `ContextStore` | class | Context store. |
| `DropOldestEngine` | class | Context engine that drops the oldest messages. |
| `SemanticSummaryEngine` | class | Context engine that summarises history. |
| `TieredSummaryEngine` | class | Tiered summarising context engine. |
| `validateContextEngine` | function | Conformance check for context engines. |
| `buildScopedStorage` | function | Builds scoped storage for a run. |
| `resolveCapabilities` | function | Resolves a tool's capabilities. |
| `assertWithinBase` | function | Throws `BoundaryEscapeError` on path escape. |
| `buildLaneKey` | function | Builds a lane key. |
| `deriveBotKey` | function | Derives a bot key. |
| `ChannelOverrideStore` | class | Per-channel override store. |
| `FileClarifyStore` | class | File-backed clarify store. |

## Seam

Implements the runtime side of the contracts in `@ethosagent/types` and must not import concrete implementations (ARCHITECTURE.md section III, Law 2). Archcheck layer: `core`. Single-owner contracts for the loop are in `.claude/rules/agent-loop.md`.

Pinned behaviours:
- Core reaches the security kernel through type-only imports: `src/__tests__/no-kernel-runtime-imports.test.ts`.
- Every production `AgentLoop.run(` call passes `roomAudience` or is marked private-by-design: `src/__tests__/audience-census.test.ts`.
- The system prompt is static-first so the prefix stays byte-stable: `src/__tests__/prompt-prefix-stability.test.ts`.

## Testing

```
pnpm vitest run packages/core
```

Pinning tests:
- `src/__tests__/no-kernel-runtime-imports.test.ts`: Law 2 for the security kernel.
- `src/__tests__/audience-census.test.ts`: `roomAudience` on every `run`.
- `src/__tests__/prompt-prefix-stability.test.ts`: static-first prompt.
- `src/__tests__/safety-conformance.test.ts`: safety conformance.
- `src/__tests__/agent-loop.test.ts`: the loop itself.
