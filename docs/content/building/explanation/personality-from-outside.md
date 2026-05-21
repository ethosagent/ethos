---
title: "Why can a dashboard read a personality but not expand its toolset?"
description: "What an external dashboard can read about a personality, what it cannot change, and why the toolset boundary matters for UI rendering."
kind: explanation
audience: developer
slug: personality-from-outside
updated: 2026-05-13
---

## Context

A [personality](../../getting-started/glossary.md#personality) is a structural unit that binds prompt, tools, memory scope, and model into one configuration. [Personality is architecture](personality-as-architecture.md) explains the internal design. This page is about the external surface: what a Mission Control dashboard can observe through the SDK, and where the boundaries are.

## What a dashboard can read

The `personalities` namespace in the contract exposes three read operations that matter for dashboard rendering:

**`personalities.list`** returns every personality with its `id`, `name`, `description`, `model`, `memoryScope`, and `toolset` array. A dashboard uses this to populate a picker — the user selects which personality to chat with or inspect.

**`personalities.get`** takes a personality `id` and returns the full `PersonalityConfig` plus the raw Markdown body of `SOUL.md`. A dashboard can render the identity document directly — it is Markdown, designed to be read.

**`personalities.characterSheet`** takes a personality `id` and returns a generated Markdown character sheet — the same artifact `ethos personality show` prints in the CLI. This is the canonical one-screen summary of what a personality is: identity, model routing, memory scope, toolset, MCP servers, plugins, filesystem reach. The sheet is regenerated on each call via `renderCharacterSheet` in `@ethosagent/personalities`; it reflects the current on-disk state, not a cached snapshot.

A dashboard that wants to show "who is this personality" renders the character sheet. A dashboard that wants to let a user edit a personality reads `get` and presents the fields.

## What a dashboard cannot change

Toolset enforcement is server-side. `DefaultToolRegistry.toDefinitions(allowedTools)` in `packages/core/src/tool-registry.ts` filters which tool definitions the LLM sees, and `executeParallel` rejects calls outside the allowlist. The personality's `toolset` array declares which tool names are permitted.

A dashboard receives the `toolset` array from `personalities.get`, but listing tools in a response does not grant them. A malicious or buggy dashboard cannot expand a personality's capabilities by sending tool names that are not in the allowlist — the server-side registry ignores them. The enforcement is at the `AgentLoop` level: `agent-loop.ts` reads `personality.toolset` and passes it to `toDefinitions`. Tools outside the list produce an error `tool_result` with `is_error: true`.

This means a dashboard UI should display the toolset as a read-only badge list, not an editable checklist, unless the dashboard is specifically designed as a personality editor. Even then, saving a modified toolset through `personalities.update` only takes effect after the agent loop re-reads the personality — the running session's tool gate does not change mid-turn.

## Why toDefinitions matters for UI

When a dashboard renders a personality's capabilities, it should show the tools the personality *actually has access to*, not every tool registered in the system. The `toolset` array from `personalities.get` is the authoritative list.

Built-in tools are gated by exact name match against `allowedTools`. MCP and plugin tools are gated separately through `passesFilter()` — their names are dynamic (`mcp__<server>__<tool>`) and matched against the personality's `mcp_servers` and `plugins` arrays rather than the toolset.

A dashboard that wants to show "this personality can use: read_file, write_file, bash" reads `personality.toolset`. A dashboard that wants to show "this personality has access to MCP server X" reads `personality.mcp_servers`. The two filtering paths are independent.

## The SOUL.md boundary

`SOUL.md` is the first-person identity document — "who am I, how do I speak." A dashboard can read it via `personalities.get` and display it. A dashboard can write to it via `personalities.update` with the `soulMd` field.

The content of `SOUL.md` flows into the agent's system prompt. A dashboard that edits it is editing the personality's identity. This is powerful and intentional — the web UI is the editor for personality identity. But it also means a dashboard must treat `SOUL.md` as a privileged write. Validation is minimal (it is free-form Markdown); the governance constraint is social, not mechanical.

## Skills per personality

Each personality can have its own skill library, separate from the global `~/.ethos/skills/` directory. The contract exposes CRUD operations: `skillsList`, `skillsGet`, `skillsCreate`, `skillsUpdate`, `skillsDelete`, and `skillsImportGlobal` (which copies global skills into the personality's local skill directory).

A dashboard that manages per-personality skills uses these endpoints. The skills are Markdown files with optional YAML frontmatter. Importing a global skill does not create a live link — it copies the content at the time of import. Subsequent edits to the global skill do not propagate.

## Memory scope from a dashboard perspective

A personality's `memoryScope` field (`'global'` or `'per-personality'`) determines whether MEMORY.md and USER.md are shared across personalities or scoped to each one. A dashboard displaying memory content needs to know which personality is active and what its scope is, because the same `memory.get` call returns different content depending on the active personality's scope setting.

The SDK's `memory` namespace handles scoping server-side — a dashboard does not construct file paths or manage directories. But a dashboard that lets users switch personalities should re-fetch memory content after the switch, since the backing file may differ.

## Create, duplicate, delete

The contract supports full lifecycle management for personalities. `personalities.create` takes an `id` (lowercase, directory-safe), `name`, `toolset` array, and `soulMd` body. `personalities.duplicate` clones an existing personality to a new `id`. `personalities.delete` removes it.

These mutations affect the on-disk personality directory under `~/.ethos/personalities/`. The `FilePersonalityRegistry` is mtime-cached — it re-reads a personality only when `config.yaml` changes. A dashboard that creates or updates a personality sees the change reflected immediately in subsequent `list` or `get` calls because the server writes the file and the next registry load picks it up.

## Summary of boundaries

| Operation | Dashboard can | Dashboard cannot |
|---|---|---|
| List personalities | Yes — `personalities.list` | |
| Read identity | Yes — `get` returns SOUL.md | |
| Read character sheet | Yes — `characterSheet` returns the generated summary | |
| Edit identity | Yes — `update` with `soulMd` | |
| See toolset | Yes — `toolset` array in the response | |
| Expand toolset at runtime | | No — server-side enforcement in `toDefinitions` |
| Manage per-personality skills | Yes — `skillsList`, `skillsCreate`, etc. | |
| Change model routing mid-turn | | No — read at loop construction |
