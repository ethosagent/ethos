---
title: "Why bound tool results, filter toolsets and measure cost per session?"
description: "Cost layers 5-7: result budget, toolset filtering and session telemetry."
kind: explanation
audience: developer
updated: 2026-11-03
---

## Context

This page covers the last three of the seven cost layers.

## Discussion

### Layer 5: Per-tool result budget -- bound the worst-case turn

The [tool result budget](../../../getting-started/glossary.md#tool-result-budget) is an 80K total character cap split evenly across parallel tool calls. `ToolRegistry.executeParallel` (line 204 of `packages/core/src/tool-registry.ts`) divides 80,000 characters by the number of concurrent calls and trims each result if it exceeds its share, appending a `[truncated -- N chars total]` marker.

This is the catch-all safety net. Layers 3 and 4 reduce output semantically; Layer 5 enforces an absolute ceiling. A tool that produced 200KB of output -- because the reducer did not handle its shape, or because the user explicitly requested a large range -- still cannot consume the entire context window.

The per-call budget is dynamic: a single-tool turn gets the full 80K; a four-tool parallel turn gets 20K each. This favours single-tool turns (often "read this one file for me") while still bounding multi-tool turns.

Tools can declare a lower `maxResultChars` to opt into a tighter limit. The actual budget per call is `Math.min(perCallBudget, tool.maxResultChars ?? perCallBudget)`.

See [Why is there an 80k tool result budget?](../tool-result-budget.md) for the full reasoning, trade-off analysis, and detailed examples.

### Layer 6: Personality toolset filtering -- send only the tool definitions the model can use

Tool definitions are JSON sent in every request. A large toolset -- forty tools with schemas, descriptions, and examples -- can add thousands of tokens to the system prompt on every turn.

The [personality](../../../getting-started/glossary.md#personality) `toolset.yaml` is an allowlist of tool names the personality can invoke. `AgentLoop` reads `personality.toolset` and passes it to `DefaultToolRegistry.toDefinitions(allowedTools)`, which filters the full registry down to only the permitted tools before building the request. The LLM never sees tool definitions it is not allowed to call.

A research personality with five tools sends a compact tool section. A developer personality with twenty tools sends a larger section -- but not the forty-tool maximum the registry contains. Neither personality pays for tools that do not belong in its context.

Code reference: `packages/core/src/agent-loop.ts` lines 140, 265, 396.

### Layer 7: Per-session cost telemetry -- measure what you optimise

The seven layers work; the telemetry makes them visible.

`ethos session show <id>` renders per-session cost and cache performance:

- Total input tokens and output tokens
- Estimated cost in USD
- Cache hit rate -- what fraction of input tokens were served from Anthropic's cache at 10% cost

Cache fields (`cache_read_input_tokens`, `cache_creation_input_tokens`) are persisted to SQLite on every turn and aggregated for the session view. Code reference: `apps/ethos/src/commands/sessions.ts` (line 156).

The cache hit rate is the clearest indicator of whether Layer 1 is working. A new session starts at 0%; a warm 20-turn session typically runs at 70--90% cache hits, depending on how much the system prompt changes per turn. If the hit rate is low, the system prompt is varying -- personality hot-reload, memory updates on every turn, or tool definitions changing. The telemetry surfaces this before it becomes a cost surprise.

## Trade-offs

See [Trade-offs](../context-cost-optimization.md#trade-offs) on [Why does Ethos cost so much less to run than a naive agent loop?](../context-cost-optimization.md).

## See also

- [Why does Ethos cost so much less to run than a naive agent loop?](../context-cost-optimization.md) — the parent page.
