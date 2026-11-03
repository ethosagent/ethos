---
title: "What does Ethos look like in 90 seconds?"
description: "How Ethos works: AgentLoop streams typed events, components are injected at construction, every extension point is an interface in @ethosagent/types."
kind: explanation
audience: shared
slug: architecture-90-seconds
updated: 2026-11-03
---

Ethos has one core abstraction and a handful of interfaces around it. This page is the 90-second tour. Every term linked below has an entry in the [glossary](glossary.md).

## Parts

| Part | Covers |
|---|---|
| This page | The core abstraction, the turn cycle, the surface architecture, injection, extension points, a personality. |
| [Why do all surfaces share one AgentEvent stream?](./architecture-90-seconds/surfaces-and-events.md) | The surface architecture and AgentEvent, the streaming contract. |

## The one core abstraction

`AgentLoop` is an `AsyncGenerator<AgentEvent>`. You give it a user message; it streams typed events back — text, tool calls, usage, errors, completion — until the turn is done.

Every dependency `AgentLoop` needs (LLM provider, [session](glossary.md#session) store, memory provider, [personality](glossary.md#personality) registry, [tool](glossary.md#tool) registry, [hook](glossary.md#hook) registry) is an interface defined in `@ethosagent/types` and injected at construction. Core never imports concrete implementations.

## The turn cycle

<figure class="ethos-figure"><div class="ethos-figure-pad"><svg viewBox="0 0 640 540" role="img" aria-label="Flow diagram of the turn cycle. ~/.ethos/config.yaml flows into wiring.ts, which assembles LLMProvider (AnthropicProvider or OpenAICompatProvider), SessionStore (SQLiteSessionStore, WAL plus FTS5), MemoryProvider (MarkdownFileMemoryProvider), and PersonalityRegistry (FilePersonalityRegistry with mtime hot-reload). That flows into AgentLoop.run(text), an AsyncGenerator of AgentEvent, which runs in order: session_start hooks; MemoryProvider.prefetch() producing system context; ContextInjector[] assembling the system prompt; before_prompt_build hooks; LLMProvider.complete() streaming chunks (text_delta events, tool_use_start / delta / end, usage event); ToolRegistry.executeParallel() with before_tool_call hooks for arg override or rejection, parallel execution with budget splitting, and after_tool_call hooks; MemoryProvider.sync(); and agent_done hooks." font-family="Geist Mono,monospace">
<defs><marker id="arch90-cycle-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#70706B"/></marker></defs>
<rect x="190" y="12" width="260" height="38" rx="10" fill="#EAC98F" fill-opacity="0.08" stroke="#EAC98F"/>
<line x1="320" y1="50" x2="320" y2="74" stroke="#70706B" marker-end="url(#arch90-cycle-arrow)"/>
<rect x="60" y="78" width="520" height="128" rx="10" fill="#9CC5F2" fill-opacity="0.08" stroke="#9CC5F2"/>
<line x1="320" y1="206" x2="320" y2="230" stroke="#70706B" marker-end="url(#arch90-cycle-arrow)"/>
<rect x="40" y="234" width="560" height="292" rx="10" fill="#9BDDB4" fill-opacity="0.08" stroke="#9BDDB4"/>
<g font-size="13" fill="var(--ethos-text-primary)">
<text x="320" y="36" text-anchor="middle">~/.ethos/config.yaml</text>
<text x="80" y="102">wiring.ts</text>
<text x="80" y="126">LLMProvider</text>
<text x="80" y="146">SessionStore</text>
<text x="80" y="166">MemoryProvider</text>
<text x="80" y="186">PersonalityRegistry</text>
<text x="60" y="258">AgentLoop.run(text)</text>
<text x="60" y="284">session_start hooks</text>
<text x="60" y="304">MemoryProvider.prefetch()</text>
<text x="60" y="324">ContextInjector[]</text>
<text x="60" y="344">before_prompt_build hooks</text>
<text x="60" y="364">LLMProvider.complete()</text>
<text x="60" y="404">ToolRegistry.executeParallel()</text>
<text x="60" y="484">MemoryProvider.sync()</text>
<text x="60" y="504">agent_done hooks</text>
</g>
<g font-size="11" fill="var(--ethos-text-secondary)">
<text x="560" y="102" text-anchor="end">assembles all components from config</text>
<text x="272" y="126">AnthropicProvider | OpenAICompatProvider</text>
<text x="272" y="146">SQLiteSessionStore (WAL + FTS5)</text>
<text x="272" y="166">MarkdownFileMemoryProvider</text>
<text x="272" y="186">FilePersonalityRegistry (mtime hot-reload)</text>
<text x="580" y="258" text-anchor="end">AsyncGenerator&lt;AgentEvent&gt;</text>
<text x="330" y="304">→ system context</text>
<text x="330" y="324">→ system prompt assembly</text>
<text x="330" y="364">→ stream chunks</text>
<text x="90" y="384">text_delta events · tool_use_start / delta / end · usage event</text>
<text x="90" y="424">before_tool_call hooks (arg override / rejection)</text>
<text x="90" y="444">parallel execution with budget splitting</text>
<text x="90" y="464">after_tool_call hooks</text>
</g>
</svg></div><figcaption>The turn cycle: config assembles the components in wiring.ts, and AgentLoop.run() streams each turn through hooks, context assembly, the LLM stream, and parallel tool execution.</figcaption></figure>

Three things worth noticing in this diagram:

1. **Streams, not batched responses.** Every step that emits output yields to the generator. The CLI prints text as it arrives; channel adapters update messages mid-flight.
2. **Hooks fire at every boundary.** `session_start`, `before_prompt_build`, `before_tool_call`, `after_tool_call`, `agent_done` — each is a registration point for cross-cutting concerns (auth, audit, rate limiting).
3. **Tools execute in parallel within a budget.** When the model returns multiple `tool_use` blocks in one turn, `ToolRegistry.executeParallel` runs them concurrently and splits an 80k-character result budget across them.

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
| `PlatformAdapter` | CLI readline | Telegram, Discord, Slack, WhatsApp, Email |
| `PluginLoader` | `DefaultPluginLoader` | Plugins register SQLite data sources, widget templates (`widgets.yaml`), and slash commands |
| `SkillEvolver` | `@ethosagent/skill-evolver` | Analyzes eval output and proposes skill improvements |

## What a personality changes

A personality lives at `~/.ethos/personalities/<id>/` — three files (`SOUL.md`, `config.yaml`, `toolset.yaml`). Switching personalities atomically changes:

- **System prompt** (from `SOUL.md`)
- **Tool access** (from `toolset.yaml`)
- **Memory scope** (`personality:<id>`, derived from the personality id — not a setting)
- **Model** (the `model` role or `modelRegistry` alias in `config.yaml`, as `resolveTurnModel` resolves it)

The mental model is: a personality is a *role-bound configuration of the agent*, not a prompt string. The researcher and the engineer are not the same agent in different costumes — they have different tools, different memories, different models. The next page explains why that matters.

## Recommended reading order

Newcomers usually go from here in this order:

1. [Why is personality the unit?](../using/explanation/what-is-a-personality.md) — the headline thesis
2. [Why Ethos?](why-ethos.md) — honest comparison to LangChain, CrewAI, OpenClaw, Hermes
3. [Use Ethos: quickstart](../using/quickstart.md) — install, talk to the agent, switch personalities
4. [Use the web dashboard](../using/how-to/use-web-dashboard.md) — personalities, memory, cron jobs, and MCP from the browser

## See also

- [What is Ethos?](what-is-ethos.md) — start here if this page assumed too much
- [Why Ethos?](why-ethos.md) — comparison to LangChain, CrewAI, OpenClaw, Hermes
- [AgentEvent reference](../building/reference/agent-event.md) — every variant in detail
- [Plugin development](../building/how-to/create-a-plugin.md) — data sources, widgets, slash commands
- [MCP server](../using/how-to/use-as-mcp-server.md) — serving Ethos as an MCP server
