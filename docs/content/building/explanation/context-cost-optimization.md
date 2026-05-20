---
title: "Why does Ethos cost so much less to run than a naive agent loop?"
description: "Defense-in-depth for LLM costs in Ethos: seven layers from prefix caching through session telemetry, cutting a 50-turn session by ~85%."
kind: explanation
audience: developer
slug: context-cost-optimization
updated: 2026-05-20
---

## Context

LLM input tokens are the primary cost driver for any agent framework. A naive agent loop sends the full conversation history on every turn -- the system prompt, every prior message, every tool result, the current user message -- and pays the provider's listed input rate for each token, every time.

On a 50-turn session, that compounds fast. A system prompt of 3,000 tokens plus 50 turns of 800 tokens each, with tool results averaging 2,000 tokens per turn: roughly 300,000 tokens of input across the session. At $3/MTok (Claude Sonnet), that is about $0.90 per session -- before any parallel calls, long-running research tasks, or context-heavy tool output.

Ethos does not accept this as the baseline. Seven mechanisms work together to cut that number by roughly **85 percent** on a typical 50-turn session -- from approximately $1.65 down to $0.25. Each layer stops waste that the layer above it did not. They run in order: prevent redundant billing first, then shrink what the model receives, then eliminate what it never needed.

This page explains all seven layers, why they are ordered the way they are, what each one buys, and what you can tune.

## The seven layers at a glance

| Layer | Mechanism | What it does | Automatic? | Typical savings |
|---|---|---|---|---|
| 1 | Prefix caching | Caches system prompt and stable history prefix at 10% of the standard rate | Yes | 90--95% on cached tokens |
| 2 | Mid-turn compaction | Summarizes oldest messages when context grows past 80% of the model window | Yes | Bounds history growth |
| 3 | Tool-output reduction | Rewrites tool results to signal-only form before they enter the context window | Yes | 50--90% on tool output |
| 4 | Team memory index injection | Sends topic names, not content, in the system prompt | Yes | O(1) per turn vs O(N) per topic |
| 5 | Per-tool result budget | 80K total character cap split across parallel calls | Yes | Bounds worst-case turn |
| 6 | Personality toolset filtering | Sends only allowed tool definitions to the LLM | Yes | Proportional to tools omitted |
| 7 | Per-session cost telemetry | Surfaces cache hit rate, token counts, and estimated cost | Yes | Enables informed tuning |

Layers 1 through 6 reduce cost. Layer 7 makes the savings visible. All seven are on by default -- you get the full defense without configuring anything.

## Discussion

The mechanisms form a layered defense. Each layer stops waste that the layer above it did not. They run in this order: prevent redundant billing first, then shrink what the model receives, then eliminate what it never needed.

### Layer 1: Prefix caching -- stop billing for what has not changed

The cheapest token is the one you never pay for again.

Anthropic's prompt caching bills cached input tokens at 10% of the standard input rate. Ethos attaches `cache_control: { type: "ephemeral" }` breakpoints to the end of the system prompt and to the trailing edge of the message-history prefix, instructing Anthropic to cache everything up to that point.

