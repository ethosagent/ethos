# @ethosagent/test-kit

## Purpose

Canonical test helpers that need only `@ethosagent/types`, so test files import one copy instead of redefining it per file. The package is private (`"private": true`) and test-only: shipped code never imports it. No call sites have migrated yet.

## Public surface

| Export | Kind | Signature |
|---|---|---|
| `drain` | function | `drain(iter: AsyncIterable<unknown>): Promise<void>` consumes the iterable to exhaustion and discards every item. |
| `collect` | function | `collect<T>(iter: AsyncIterable<T>): Promise<T[]>` consumes the iterable and returns its items in order. |
| `makeCtx` | function | `makeCtx(overrides?: Partial<ToolContext>): ToolContext` returns a complete `ToolContext`; `overrides` win field by field. |
| `scriptedLLM` | function | `scriptedLLM(steps?: ScriptedStep[]): ScriptedLLM` returns an `LLMProvider` that answers each `complete()` call with the next step. |
| `makeFakeAdapter` | function | `makeFakeAdapter(overrides?: Partial<PlatformAdapter>): FakeAdapter` returns a `PlatformAdapter` whose `send` succeeds and records message text. |
| `ScriptedToolCall` | type | `{ id: string; name: string; input: unknown }`; `input` is JSON-stringified into `tool_use_end`. |
| `ScriptedStep` | type | `string \| ScriptedToolCall[]`: a string is a text reply, an array is a batch of tool calls. |
| `ScriptedLLMCall` | type | `{ messages; tools; options }` as received by one `complete()` call. |
| `ScriptedLLM` | type | `LLMProvider & { readonly calls: ScriptedLLMCall[] }`. |
| `FakeAdapter` | type | `PlatformAdapter & { sentMessages: string[] }`. |

`scriptedLLM` ends a text step with `end_turn` and a tool-call step with `tool_use`. Once the steps run out it answers `'ok'`. Every call's arguments are recorded on `calls` as shallow snapshots.

## Seam

Depends only on `@ethosagent/types`. Helpers that need `AgentLoop` (for example `stubLoop`) stay local to their tests, because this package cannot import `@ethosagent/core`. A call site migrates only where its local helper behaves the same.

## Testing

```
pnpm vitest run packages/test-kit
```

Pinning tests:
- `src/__tests__/test-kit.test.ts`: `drain`, `collect`, `makeCtx`, `scriptedLLM` and `makeFakeAdapter`.
