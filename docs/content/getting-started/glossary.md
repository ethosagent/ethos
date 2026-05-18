---
title: "Glossary"
description: "Every Ethos domain term in one place: personality, skill, tool, hook, mesh, session, memory, audience boundary, storage, plugin, adapter, gateway."
kind: reference
audience: shared
slug: glossary
updated: 2026-05-12
---

Every domain term used elsewhere in the docs has one canonical entry here. Pages link to the entry on first use. The list is alphabetical inside each cluster; clusters are ordered by how often a newcomer hits them.

## Synopsis {#synopsis}

Single canonical home for every Ethos domain term. Each entry: one-sentence definition + anchor link from other pages on first use. Entries are grouped into seven clusters — agent / personality / tools / sessions / multi-agent / channels / skills — ordered roughly by how soon a newcomer hits them.

## Core agent model {#core-agent-model}

### Agent {#agent}

A running instance of the Ethos runtime under one personality. Receives user messages, streams typed events back, calls tools, persists session state. Not a class — an outcome of wiring `AgentLoop` with a personality, an LLM provider, a session store, and a memory provider.

### AgentLoop {#agent-loop}

The core abstraction. An `AsyncGenerator<AgentEvent>` that takes a user message and streams [AgentEvent](#agent-event) values until the turn is done. Receives every dependency at construction; never reaches for globals. See [AgentEvent reference](../building/reference/agent-event.md).

### AgentEvent {#agent-event}

The streaming event type. Eight variants: `text_delta`, `thinking_delta`, `tool_start`, `tool_progress`, `tool_end`, `usage`, `error`, `done`. Every surface (CLI, channel adapter, web UI) consumes this stream and renders what it cares about.

### Turn {#turn}

One user message in, one streamed response out. A turn may include multiple [tool](#tool) calls executed in parallel, multiple [hook](#hook) invocations, and one or more LLM completions. A session is a sequence of turns.

### LLM provider {#llm-provider}

The abstraction the [AgentLoop](#agent-loop) calls to perform inference. Implements `LLMProvider` from `@ethosagent/types`: a `name`, a `model` id, and a streaming `complete()` method that returns `AsyncIterable<CompletionChunk>`. Built-ins cover Anthropic, OpenAI-compatible endpoints (OpenRouter, Ollama, Gemini), and Azure OpenAI; custom providers ship via plugin and register through `registerLLMProvider`. Personalities select a provider via the `provider:` field in `config.yaml` and route specific tiers via `model: { trivial, default, deep }`. See [Write an LLM provider plugin](../building/how-to/write-an-llm-provider-plugin.md).

## Personality {#personality}

### Personality {#personality}

A directory at `~/.ethos/personalities/` containing three files: `ETHOS.md` (identity), `config.yaml` (model and memory scope), `toolset.yaml` (allowed tools). The unit of architecture in Ethos. Switching personalities atomically changes prompt, tools, memory scope, and model. See [Why is personality the unit?](../using/explanation/what-is-a-personality.md).

### Built-in personality {#built-in-personality}

One of the five personalities Ethos ships by default: `researcher`, `engineer`, `reviewer`, `coach`, `operator`. Each has a distinct role, toolset, and voice. See [What are the built-in personalities?](../using/explanation/built-in-personalities.md).

### ETHOS.md {#ethos-md}

The first-person identity file inside a personality directory. Defines who the agent is, how it speaks, and what it is for. Loaded as the system prompt baseline; combined at runtime with memory context and personality config.

### Memory scope {#memory-scope}

A field in a personality's `config.yaml` controlling whether its agent reads and writes the shared user-default memory files (`MEMORY.md`, `USER.md`) or a personality-scoped copy. Lets the reviewer have a different running context than the engineer without leaking either to the other.

### fs_reach {#fs-reach}

The per-personality filesystem allowlist. A list of absolute or glob paths a personality's file tools may read or write. Default-deny: anything not listed is unreachable. Surfaces as a `BoundaryError` when violated.

## Tools, hooks, registries {#tools-hooks-registries}

### Tool {#tool}

An action the agent can call during a turn. Implements the `Tool<TArgs>` interface from `@ethosagent/types`. Has a name, a typed argument schema, a `maxResultChars` cap, and an `execute` function returning a `ToolResult`. See [Tool interface reference](../building/reference/tool-interface.md).

### ToolRegistry {#tool-registry}

The runtime registry of available tools. Filters the visible tool set by personality (only tools in the personality's `toolset.yaml` are exposed to the LLM). Executes tools in parallel under a result budget. See [ToolRegistry reference](../building/reference/tool-registry.md).

### ToolResult {#tool-result}

The return type of a tool's `execute`: either `{ ok: true, value: string }` or `{ ok: false, error: string, code: string }`. Failures still produce a `tool_result` in the LLM history — every `tool_use` needs a matching `tool_result`.

### Tool result budget {#tool-result-budget}

The total character budget for tool output in one turn (default 80,000). Split evenly across the tool calls in the turn. Each call is post-trimmed and marked `[truncated]` if it exceeds its share. Tools may declare a lower `maxResultChars` to opt into stricter limits.

### Hook {#hook}

A registration point for cross-cutting behaviour fired at a fixed boundary in the turn cycle (`session_start`, `before_prompt_build`, `before_tool_call`, `after_tool_call`, `agent_done`). Three execution models — Void, Modifying, Claiming — depending on what the hook does. See [Why three hook execution models?](../building/explanation/hook-execution-models.md).

### Audience boundary {#audience-boundary}

The `audience` field on tool progress events. `'internal'` (default) is consumed by the framework only — logs, telemetry, dev TUI. `'user'` is rendered by surface code (CLI, channel adapters). Tools opt into `'user'` per-event for long-running operations where silent latency would confuse the reader.

## Sessions, memory, storage {#sessions-memory-storage}

### Session {#session}

The persistent conversation history identified by a session key. CLI sessions key on `cli:<cwd-basename>` — each working directory has its own conversation. `/new` appends a timestamp to force a fresh session. Stored in SQLite with WAL and FTS5; `getMessages` returns the newest N in chronological order.

### SessionStore {#session-store}

The interface for session persistence. Default implementation is `SQLiteSessionStore`. Methods include `getMessages(sessionId, { limit })`, `addMessage`, and history search via FTS5. Pluggable: Redis, Postgres, in-memory implementations are straightforward.

### Memory {#memory}

Persistent context across sessions. Two markdown files in `~/.ethos/`: `MEMORY.md` (rolling project context) and `USER.md` (who the user is). Plain text on purpose — the user can read, grep, diff, and commit them.

### MemoryProvider {#memory-provider}

The interface for memory backends. Default is `MarkdownFileMemoryProvider`. Two methods: `prefetch()` reads memory into the system prompt; `sync(MemoryUpdate[])` applies `add` / `replace` / `remove` actions after the turn.

### Storage {#storage}

The filesystem-access interface from `@ethosagent/types`. All reads and writes under `~/.ethos/` go through it — no raw `node:fs` in extension code. Three implementations ship: `FsStorage` (production), `InMemoryStorage` (tests), `ScopedStorage` (per-personality allowlist decorator). See [Storage interface reference](../building/reference/storage-interface.md).

### Storage scope {#storage-scope}

The per-personality read/write boundary enforced by `ScopedStorage`. Paths outside the personality's allowlist raise `BoundaryError`; surfaces translate this into a user-facing tool error. Distinct from [fs_reach](#fs-reach) — Storage scope is enforced for framework I/O, fs_reach for the agent's own file tools.

## Secrets {#secrets}

### Secret {#secret}

Sensitive material Ethos needs at runtime — provider API keys, channel bot tokens, integration credentials. Referenced in `config.yaml` as `${secrets:<ref>}` placeholders and resolved at startup against a precedence chain of backends (`.env`, process env, AWS Secrets Manager, on-disk files). See [Secrets resolver reference](../using/reference/secrets-resolver.md).

### Secret ref {#secret-ref}

The forward-slash-delimited path that identifies a secret, e.g. `providers/anthropic/apiKey` or `channels/telegram/default/botToken`. The resolver passes the ref to each backend in order; the first non-null value wins. Backend-specific naming (env-style uppercase keys, AWS prefixed secret names) is derived from the ref.

## Multi-agent {#multi-agent}

### Mesh {#mesh}

A configuration of multiple personalities that can pass work to each other under a [supervisor](#supervisor). The mesh model lets a researcher hand findings to a reviewer or an engineer without merging their toolsets. See [When should you use a mesh?](../building/explanation/teams-and-meshes.md).

### Supervisor {#supervisor}

The personality at the top of a mesh that decides which other personality handles the next message. Picks routing based on message content, prior turn outcomes, or explicit user direction.

### Team {#team}

A named set of personalities that coordinate through a shared kanban board. A team supervisor process dispatches tickets to members based on each member's toolset and current workload; results land back on the kanban for review. Contrast with [mesh](#mesh): teams coordinate by claiming work from a visible board, meshes coordinate by routing messages through a [supervisor](#supervisor). See [When should you use a mesh?](../building/explanation/teams-and-meshes.md).

## Channels and platforms {#channels-platforms}

### Channel adapter {#channel-adapter}

An implementation of `PlatformAdapter` that bridges a messaging platform (Telegram, Discord, Slack, the CLI) to the agent. Sends user messages in, renders the [AgentEvent](#agent-event) stream out. Adapters do not implement their own deduplication — the gateway provides it.

### Gateway {#gateway}

The runtime layer between channel adapters and `AgentLoop`. Routes inbound messages to the correct session, dedupes outbound messages (30-second TTL, keyed by `(sessionId, sha256(content))`), and fans events out to the right adapter.

## Skills and plugins {#skills-plugins}

### Skill {#skill}

A markdown file with frontmatter defining a reusable agent capability (a prompt with required tools, optional tags). Discovered from multiple ecosystems: Claude Code (`~/.claude/skills/`), OpenClaw (`~/.openclaw/skills/`), OpenCode, Hermes, Ethos-native. Filtered per personality by tool reach.

### Plugin {#plugin}

A packaged set of tools, hooks, and / or providers shipped as an npm module implementing `EthosPlugin`. Registered at wiring time; declares which tools, hooks, and providers it adds. Subject to the personality's plugin allowlist (default-deny).

### Skin {#skin}

A named visual theme resolved against `@ethosagent/design-tokens`. Built-in skins ship with the CLI (`default`, `mono`, `paper`); user skins can be added via plugins. Wired into both the TUI `SkinContext` and the Web `ConfigProvider` so every surface picks up the same palette. Set once per user via `skin:` in `~/.ethos/config.yaml` — a personality is an identity, not a theme, so skins are not a personality concern.

## See also {#see-also}

- [What is Ethos?](what-is-ethos.md) — the 90-second mental model
- [Architecture in 90 seconds](architecture-90-seconds.md) — how the pieces fit
- [Why Ethos?](why-ethos.md) — positioning vs other frameworks
