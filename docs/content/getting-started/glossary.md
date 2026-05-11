---
title: "Glossary"
description: "Every Ethos domain term in one place: personality, skill, tool, hook, mesh, session, memory scope, audience boundary, storage scope, plugin, adapter, gateway."
kind: reference
audience: shared
slug: glossary
updated: 2026-05-12
---

Every domain term used elsewhere in the docs has one canonical entry here. Pages link to the entry on first use. The list is alphabetical inside each cluster; clusters are ordered by how often a newcomer hits them.

## Core agent model

<dl>

<dt id="agent">Agent</dt>
<dd>A running instance of the Ethos runtime under one personality. Receives user messages, streams typed events back, calls tools, persists session state. Not a class — an outcome of wiring <code>AgentLoop</code> with a personality, an LLM provider, a session store, and a memory provider.</dd>

<dt id="agent-loop">AgentLoop</dt>
<dd>The core abstraction. An <code>AsyncGenerator&lt;AgentEvent&gt;</code> that takes a user message and streams <a href="#agent-event">AgentEvent</a> values until the turn is done. Receives every dependency at construction; never reaches for globals. See <a href="../building/reference/agent-event.md">AgentEvent reference</a>.</dd>

<dt id="agent-event">AgentEvent</dt>
<dd>The streaming event type. Eight variants: <code>text_delta</code>, <code>thinking_delta</code>, <code>tool_start</code>, <code>tool_progress</code>, <code>tool_end</code>, <code>usage</code>, <code>error</code>, <code>done</code>. Every surface (CLI, channel adapter, web UI) consumes this stream and renders what it cares about.</dd>

<dt id="turn">Turn</dt>
<dd>One user message in, one streamed response out. A turn may include multiple <a href="#tool">tool</a> calls executed in parallel, multiple <a href="#hook">hook</a> invocations, and one or more LLM completions. A session is a sequence of turns.</dd>

</dl>

## Personality

<dl>

<dt id="personality">Personality</dt>
<dd>A directory at <code>&#126;/.ethos/personalities/</code> containing three files: <code>ETHOS.md</code> (identity), <code>config.yaml</code> (model and memory scope), <code>toolset.yaml</code> (allowed tools). The unit of architecture in Ethos. Switching personalities atomically changes prompt, tools, memory scope, and model. See <a href="../using/explanation/what-is-a-personality.md">Why is personality the unit?</a>.</dd>

<dt id="built-in-personality">Built-in personality</dt>
<dd>One of the five personalities Ethos ships by default: <code>researcher</code>, <code>engineer</code>, <code>reviewer</code>, <code>coach</code>, <code>operator</code>. Each has a distinct role, toolset, and voice. See <a href="../using/explanation/built-in-personalities.md">What are the built-in personalities?</a>.</dd>

<dt id="ethos-md">ETHOS.md</dt>
<dd>The first-person identity file inside a personality directory. Defines who the agent is, how it speaks, and what it is for. Loaded as the system prompt baseline; combined at runtime with memory context and personality config.</dd>

<dt id="memory-scope">Memory scope</dt>
<dd>A field in a personality's <code>config.yaml</code> controlling whether its agent reads and writes the shared user-default memory files (<code>MEMORY.md</code>, <code>USER.md</code>) or a personality-scoped copy. Lets the reviewer have a different running context than the engineer without leaking either to the other.</dd>

<dt id="fs-reach">fs_reach</dt>
<dd>The per-personality filesystem allowlist. A list of absolute or glob paths a personality's file tools may read or write. Default-deny: anything not listed is unreachable. Surfaces as a <code>BoundaryError</code> when violated.</dd>

</dl>

## Tools, hooks, registries

<dl>

<dt id="tool">Tool</dt>
<dd>An action the agent can call during a turn. Implements the <code>Tool&lt;TArgs&gt;</code> interface from <code>@ethosagent/types</code>. Has a name, a typed argument schema, a <code>maxResultChars</code> cap, and an <code>execute</code> function returning a <code>ToolResult</code>. See <a href="../building/reference/tool-interface.md">Tool interface reference</a>.</dd>