The effect: on turn 2 and beyond, the system prompt ([personality](../../getting-started/glossary.md#personality) identity, memory, tool definitions) is served from Anthropic's cache. A 3,000-token system prompt costs $0.009 on turn 1 and $0.0009 on every subsequent turn. Across a 50-turn session it costs roughly $0.053 rather than $0.45 -- a 90% reduction on that slice alone.

The [AnthropicProvider](../../getting-started/glossary.md#llm-provider) in `extensions/llm-anthropic/src/index.ts` (lines 151--230) places breakpoints at two positions: one at the end of the constructed system prompt, one at the boundary between the stable prefix of message history and the new tail. The stable prefix is the messages that have not changed since the last turn -- the model has already processed them, and Anthropic has already cached them. Only the new tail is billed at full rate.

This layer requires no configuration. It is always on.

### Layer 2: Mid-turn compaction -- shrink history before it becomes expensive

[Sessions](../../getting-started/glossary.md#session) grow turn by turn. Without intervention, a long session keeps adding tokens to every subsequent turn. Compaction is the mechanism that prevents unbounded growth.

`AgentLoop` tracks an estimated token count for the running conversation. When that estimate crosses a pressure threshold -- 80% of the model's context window by default -- the resolved [context engine](../../getting-started/glossary.md#agent-loop) compacts the mid-section of the conversation: it summarises the oldest messages into a compact `_compaction` notice and replaces the raw history with the summary. The tail -- the last few turns -- is kept verbatim, so the model retains immediate context.

The user sees the `_compaction` notice in the session history. It marks where the history was condensed and names the turn range that was summarised.

An anti-thrash cooldown prevents repeated compaction in quick succession. If the model generates a long response on every turn, a naive compactor would compact on every turn -- spending LLM calls on compaction and negating the savings. The cooldown ensures compaction fires at most once per five turns, so the savings compound rather than cancel. Under hard overflow (above 95% of the context window), the cooldown is bypassed to prevent context-limit errors.

Code reference: `packages/core/src/agent-loop.ts` lines 1825--1910 (`maybeCompact`).

### Layer 3: Tool-output reduction -- cut the biggest per-turn cost before it enters the context window

[Tool](../../getting-started/glossary.md#tool) results are often the largest contributor to per-turn input tokens. A `bash` tool running `git log --oneline` can produce hundreds of lines. A `read_file` on an unconstrained path reads the whole file. A `kanban_list` with 80 open tickets sends 80 ticket descriptions.

The `ToolResultReducer` interface in `packages/core` intercepts each tool result *before* it is added to the context window and *before* the budget trim runs. Reducers are deterministic -- no LLM, no async summarisation -- and operate on the raw result string.

Three built-in reducers ship:

**Bash reducer** (`extensions/tools-bash/src/reducers/`): recognises four output shapes and rewrites them semantically rather than by truncation.

- *Git status output* -- converts the file-by-file listing into counts: `3 staged, 12 modified, 4 untracked`. The model knows what changed without reading every path.
- *Test run output* -- extracts the summary line (`42 passed, 3 failed`) and the failure details, dropping the passing-test noise.
- *Package install output* -- reduces `npm install` or `pnpm install` output to the package count and any warnings.
- *Generic fallback* -- applies a head + tail pattern: keeps the first 50 lines and last 50 lines with a count in between. The model sees the beginning (command output, header) and the end (summary, error) without the middle noise.

**Read-file reducer** (`extensions/tools-files/src/reducers/`): when the read call was unconstrained (no explicit byte range requested), prepends a hint -- `[File: 1,240 lines. Showing first 200.]` -- and truncates to 200 lines. The model knows the full file length and can request a specific region on the next turn.

**Kanban list reducer** (`extensions/tools-kanban/src/reducers/`): when a ticket list exceeds 10 items, replaces it with status counts (open: 23, in-progress: 4, done: 187) plus the top 5 open tickets by priority. The model gets the shape of the backlog without processing every ticket description.

Reducers run in `ToolRegistry.executeParallel` before the existing budget trim. A reduced result that still exceeds the per-call budget is trimmed further; a reduced result that fits passes through unchanged. The two mechanisms compose cleanly.

Tool authors can register custom reducers via `ToolReducerRegistry` in `packages/core/src/tool-reducer-registry.ts`. See the [ToolRegistry reference](../reference/tool-registry.md#built-in-reducers) for the registration API and built-in reducer details.

### Layer 4: Team memory index injection -- send names, not content

[Team memory](../../getting-started/glossary.md#memory) topics are markdown files covering architecture decisions, onboarding context, project history. Each file can run to thousands of words. A naive approach loads all topic content into the system prompt on every turn.

Ethos does not do this. The `createTeamMemoryIndexInjector` in `packages/wiring/src/index.ts` (line 1335) injects only the *topic names* into the system prompt -- a one-line index like `Available team memory topics: architecture, decisions, onboarding`. The actual content stays on disk.

When the model needs a topic, it calls `team_memory_read <topic>` to load it on demand. A five-topic team memory with 2,000 words per topic costs 5 words in the system prompt per turn instead of 10,000. The model pays for content only when it reads it, and it reads it only when it needs it.

This is the on-demand pull pattern: the index is cheap to carry; the content is loaded only when the task demands it.

### Layer 5: Per-tool result budget -- bound the worst-case turn

The [tool result budget](../../getting-started/glossary.md#tool-result-budget) is an 80K total character cap split evenly across parallel tool calls. `ToolRegistry.executeParallel` (line 204 of `packages/core/src/tool-registry.ts`) divides 80,000 characters by the number of concurrent calls and trims each result if it exceeds its share, appending a `[truncated -- N chars total]` marker.

This is the catch-all safety net. Layers 3 and 4 reduce output semantically; Layer 5 enforces an absolute ceiling. A tool that produced 200KB of output -- because the reducer did not handle its shape, or because the user explicitly requested a large range -- still cannot consume the entire context window.

The per-call budget is dynamic: a single-tool turn gets the full 80K; a four-tool parallel turn gets 20K each. This favours single-tool turns (often "read this one file for me") while still bounding multi-tool turns.

Tools can declare a lower `maxResultChars` to opt into a tighter limit. The actual budget per call is `Math.min(perCallBudget, tool.maxResultChars ?? perCallBudget)`.

See [Why is there an 80k tool result budget?](tool-result-budget.md) for the full reasoning, trade-off analysis, and detailed examples.

### Layer 6: Personality toolset filtering -- send only the tool definitions the model can use

Tool definitions are JSON sent in every request. A large toolset -- forty tools with schemas, descriptions, and examples -- can add thousands of tokens to the system prompt on every turn.

The [personality](../../getting-started/glossary.md#personality) `toolset.yaml` is an allowlist of tool names the personality can invoke. `AgentLoop` reads `personality.toolset` and passes it to `DefaultToolRegistry.toDefinitions(allowedTools)`, which filters the full registry down to only the permitted tools before building the request. The LLM never sees tool definitions it is not allowed to call.

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

## How the layers compose

The seven layers are not independent features bolted on after the fact. They form a deliberate pipeline where each layer catches waste the previous layers missed and the ordering reflects a principle: cheapest interventions first, most invasive last.

Walk through a concrete token lifecycle to see the pipeline in action. A tool returns 50K characters of `git log` output. Layer 3 (bash reducer) recognises the shape and compresses it to roughly 200 tokens of commit counts and summary lines. Layer 5 (budget) does not need to trim because the reducer already handled it. On subsequent turns, Layer 1 (cache) caches the result as part of the stable message-history prefix at 10% rate. Eventually, Layer 2 (compaction) summarises the entire turn when it ages out of the recent-history tail.

The ordering is intentional. Caching (Layer 1) is free -- it costs nothing to let the provider cache a prefix that has not changed. Reduction (Layer 3) is cheap -- deterministic string operations, no LLM call. Budgeting (Layer 5) is a hard trim -- it loses information but guarantees a ceiling. Compaction (Layer 2) is the most expensive -- it invokes the LLM to summarise old turns. By running the cheapest interventions first, Ethos minimises the work the later layers need to do.

Disabling any one layer increases cost in a distinct way. Without caching, every token is billed at full rate on every turn. Without reduction, tool output enters the context window at full size, forcing the budget to hard-trim more often. Without compaction, the history grows without bound and eventually hits the model's context limit. Without toolset filtering, every personality pays for tool definitions it cannot call.

The layers compose precisely because they target different parts of the token bill. Caching targets repeated content across turns. Reduction targets per-turn tool output. Compaction targets accumulated history. Filtering targets the system prompt. No single mechanism could achieve the same savings alone.

## What you can tune

All seven layers are on by default. The framework chose full defense over configurability -- the right default for most deployments. For operators who need to adjust, each layer exposes specific controls.

| Layer | Config | Default | Where |
|---|---|---|---|
| 1 -- Prefix caching | Always on | -- | No config needed |
| 2 -- Pressure threshold | Hard-coded at 80% of model context window | 0.80 | `packages/core/src/agent-loop.ts` line 1842 |
| 2 -- Cooldown | Hard-coded at 5 turns after compaction | 5 turns | `packages/core/src/agent-loop.ts` line 1852 |
| 3 -- Custom reducers | Register via `ToolReducerRegistry` | 3 built-in reducers | `packages/core/src/tool-reducer-registry.ts` |
| 5 -- Result budget | `resultBudgetChars` on `ToolContext` | 80,000 chars | `packages/core/src/tool-registry.ts` line 204 |
| 5 -- Per-tool cap | `maxResultChars` on `Tool` | Varies per tool | Tool declaration |
| 6 -- Toolset | `toolset.yaml` per personality | All tools | `~/.ethos/personalities/<id>/toolset.yaml` |
| 7 -- Session telemetry | `ethos session show <id>` | Always collected | CLI command |

Guidance for different deployment profiles:

- **Small-window models (16K--32K context).** Lower `resultBudgetChars` to 6,000--10,000 characters. The default 80K cap assumes a 200K context window; smaller windows need a proportionally tighter budget to leave room for history and system prompt.
- **Research-heavy workflows.** If compaction fires too aggressively and the model loses early context it needs, the pressure threshold (currently hard-coded at 0.80) determines when compaction begins. Research workflows that need long memory benefit from a higher threshold -- this requires a code change today but is a candidate for configuration in a future release.
- **Cost-sensitive deployments.** Tighten personality toolsets to the minimum tool set each personality actually uses. Every tool definition removed from `toolset.yaml` saves tokens on every turn for the lifetime of the session.
- **Debugging cost issues.** Run `ethos session show <id>` and check the cache hit rate. Below 60% means the system prompt is varying too much between turns -- look for personality hot-reload, frequent memory updates, or tool-definition changes that break the cache prefix.

## Cost walkthrough

Consider a 50-turn developer session with a research personality (5 tools) on Claude Sonnet ($3/MTok input, $15/MTok output).

### Without Ethos optimizations (naive loop)

Every turn sends the full, unmodified conversation history.

- **System prompt:** 3K tokens repeated on every turn. 3,000 x 50 = 150K tokens at $3/MTok = **$0.45**.
- **History accumulation:** each turn adds roughly 800 tokens of user + assistant messages. By turn 50 the average history is around 40K tokens per turn, accumulating to roughly 300K net input tokens = **$0.90**.
- **Tool results:** 2K tokens per turn on average, sent raw. 2,000 x 50 = 100K tokens = **$0.30**.
- **Total input cost: approximately $1.65.**

### With Ethos (all seven layers active)

- **System prompt:** 3K tokens billed at full rate on turn 1 ($0.009). Turns 2--50 served from cache at 10% rate: 3,000 x 49 x 0.1 x $3/MTok = $0.044. **Net: $0.053.**
- **History:** compaction kicks in around turn 20 (when the estimated context crosses 80% of the window), keeping effective history under 40K tokens. The stable prefix is cached. Estimated net after caching and compaction: **$0.15**.
- **Tool results:** reducers cut 50--90% of tool output before it enters the context window. Budget catches anything the reducers miss. Estimated net: **$0.05**.
- **Total input cost: approximately $0.25.**

That is roughly 85% savings -- the $1.65 naive session costs $0.25 with the full defense stack.

These numbers are illustrative. Actual savings depend on session length, tool usage patterns, model choice, cache hit rate, and how much of the prompt is cacheable. Run `ethos session show` on your own sessions for measured numbers.

## Trade-offs

**The layers are complementary, not competing.** Caching saves on stable content; compaction shrinks growing content; reduction cuts per-tool noise. They address different parts of the token bill. Disabling any one of them increases cost in a distinct way: no caching raises the rate on every token; no compaction lets the history grow without bound; no reduction inflates per-turn tool output.

**Reduction is deterministic, not optimal.** The bash reducer's head + tail pattern keeps the edges and drops the middle. For some outputs (stack traces, compiler errors), the middle contains the most important information. The reducer does not know this. The model does -- and can request the full output on the next turn. The trade: smaller context per turn at the cost of an occasional follow-up call.

**Compaction loses detail.** A summarised message history is not the original. The model works from a condensed view of early turns. For workflows where early context is load-bearing (long research tasks, multi-step coding sessions), the pressure threshold determines how aggressively compaction fires. The savings come from accepting a lossy representation of old turns.

**Filtering limits flexibility.** A personality that declares five tools cannot call the other thirty-five even if the task demands it. This is the design -- personality toolsets are an explicit constraint. The cost saving is a side effect of the safety and focus benefits of toolset gating.

**Telemetry requires SQLite.** The cache hit rate and per-session cost figures are only available when using the SQLite session store (`@ethosagent/session-sqlite`). The in-memory session store used in tests does not persist usage fields.

**All layers are on by default.** The framework chose full defense over configurability. Operators who want raw, unreduced tool output (for debugging or auditing) can disable specific reducers by not registering them in wiring, but there is no global "disable all cost optimization" switch -- and intentionally so. The cost of a naive loop compounds faster than most operators expect; the default should be safe, not flexible.

## See also

- [Why is there an 80k tool result budget?](tool-result-budget.md) -- the per-call budget split in detail
- [Why does tool progress have an audience field?](audience-boundary.md) -- the orthogonal question of what the model sees vs. what the user sees
- [Tool interface reference](../reference/tool-interface.md) -- `maxResultChars` and `ToolResultReducer` fields
- [ToolRegistry reference](../reference/tool-registry.md) -- `executeParallel` and reduction pipeline
- [Architecture in 90 seconds](../../getting-started/architecture-90-seconds.md) -- where these layers sit in the turn cycle
