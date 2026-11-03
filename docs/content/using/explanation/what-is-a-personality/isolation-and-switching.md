---
title: "Why is personality isolation enforced, not advised?"
description: "Registry-level isolation, why a directory, what a switch changes, and the cost."
kind: explanation
audience: user
updated: 2026-11-03
---

## Context

This page covers how isolation between personalities is enforced and what a switch changes.

## Discussion

### Isolation enforced, not advised

The personality boundary is not a recommendation. Several mechanisms enforce it at runtime:

- `toolset.yaml` is filtered at the [tool registry](../../../getting-started/glossary.md#tool-registry). Tools not in the list are invisible to the LLM and rejected on execution.
- `fs_reach` is enforced by a `ScopedStorage` decorator around the file tools. Paths outside the allowlist throw `BoundaryError`. A researcher's `read_file` cannot peek at the engineer's `MEMORY.md`.
- `mcp_servers` is default-deny. A globally configured MCP server is invisible to a personality unless that personality lists it.
- `plugins` is default-deny. An installed plugin is dormant until at least one personality opts in.
- [Skills](../what-is-a-skill.md) are filtered by capability and by environment requirements. A skill declaring `requires.env: [SLACK_BOT_TOKEN]` or `requires.bins: [curl]` in its frontmatter is silently skipped for any personality running in an environment where those are unavailable.
- Memory is always per-personality. Each personality reads and writes `~/.ethos/personalities/<id>/MEMORY.md` automatically — the engineer's running context never leaks into the reviewer's.

The combined effect: switching to the reviewer is not "the same agent with a smaller prompt". It is a different agent that cannot do the things it should not do.

This matters operationally. A prompt-injection attack that tells a reviewer "now edit this file" cannot succeed regardless of how persuasive the injected payload is, because the write tool is not in the toolset and is not in the registry. The model can refuse a request, but more importantly, the framework refuses it before the model even sees the tool. Defence in depth, with the depth being structural.

### The enforcement is at the registry, not in the prompt

A subtle property of how the toolset works: the agent does not "decide" to honour it. The `DefaultToolRegistry.toDefinitions(allowedTools)` call returns only the tool definitions the personality has in its allowlist — the LLM never sees the existence of tools outside that set. The model cannot ask for a tool it cannot see.

A defensive second check runs at execution time. `executeParallel` rejects any tool call whose name is not in the personality's allowlist with `is_error: true`. The mechanism keeps the Anthropic message contract intact — every `tool_use` block needs a matching `tool_result` block — even when the tool is structurally forbidden.

The combined effect: a personality with a five-tool list literally cannot call a sixth tool, regardless of how the prompt is crafted. The boundary is the registry; the prompt is the explanation.

### Why a directory of files, not a row in a database

Three reasons.

You can read it. A personality is plain text. You can `cat SOUL.md`, `grep` your toolsets, `diff` two versions, commit the directory to a repo, and review a personality change in code review. Memory you cannot read is memory you cannot trust; the same logic applies to identity.

You can version it. A team shares personalities by committing them to the repo. The reviewer personality your team uses for code review is in source control next to the code it reviews. There is no separate "personality database" to back up.

You can swap the backend without changing the contract. `PersonalityRegistry` is an interface in `@ethosagent/types`. `FilePersonalityRegistry` is the default; a remote registry, a database-backed one, or a hot-reloading network share are straight implementations. The data model — three files and a toolset — does not change.

### The whole-system property

Personalities are the unit at which several otherwise-disconnected concerns get joined: identity, tool access, MCP token scope, memory layout, model routing. Each of these concerns is its own subsystem, with its own interface in `@ethosagent/types` — `LLMProvider`, `ToolRegistry`, `MemoryProvider`, the registry itself. None of them know about the others.

What ties them together is the personality. The agent loop reads the active personality once at the start of a turn and uses it to parameterise every subsystem call: which model to ask, which tools to expose, which memory directory to read. Subsystems stay decoupled; the personality is the binding point.

This is the practical answer to "why not split the dimensions into separate config files". You can edit each subsystem's behaviour independently — swap the LLM provider, change the session backend, replace the memory provider — and nothing about the personality file format changes. The personality is the *role*, not the wiring.

### What stays the same across a switch

Some things are *not* personality-scoped, on purpose. Switching personalities does not change:

- The current [session](../../../getting-started/glossary.md#session) and its history. The thread continues; the next message reaches a different role.
- Your `USER.md`. Who you are is a person fact, not a role fact. `USER.md` is keyed by user (at `~/.ethos/users/<userId>/USER.md`), not by personality.
- LLM credentials. Personalities pick a model; the keys to call the model live in `~/.ethos/config.yaml`.
- The CLI surface and channel adapters. Telegram and Discord do not reload when you switch personalities.

The boundary the personality controls is "what the agent does and says". The boundary it does not control is "who you are and where you are". Those distinctions keep the user in continuous control of the session even while the role shifts.

### The cost of getting personality right

A framework that makes personality cheap to define makes personality easy to multiply. That sounds good and is partly a trap. A personality you defined for a one-off use case is one more thing to maintain, one more entry in `/personality list`, one more directory under `~/.ethos/`. The cost is small, but it is not zero.

The rule of thumb that has held up: a personality earns its place when it answers the key questions distinctly. If it would use the same tools as `engineer` and the same model as `engineer`, with only the prompt differing, it is probably a [skill](../../../getting-started/glossary.md#skill) that loads under `engineer` — not a personality of its own. The dimensions test is the gate.

### Personalities can learn from usage

A personality can opt into skill evolution. When `skill_evolution.enabled: true` is set in the personality's `config.yaml`, a post-turn fork reviews turns that made at least `skill_evolution.min_tool_calls` successful tool calls, outside `skill_evolution.cooldown_minutes`, and the nightly pass drafts skills from the personality's recent sessions. Each draft becomes a candidate in the [learning inbox](../learning-inbox.md), not a live file. It goes live only after a replay against this personality's past tasks scores `pass` and the auto-promotion rules allow it, or when a human approves it.

The `engineer` built-in ships with skill evolution enabled by default. This is how a personality adapts to the user's working patterns without the user writing skill files by hand.

Skill evolution does not change the personality's three files. The proposed skills are [skills](../what-is-a-skill.md) — standing instructions under the personality, not modifications to the personality itself. The personality stays frozen; its guidance library grows. See the [personality config reference](../../reference/personality-yaml.md) for the full set of `skill_evolution.*` fields.

### Glossary first, definition next

`personality` is the canonical term throughout the docs. The glossary entry at [Personality](../../../getting-started/glossary.md#personality) defines it tersely. This page is the long form. Other pages link back here when they need to refer to "what a personality really is" rather than just "the personality config".

When you see `~/.ethos/personalities/<id>/` in code or docs, that is what is meant: the directory at that path, with the three files inside it. The `id` is the directory name; it is what `/personality <id>` switches to; it is what `personality.id` reads in code.

### Where the schema sits in the codebase

`PersonalityConfig` is declared in `packages/types/src/personality.ts`. It has zero runtime dependencies — the type-only package can be imported from anywhere in the monorepo without dragging in concrete code. This is the same property that lets `LLMProvider`, `SessionStore`, and `MemoryProvider` be implemented in any package: the contract lives in a place that costs nothing to depend on.

The registry that resolves a personality lives at `extensions/personalities/src/index.ts`. It implements the `PersonalityRegistry` interface, loads from disk via a `Storage` (the abstraction over filesystem I/O), and caches by file fingerprint. Tests use an `InMemoryStorage` to populate fixtures without touching disk; production uses `FsStorage`.

The shape of this layering — interface in `@ethosagent/types`, default implementation in `extensions/`, injection at the wiring layer — is a recurring pattern. The personality is one example of it; the LLM provider, session store, and memory provider are the others. Read one and you have read the shape of all four.

## Trade-offs

See [Trade-offs](../what-is-a-personality.md#trade-offs) on [Why is personality the unit, not a system prompt?](../what-is-a-personality.md).

## See also

- [Why is personality the unit, not a system prompt?](../what-is-a-personality.md) — the parent page.
