---
title: "Why does server-side compaction need a new CompletionChunk variant?"
description: "The §VI amendment that added the compaction variant to CompletionChunk: why nothing else could carry the block, and who signed it off."
kind: explanation
audience: developer
slug: llm-provider-governance
updated: 2026-09-24
---

## Context

A long conversation eventually outgrows the model's context window. Ethos has
always compacted it locally: a context engine (the pluggable strategy that
decides what to drop or summarize) rewrites the
history before the request goes out. Anthropic now offers the same job on the
server, and letting the provider do it saves Ethos a second summarization call.

The server-side version is the `compact_20260112` context-management edit, sent
with the `compact-2026-01-12` beta header. When the request's input tokens cross
the configured trigger, the API summarizes the older turns and returns a
`compaction` content block, `{ content, encrypted_content }`, ahead of the
reply. The API documents one hard obligation on the client: send that block
back on every later request. On the next request the API drops everything
before the block and continues from the summary. `encrypted_content` is opaque
metadata that must come back byte for byte.

An [LLM provider](../../getting-started/glossary.md#llm-provider) (the adapter
between Ethos and one model API) talks to the agent loop through one channel: the
`AsyncIterable<CompletionChunk>` that `LLMProvider.complete()` returns
(`packages/types/src/llm.ts`). Before this amendment the union had eight
variants: `text_delta`, `thinking_delta`, `tool_use_start`, `tool_use_delta`,
`tool_use_end`, `usage`, `done`, `warning`. None of them can carry a block the
client must store and replay.

## Discussion

### Why not keep the block inside the provider?

The obvious alternative is a provider-private cache: remember the last block
per conversation and splice it back in. `CompletionOptions` carries no session
identity, so a provider cannot tell one conversation from another. A cache keyed
by message content would also be lost on restart, while the history the block
replaces lives in `sessions.db` and survives. The block has to be persisted
with the rest of the conversation, and the only thing that persists history is
the agent loop.

### Why not reuse `warning` or `usage`?

`warning` carries a human-readable string that surfaces as a notice.
`usage.metadata` is an untyped bag that no consumer persists. Encoding a
round-trip obligation into either would make a frozen contract mean something
its type does not say. A contract that says what it carries is the reason the
union is frozen at all.

### What the variant is

```typescript
| { type: 'compaction'; content: string | null; encryptedContent: string | null }
```

`content: null` is a compaction the server failed to produce. The API treats a
round-tripped null block as a no-op, and Ethos persists it all the same so the
replay stays faithful. Only `@ethosagent/llm-anthropic` emits the variant.

### What consumers do with it

The agent loop's stream stage (`streamStep` in
`packages/core/src/agent-loop/stages/stream-step.ts`) persists each
`compaction` chunk as its own assistant row, ahead of the reply. The row's
`content` is a tagged envelope (`encodeCompactionEnvelope` in
`packages/types/src/llm.ts`), so the `SessionStore` schema does not change.
`toAnthropicMessages` in `extensions/llm-anthropic/src/index.ts` turns the
envelope back into a `compaction` block on the next request. Every other
provider's message mapper calls `flattenCompactionEnvelopes`, which sends the
readable summary as plain assistant text and drops `encrypted_content`. The
wrappers that forward chunks (`ChainedProvider`, `AuthRotatingProvider`) pass
the variant through untouched, like every other chunk.

`AgentEvent` is unchanged. A compaction is not something a surface renders; the
cost of the compaction iteration arrives on the existing `usage` chunk.

## Trade-offs

| Choice | Bought | Paid |
|---|---|---|
| A new chunk variant | The block reaches the one component that can persist it, with a type that says so | A §VI Substantive amendment. Any consumer that validates chunk types against a fixed set must learn the new name (`checkChunkVariants` in `packages/wiring/src/conformance/index.ts` did, in the same commit) |
| Envelope in `StoredMessage.content` | No `SessionStore` change, no migration | The transcript shows one extra assistant row per compaction, and full-text search indexes the envelope |
| Text fallback for other providers | A failover mid-session keeps the summary instead of losing it | The encrypted half is dropped, so a later switch back to Anthropic restarts from the summary text, not the server's own state |

## Amendment record

| Field | Value |
|---|---|
| Class | §VI Substantive, under the §VII LLM provider contract row |
| Change | `CompletionChunk` gains `compaction`; 8 → 9 variants |
| Drift gate | `packages/types/src/__tests__/llm-provider-drift.test.ts`, checked against its own list AND the `frozen_schemas.llm_provider.frozen_variants` manifest in ARCHITECTURE.md §IX |
| Plan | `openclaw-9.5-adoption` item 7, decision D31 |
| Owner approval | Granted by the repository owner (Mitesh), 2026-09-24 |
| Second maintainer | **Pending.** §VI asks for two maintainers; only the owner's approval was available when the amendment landed. The owner instructed implementation to proceed |
| Migration | None required. The variant is additive; consumers that ignore unknown chunk types need no change |

## See also

- [LLM provider interface](../reference/llm-provider-interface.md): every `CompletionChunk` variant and its fields.
- [Configuration reference: `providers.<i>.*`](../../using/reference/config-yaml.md#providers-chain): the `serverCompaction` switch that turns this on.
- [Why does AgentCard need a drift gate?](agent-card-governance.md): the same §VII procedure applied to another frozen schema.
- [Personality governance](personality-governance.md): the worked example of the freeze rule.
