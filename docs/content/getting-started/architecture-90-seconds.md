---
title: "What does Ethos look like in 90 seconds?"
description: "How Ethos works: AgentLoop streams typed events, components are injected at construction, every extension point is an interface in @ethosagent/types."
kind: explanation
audience: shared
slug: architecture-90-seconds
updated: 2026-05-12
---

Ethos has one core abstraction and a handful of interfaces around it. This page is the 90-second tour. Every term linked below has an entry in the [glossary](glossary.md).

## The one core abstraction

`AgentLoop` is an `AsyncGenerator<AgentEvent>`. You give it a user message; it streams typed events back — text, tool calls, usage, errors, completion — until the turn is done.

Every dependency `AgentLoop` needs (LLM provider, session store, memory provider, personality registry, tool registry, hook registry) is an interface defined in `@ethosagent/types` and injected at construction. Core never imports concrete implementations.

## The turn cycle

```
~/.ethos/config.yaml
        │
        ▼
    wiring.ts                    assembles all components from config
    ├── LLMProvider              AnthropicProvider | OpenAICompatProvider
    ├── SessionStore             SQLiteSessionStore (WAL + FTS5)
    ├── MemoryProvider           MarkdownFileMemoryProvider
    └── PersonalityRegistry      FilePersonalityRegistry (mtime hot-reload)
        │
        ▼
    AgentLoop.run(text)          AsyncGenerator<AgentEvent>
    ├── session_start hooks
    ├── MemoryProvider.prefetch()    → system context
    ├── ContextInjector[]            → system prompt assembly
    ├── before_prompt_build hooks
    ├── LLMProvider.complete()       → stream chunks
    │   ├── text_delta events
    │   ├── tool_use_start / delta / end
    │   └── usage event
    ├── ToolRegistry.executeParallel()
    │   ├── before_tool_call hooks   (arg override / rejection)
    │   ├── parallel execution with budget splitting
    │   └── after_tool_call hooks
    ├── MemoryProvider.sync()
    └── agent_done hooks
```

Three things worth noticing in this diagram:

1. **Streams, not batched responses.** Every step that emits output yields to the generator. The CLI prints text as it arrives; channel adapters update messages mid-flight.
2. **Hooks fire at every boundary.** `session_start`, `before_prompt_build`, `before_tool_call`, `after_tool_call`, `agent_done` — each is a registration point for cross-cutting concerns (auth, audit, rate limiting).
3. **Tools execute in parallel within a budget.** When the model returns multiple `tool_use` blocks in one turn, `ToolRegistry.executeParallel` runs them concurrently and splits an 80k-character result budget across them.

## AgentEvent — the streaming contract

Everything the agent does is one of these eight event types:

```typescript
type AgentEvent =
  | { type: 'text_delta';     text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_start';     toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_progress';  toolName: string; message: string; percent?: number }
  | { type: 'tool_end';       toolCallId: string; toolName: string; ok: boolean; durationMs: number }
  | { type: 'usage';          inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'error';          error: string; code: string }
  | { type: 'done';           text: string; turnCount: number }
```

Consuming the generator:

```typescript
for await (const event of agentLoop.run('explain this codebase')) {
  if (event.type === 'text_delta') process.stdout.write(event.text)
  if (event.type === 'tool_start') console.log(`\n[${event.toolName}]`)
  if (event.type === 'done') console.log(`\nTurns: ${event.turnCount}`)
}
```

A surface (CLI, channel adapter, web UI) renders whichever subset of events it cares about. The contract is the same everywhere — same event types, same fields, same semantics.

## Injection at construction

`AgentLoop` receives every component via `AgentLoopConfig`. Nothing is global. The `wiring.ts` in the CLI reads `~/.ethos/config.yaml` and assembles the loop:

```typescript title="apps/ethos/src/wiring.ts"
const loop = new AgentLoop({
  llm: new AnthropicProvider({ apiKey, model }),
  session: new SQLiteSessionStore({ path: '~/.ethos/sessions.db' }),
  memory: new MarkdownFileMemoryProvider({ dir: '~/.ethos' }),
  personalities: new FilePersonalityRegistry({ dir: '~/.ethos/personalities' }),
  tools: new DefaultToolRegistry(),
  hooks: new DefaultHookRegistry(),
})
```

To use a different LLM, session store, or memory backend — implement the interface and inject it. Nothing else changes.

## Extension points

Every interface below is in `@ethosagent/types` (zero dependencies; safe to depend on from anywhere).

| Interface | Default implementation | Swap to |
|---|---|---|
| `LLMProvider` | `AnthropicProvider`, `OpenAICompatProvider` | Any HTTP-based LLM |
| `SessionStore` | `SQLiteSessionStore` | Redis, Postgres, in-memory |
| `MemoryProvider` | `MarkdownFileMemoryProvider` | Vector store, database |
| `PersonalityRegistry` | `FilePersonalityRegistry` | Remote registry |
| `ToolRegistry` | `DefaultToolRegistry` | Custom filtering / routing |
| `HookRegistry` | `DefaultHookRegistry` | Custom hook execution |
| `PlatformAdapter` | CLI readline | Telegram, Discord, Slack |

## What a personality changes

A personality lives at `~/.ethos/personalities/<id>/` — three files (`ETHOS.md`, `config.yaml`, `toolset.yaml`). Switching personalities atomically changes:

- **System prompt** (from `ETHOS.md`)
- **Tool access** (from `toolset.yaml`)
- **Memory scope** (from `memoryScope` in `config.yaml`)
- **Model** (from `model` in `config.yaml`)

The mental model is: a personality is a *role-bound configuration of the agent*, not a prompt string. The researcher and the engineer are not the same agent in different costumes — they have different tools, different memories, different models. The next page explains why that matters.

## Recommended reading order

Newcomers usually go from here in this order:

1. [Why is personality the unit?](../using/explanation/what-is-a-personality.md) — the headline thesis
2. [Why Ethos?](why-ethos.md) — honest comparison to LangChain, CrewAI, OpenClaw, Hermes
3. [Use Ethos: quickstart](../using/quickstart.md) — install, talk to the agent, switch personalities

## See also

- [What is Ethos?](what-is-ethos.md) — start here if this page assumed too much
- [Why Ethos?](why-ethos.md) — comparison to LangChain, CrewAI, OpenClaw, Hermes
- [AgentEvent reference](../building/reference/agent-event.md) — every variant in detail
