---
title: "Why is the personality wired into the loop, frozen and kept as a directory?"
description: "How a personality reaches the loop, why its schema is frozen, why a directory."
kind: explanation
audience: developer
updated: 2026-11-03
---

## Context

This page covers how a personality reaches the AgentLoop and why its shape is fixed.

## Discussion

### How the wiring threads a personality into the loop

`AgentLoopConfig` (see `packages/core/src/agent-loop.ts`) takes a `PersonalityRegistry`, not a single personality. The registry is the source of truth — `loadFromDirectory` discovers personalities, `get(id)` returns one, `getDefault()` returns the active default. `AgentLoop.run()` resolves the active personality from `opts.personalityId` or the default, then uses it to:

- Filter the visible toolset (`personality.toolset?.length ? personality.toolset : undefined`)
- Build the MCP server allowlist (`personality.mcp_servers ?? []`)
- Build the plugin allowlist (`personality.plugins ?? []`)
- Resolve the per-personality `fs_reach` into a `ScopedStorage`
- Apply `personality.context_engine` and `context_engine_options` to compaction
- Apply `personality.safety.injectionDefense` to untrusted-output handling
- Apply `personality.streamingTimeoutMs` to the LLM watchdog

The CLI's `apps/ethos/src/wiring.ts` and the shared `packages/wiring/src/index.ts` are where this assembly happens. The point worth noticing: `AgentLoop` knows nothing about how the personality got loaded. The registry is an interface; the file-system implementation is one choice. The same loop runs against an in-memory registry in tests with no special wiring.

### The schema is FROZEN — what the comment in the source says

`packages/types/src/personality.ts` opens with a comment block that is more important than it looks:

```
// Phase 30.8 — this schema is FROZEN.
//
// Adding a top-level field to `PersonalityConfig` requires:
//   1. A CHANGELOG entry justifying why it isn't a skill, a tool, or a memory section.
//   2. The `personality-schema-change` label on the PR.
//   3. Two-maintainer approval (enforced via branch protection).
//   4. Bumping the count in `.personality-field-count` at the repo root.
```

The mechanical CI gate (`packages/types/src/__tests__/personality-field-count.test.ts`) parses the interface and fails if the count drifts. Culture sets the rule; CI enforces it. The combination is what keeps the schema small even as the project grows.

The "common rejections" comment is below the freeze notice — the four categories already listed (voice modes, emotion tags, response templates, channel UI). They sit in the source as a reminder to the next contributor reaching for "just one more field".

### Why a directory and not a database row

A personality is a directory because:

You can read it. `cat ~/.ethos/personalities/reviewer/SOUL.md` is a complete answer to "what does the reviewer do". That answer survives `grep`, `diff`, code review, and `git log`. A database row is a query away from being readable, and the query never survives a migration.

You can version it. Commit the directory to a repo and the personality your team uses is in source control alongside the code it operates on. There is no separate "personality database" to back up, restore, or replicate across machines.

You can swap the backend without changing the contract. `PersonalityRegistry` is an interface; `FilePersonalityRegistry` is one implementation. A remote registry that fetches personalities from a service is the same contract with a different `loadFromDirectory`. The data model — an identity, a config, a toolset, and a memory scope derived from the id — is what's invariant.

You can hand-edit it. `SOUL.md` is markdown. `config.yaml` is `key: value` YAML. `toolset.yaml` is a flat list. No GUI, no admin panel, no migration tool — the file is the source of truth.

## Trade-offs

See [Trade-offs](../personality-as-architecture.md#trade-offs) on [Why is personality architecture, not a system prompt?](../personality-as-architecture.md).

## See also

- [Why is personality architecture, not a system prompt?](../personality-as-architecture.md) — the parent page.
