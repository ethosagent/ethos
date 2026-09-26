---
title: "What does Ethos look like in 90 seconds?"
description: "How Ethos works: AgentLoop streams typed events, components are injected at construction, every extension point is an interface in @ethosagent/types."
kind: explanation
audience: shared
slug: architecture-90-seconds
updated: 2026-09-13
---

Ethos has one core abstraction and a handful of interfaces around it. This page is the 90-second tour. Every term linked below has an entry in the [glossary](glossary.md).

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

## The surface architecture

`AgentLoop` is a library. It does not know what is consuming its events. Nine surfaces ship today — all of them thin wrappers that feed user input into the loop and render whichever `AgentEvent` subset matters for their medium.

<figure class="ethos-figure"><div class="ethos-figure-pad"><svg viewBox="0 0 680 448" role="img" aria-label="Surface architecture diagram. AgentLoop, an AsyncGenerator of AgentEvent, feeds web-api (Hono plus oRPC, HTTP plus SSE for browser clients), which feeds two apps: Web (React, ethos serve --web) and Desktop (Electron, native tray and global shortcuts). A separate group of direct consumers holds CLI (readline REPL), TUI in Ink (React-Ink terminal dashboard), VS Code extension (sidebar panel in editor), MCP server (serves Ethos as MCP tools), and ACP server (Agent Communication Protocol). A second group holds the channel adapters reached via the gateway: Telegram, Discord, Slack, WhatsApp, and Email." font-family="Geist Mono,monospace">
<defs><marker id="arch90-surface-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#70706B"/></marker></defs>
<rect x="140" y="10" width="400" height="52" rx="10" fill="#9BDDB4" fill-opacity="0.08" stroke="#9BDDB4"/>
<line x1="340" y1="62" x2="340" y2="86" stroke="#70706B" marker-end="url(#arch90-surface-arrow)"/>
<rect x="140" y="90" width="400" height="52" rx="10" fill="#9CC5F2" fill-opacity="0.08" stroke="#9CC5F2"/>
<line x1="215" y1="142" x2="215" y2="166" stroke="#70706B" marker-end="url(#arch90-surface-arrow)"/>
<line x1="465" y1="142" x2="465" y2="166" stroke="#70706B" marker-end="url(#arch90-surface-arrow)"/>
<rect x="110" y="170" width="210" height="56" rx="10" fill="#D8A5E8" fill-opacity="0.08" stroke="#D8A5E8"/>
<rect x="360" y="170" width="210" height="56" rx="10" fill="#D8A5E8" fill-opacity="0.08" stroke="#D8A5E8"/>
<rect x="30" y="256" width="620" height="104" rx="10" fill="#EAC98F" fill-opacity="0.08" stroke="#EAC98F"/>
<rect x="30" y="380" width="620" height="56" rx="10" fill="#9BDDB4" fill-opacity="0.08" stroke="#9BDDB4"/>
<g font-size="13" fill="var(--ethos-text-primary)">
<text x="340" y="32" text-anchor="middle">AgentLoop</text>
<text x="340" y="112" text-anchor="middle">web-api (Hono + oRPC)</text>
<text x="215" y="192" text-anchor="middle">Web (React)</text>
<text x="465" y="192" text-anchor="middle">Desktop (Electron)</text>
<text x="50" y="278">Direct consumers</text>
<text x="92" y="306" text-anchor="middle">CLI</text>
<text x="216" y="306" text-anchor="middle">TUI (Ink)</text>
<text x="340" y="306" text-anchor="middle">VS Code ext.</text>
<text x="464" y="306" text-anchor="middle">MCP server</text>
<text x="588" y="306" text-anchor="middle">ACP server</text>
<text x="50" y="402">Channel adapters (via gateway)</text>
<text x="92" y="424" text-anchor="middle">Telegram</text>
<text x="216" y="424" text-anchor="middle">Discord</text>
<text x="340" y="424" text-anchor="middle">Slack</text>
<text x="464" y="424" text-anchor="middle">WhatsApp</text>
<text x="588" y="424" text-anchor="middle">Email</text>
</g>
<g font-size="11" fill="var(--ethos-text-secondary)">
<text x="340" y="50" text-anchor="middle">AsyncGenerator&lt;AgentEvent&gt;</text>
<text x="340" y="130" text-anchor="middle">HTTP + SSE for browser clients</text>
<text x="215" y="210" text-anchor="middle">ethos serve --web</text>
<text x="465" y="210" text-anchor="middle">native tray, global shortcuts</text>
<text x="92" y="326" text-anchor="middle">readline</text>
<text x="92" y="342" text-anchor="middle">REPL</text>
<text x="216" y="326" text-anchor="middle">React-Ink</text>
<text x="216" y="342" text-anchor="middle">terminal dashboard</text>
<text x="340" y="326" text-anchor="middle">sidebar panel</text>
<text x="340" y="342" text-anchor="middle">in editor</text>
<text x="464" y="326" text-anchor="middle">serves Ethos</text>
<text x="464" y="342" text-anchor="middle">as MCP tools</text>
<text x="588" y="326" text-anchor="middle">Agent Comm.</text>
<text x="588" y="342" text-anchor="middle">Protocol</text>
</g>
</svg></div><figcaption>Nine surfaces consume the same AgentLoop event stream: web and desktop through web-api, five direct consumers in-process, and five channel adapters via the gateway.</figcaption></figure>

The web and desktop apps connect through the same `web-api` layer — a Hono HTTP server with oRPC-typed endpoints that streams `AgentEvent` over SSE. This is the only API surface; there is no separate REST API. Both apps talk to the same `AgentLoop` instance the CLI uses.

Direct consumers embed the loop in-process. The CLI, TUI, and VS Code extension each construct an `AgentLoop` and consume its generator directly. The MCP server and ACP server wrap the loop behind their respective protocols, letting external agents call Ethos tools or delegate tasks to Ethos personalities.

Channel adapters are the thinnest layer. Each adapter translates platform-specific webhook payloads into `InboundMessage` and renders `AgentEvent` back into platform-specific API calls. The gateway handles dedup, routing, and per-bot loop isolation.

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
