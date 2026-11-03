# @ethosagent/types

## Purpose

Zero-dependency interface contracts for the Ethos agent framework: the types, small value helpers and error classes every other package imports. `src/index.ts` re-exports about 60 modules; this table lists the main contract families.

## Public surface

Single entry (`.`); `src/index.ts` is `export * from` each module below.

| Export | Kind | One line |
|---|---|---|
| `Storage` | interface | Filesystem seam for personality-boundary access (`storage.ts`). |
| `AttachmentCache` | interface | Per-session attachment cache (`storage.ts`). |
| `BoundaryError` | class | Thrown when a path is outside an allowlist (`storage.ts`). |
| `Tool` | interface | A callable tool (`tool.ts`). |
| `ToolContext` | interface | Context passed to tool execution (`tool.ts`). |
| `LLMProvider` | interface | LLM provider contract (`llm.ts`). |
| `AgentEvent` | type | Union of events emitted by the agent loop (`agent-event.ts`). |
| `HookRegistry` | interface | Hook registration and firing (`hooks.ts`). |
| `SessionStore` | interface | Session persistence (`session.ts`). |
| `MemoryProvider` | interface | Memory backend (`memory.ts`). |
| `ContextEngine` | interface | Context assembly and compaction (`context-engine.ts`). |
| `PersonalityConfig` | interface | Personality configuration (`personality.ts`). |
| `PlatformAdapter` | interface | Channel adapter contract (`platform.ts`). |
| `ExecutionBackend` | interface | Command execution backend (`execution.ts`). |
| `EthosError` | class | Base error with codes (`errors.ts`). |
| `SecretsResolver` | interface | Secret lookup (`secrets.ts`). |
| `SecretNotFoundError` | class | Thrown for a missing secret (`secrets.ts`). |
| `isValidSecretName` | function | Validates secret names (`secrets.ts`). |
| `ToolResultReducer` | type | Tool result reducer contract (`tool-reducer.ts`). |
| `BundleManifest` | interface | Portable personality bundle manifest (`index.ts`). |
| `ExportStamp` | interface | Export stamp on a bundle (`index.ts`). |

Also: audience, background jobs, channel conformance/transcript, clarify, command, constitution, content store, decision, diagnostics, evaluator, goal, lease, logger, MCP, model registry/catalog, monitor, notification router, OAuth, observability, plugin/panel/UI, retention, safety, sandbox, skill, steer, team, todo, usage, voice. See `src/index.ts` and the module files in `src/`.

## Seam

Archcheck layer `contracts`: imports no other internal layer (Law 1, archcheck rule `l1-contracts-pure`, ARCHITECTURE.md Section III). Frozen schemas here change only through their drift gates (ARCHITECTURE.md Section VII).

## Testing

```
pnpm vitest run packages/types
```

- `src/__tests__/architecture-rules.test.ts`: architecture rules.
- `src/__tests__/storage-method-shape.test.ts`: `Storage` method shape.
- `src/__tests__/storage-construction-boundary.test.ts`: library code does not construct `FsStorage`.
- `src/__tests__/agent-event-drift.test.ts`: `AgentEvent` drift gate.
- `src/__tests__/llm-provider-drift.test.ts`: `LLMProvider` drift gate.
- `src/__tests__/personality-field-count.test.ts`: `PersonalityConfig` field count.
- `src/__tests__/tool-context-fields.test.ts`: `ToolContext` fields.
- `src/__tests__/context-engine-method-count.test.ts`, `memory-method-count.test.ts`: method counts of `ContextEngine` and `MemoryProvider`.
- `src/__tests__/error-code-docs-parity.test.ts`: error codes match docs.
