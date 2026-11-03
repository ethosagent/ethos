---
title: "Why are plugins default-deny, and where do identity and skills sit?"
description: "Default-deny plugins and MCP, SOUL.md identity, and the skills layer."
kind: explanation
audience: developer
updated: 2026-11-03
---

## Context

This page covers what a personality allows, what it leaves out, and how skills sit beneath it.

## Discussion

### Plugins and MCP servers are default-deny

A globally configured MCP server in `~/.ethos/mcp.json` is invisible to a personality unless that personality's `mcp_servers` list names it. An installed plugin from `extensions/plugin-loader` is dormant for a personality unless the personality's `plugins` list opts in.

This is a deliberate inversion of the "if it's installed, the agent can use it" default in most frameworks. The personality is the gate. A user who installs a database MCP server does not implicitly hand database access to every personality; the `engineer` declares `mcp_servers: [postgres]` to opt in, and the `researcher` simply does not. Same machine, same installed servers, different reach per role.

The mechanism is the same registry filter that gates tools. `DefaultToolRegistry.toDefinitions(allowedTools, { allowedMcpServers, allowedPlugins })` builds the per-turn tool list from three allowlists in one pass. The LLM never sees an MCP tool from an unauthorised server; `executeParallel` rejects calls outside the allowlist with `code: 'not_available'`.

The CLAUDE.md note labels the convention: missing or empty means no access. There is no "default-allow when unset"; the absence of a list is itself a decision.

### What the personality does not control

Some boundaries are *not* personality-scoped, on purpose. Switching personalities does not change:

- The current [session](../../../getting-started/glossary.md#session) and its history. The thread continues; the next message reaches a different role.
- `USER.md`, when the surface knows who you are. A turn that carries a `userId` reads your profile from the `user:<userId>` scope, which no personality owns (`userScopeId` in `packages/core/src/agent-loop/stages/context-assembly.ts`); the gateway passes the sender's id. A turn without one reads `USER.md` from the personality's own scope, so in `ethos chat`, which passes none, it does change.
- LLM credentials. Personalities pick a model; the keys live in `~/.ethos/config.yaml`.
- The CLI surface and channel adapters. Telegram and Discord do not reload when you `/personality researcher`.

The personality controls "what the agent does and says". The boundary it does not control is "who you are and where you are". Those distinctions keep the user in continuous control of the session while the role shifts beneath them.

### Identity is in the `SOUL.md`, not the schema

A subtle property of the design is what *isn't* in `PersonalityConfig`. There is no `tone`, no `style`, no `personality_traits`. The agent's voice and reasoning style live in `SOUL.md` — markdown, first-person, opinionated. The schema is the structural surface; the prose is the identity.

This split is load-bearing. A future you can read `SOUL.md` and reason about who the agent is. A future you can read `config.yaml` and reason about what the agent can touch. Mixing them — putting "be concise" alongside `fs_reach` — would smear the boundary; structural and behavioural concerns would interleave on every page of the spec.

The cost is `SOUL.md` carries the load of being readable, opinionated, and concrete. The CLAUDE.md note labels the convention: *first-person identity (who am I, how do I speak)*. A vague `SOUL.md` produces vague behaviour. The reviewer's `SOUL.md` reads "I am a critical, evidence-based reviewer. I cite specific lines. I refuse to soften concerns to be polite." Not "you are a careful reviewer". The grammatical first person is harder for the model to argue itself out of.

### The skills layer sits underneath, not inside

A common confusion: "is a [skill](../../../getting-started/glossary.md#skill) part of a personality?" The answer is no — skills are discovered globally and filtered per personality by tool reach.

`extensions/skills/` scans `~/.ethos/skills/` plus the Claude Code and project skill directories (`~/.claude/skills/`, `<cwd>/.claude/skills/`, `<cwd>/.opencode/skills/`) into a global skill pool. Other tools' home directories (`~/.openclaw/skills/`, `~/.hermes/skills/`) join the pool only when a caller opts in with `externalSources` (`extensions/skills/src/universal-scanner.ts`). For each personality, an ingest filter checks whether each skill's `required_tools` are a subset of the personality's effective tool reach (`extensions/skills/src/ingest-filter.ts`). The researcher sees skills whose required tools are read/search/browse; the engineer sees skills that touch write/run/test; the reviewer does not see skills that need write tools. A skill that declares no `required_tools` passes this check by default (`fallback_unknown` defaults to `allow`).

This means a skill that needs `write_file` does not load under `reviewer`. The skill is the same file on disk, but the per-personality filter makes it invisible to roles that lack the tools to execute it. The personality is the gate; the skill is the reusable capability that passes through it.

One directory skips the tool-reach filter. When a personality directory has a `skills/` subdirectory, the loader records it as `skillsDirs`, and `SkillsInjector.resolveSkills` (`extensions/skills/src/skills-injector.ts`) loads every skill in it for that personality alone.

### Skill evolution and the personality lifecycle

A personality can change after you write it. The agent drafts skills from its own work and can revise the Expression region of its `SOUL.md`. The structure decides where those changes land and who lets them in.

The `skill_evolution` block on `PersonalityConfig` turns drafting on. With `enabled: true`, the post-turn improvement fork (`extensions/skill-evolver/src/improvement-fork.ts`) runs after a turn with at least `min_tool_calls` successful tool calls (default 5), at most once per `cooldown_minutes` (default 60) for each personality. It can propose a new skill or an update to one. All three user-facing built-ins ship with it enabled.

`skill_evolution.scope` decides where a promoted skill lives. `liveSkillDir` (`extensions/skill-evolver/src/skill-dir.ts`) is the one function that maps it: `shared`, the default, writes to `~/.ethos/skills/`, where every personality whose tool reach matches can load it; `personality` writes to `~/.ethos/personalities/<id>/skills/`, which only that personality loads.

Nothing drafted goes live directly. Every draft becomes a candidate in the [learning inbox](../../../using/explanation/learning-inbox.md) (`extensions/learning-inbox`). A candidate is promoted on a human approval, or on a `pass` replay when the auto-promotion rules allow it. Those rules (`autoPromotionDecision` in `extensions/learning-inbox/src/auto-promotion.ts`) never auto-promote a shared skill: a replay tests one personality, and a shared skill reaches all of them.

Expression revisions keep their history in the personality directory. `FilePersonalityRegistry.evolveExpression` (`extensions/personalities/src/index.ts`) snapshots the previous Expression to `.expression-history/<revision-id>.md` before it rewrites `SOUL.md`, and `revertExpression` restores from those snapshots.

Ethos does not track skill usage per personality, and nothing ranks or recommends skills by use. The observability store counts skill exposures and `get_skill` invocations for the whole deployment, grouped by skill with no personality breakdown (`skillCounts` in `extensions/observability-sqlite/src/store.ts`, read by `ethos usage`). No code feeds those counts back into which skills load.

## Trade-offs

See [Trade-offs](../personality-as-architecture.md#trade-offs) on [Why is personality architecture, not a system prompt?](../personality-as-architecture.md).

## See also

- [Why is personality architecture, not a system prompt?](../personality-as-architecture.md) — the parent page.