<dt id="tool-registry">ToolRegistry</dt>
<dd>The runtime registry of available tools. Filters the visible tool set by personality (only tools in the personality's <code>toolset.yaml</code> are exposed to the LLM). Executes tools in parallel under a result budget. See <a href="../building/reference/tool-registry.md">ToolRegistry reference</a>.</dd>

<dt id="tool-result">ToolResult</dt>
<dd>The return type of a tool's <code>execute</code>: either <code>&#123; ok: true, value: string &#125;</code> or <code>&#123; ok: false, error: string, code: string &#125;</code>. Failures still produce a <code>tool_result</code> in the LLM history — every <code>tool_use</code> needs a matching <code>tool_result</code>.</dd>

<dt id="tool-result-budget">Tool result budget</dt>
<dd>The total character budget for tool output in one turn (default 80,000). Split evenly across the tool calls in the turn. Each call is post-trimmed and marked <code>[truncated]</code> if it exceeds its share. Tools may declare a lower <code>maxResultChars</code> to opt into stricter limits.</dd>

<dt id="hook">Hook</dt>
<dd>A registration point for cross-cutting behaviour fired at a fixed boundary in the turn cycle (<code>session_start</code>, <code>before_prompt_build</code>, <code>before_tool_call</code>, <code>after_tool_call</code>, <code>agent_done</code>). Three execution models — Void, Modifying, Claiming — depending on what the hook does. See <a href="../building/explanation/hook-execution-models.md">Why three hook execution models?</a>.</dd>

<dt id="audience-boundary">Audience boundary</dt>
<dd>The <code>audience</code> field on tool progress events. <code>'internal'</code> (default) is consumed by the framework only — logs, telemetry, dev TUI. <code>'user'</code> is rendered by surface code (CLI, channel adapters). Tools opt into <code>'user'</code> per-event for long-running operations where silent latency would confuse the reader.</dd>

</dl>

## Sessions, memory, storage

<dl>

<dt id="session">Session</dt>
<dd>The persistent conversation history identified by a session key. CLI sessions key on <code>cli:&lt;cwd-basename&gt;</code> — each working directory has its own conversation. <code>/new</code> appends a timestamp to force a fresh session. Stored in SQLite with WAL and FTS5; <code>getMessages</code> returns the newest N in chronological order.</dd>

<dt id="session-store">SessionStore</dt>
<dd>The interface for session persistence. Default implementation is <code>SQLiteSessionStore</code>. Methods include <code>getMessages(sessionId, &#123; limit &#125;)</code>, <code>addMessage</code>, and history search via FTS5. Pluggable: Redis, Postgres, in-memory implementations are straightforward.</dd>

<dt id="memory">Memory</dt>
<dd>Persistent context across sessions. Two markdown files in <code>&#126;/.ethos/</code>: <code>MEMORY.md</code> (rolling project context) and <code>USER.md</code> (who the user is). Plain text on purpose — the user can read, grep, diff, and commit them.</dd>

<dt id="memory-provider">MemoryProvider</dt>
<dd>The interface for memory backends. Default is <code>MarkdownFileMemoryProvider</code>. Two methods: <code>prefetch()</code> reads memory into the system prompt; <code>sync(MemoryUpdate[])</code> applies <code>add</code> / <code>replace</code> / <code>remove</code> actions after the turn.</dd>

<dt id="storage">Storage</dt>
<dd>The filesystem-access interface from <code>@ethosagent/types</code>. All reads and writes under <code>&#126;/.ethos/</code> go through it — no raw <code>node:fs</code> in extension code. Three implementations ship: <code>FsStorage</code> (production), <code>InMemoryStorage</code> (tests), <code>ScopedStorage</code> (per-personality allowlist decorator). See <a href="../building/reference/storage-interface.md">Storage interface reference</a>.</dd>

<dt id="storage-scope">Storage scope</dt>
<dd>The per-personality read/write boundary enforced by <code>ScopedStorage</code>. Paths outside the personality's allowlist raise <code>BoundaryError</code>; surfaces translate this into a user-facing tool error. Distinct from <a href="#fs-reach">fs_reach</a> — Storage scope is enforced for framework I/O, fs_reach for the agent's own file tools.</dd>

</dl>

## Multi-agent

<dl>

<dt id="mesh">Mesh</dt>
<dd>A configuration of multiple personalities that can pass work to each other under a <a href="#supervisor">supervisor</a>. The mesh model lets a researcher hand findings to a reviewer or an engineer without merging their toolsets. See <a href="../building/explanation/teams-and-meshes.md">When should you use a mesh?</a>.</dd>

<dt id="supervisor">Supervisor</dt>
<dd>The personality at the top of a mesh that decides which other personality handles the next message. Picks routing based on message content, prior turn outcomes, or explicit user direction.</dd>

</dl>

## Channels and platforms

<dl>

<dt id="channel-adapter">Channel adapter</dt>
<dd>An implementation of <code>PlatformAdapter</code> that bridges a messaging platform (Telegram, Discord, Slack, the CLI) to the agent. Sends user messages in, renders the <a href="#agent-event">AgentEvent</a> stream out. Adapters do not implement their own deduplication — the gateway provides it.</dd>

<dt id="gateway">Gateway</dt>
<dd>The runtime layer between channel adapters and <code>AgentLoop</code>. Routes inbound messages to the correct session, dedupes outbound messages (30-second TTL, keyed by <code>(sessionId, sha256(content))</code>), and fans events out to the right adapter.</dd>

</dl>

## Skills and plugins

<dl>

<dt id="skill">Skill</dt>
<dd>A markdown file with frontmatter defining a reusable agent capability (a prompt with required tools, optional tags). Discovered from multiple ecosystems: Claude Code (<code>&#126;/.claude/skills/</code>), OpenClaw (<code>&#126;/.openclaw/skills/</code>), OpenCode, Hermes, Ethos-native. Filtered per personality by tool reach.</dd>

<dt id="plugin">Plugin</dt>
<dd>A packaged set of tools, hooks, and / or providers shipped as an npm module implementing <code>EthosPlugin</code>. Registered at wiring time; declares which tools, hooks, and providers it adds. Subject to the personality's plugin allowlist (default-deny).</dd>

</dl>

## See also

- [What is Ethos?](what-is-ethos.md) — the 90-second mental model
- [Architecture in 90 seconds](architecture-90-seconds.md) — how the pieces fit
- [Why Ethos?](why-ethos.md) — positioning vs other frameworks
