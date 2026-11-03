---
title: "Why does a code-review mesh split writing and reviewing in parallel?"
description: "A worked code-review mesh with parallel writing and reviewing."
kind: explanation
audience: developer
updated: 2026-11-03
---

## Context

This page walks one mesh from the parent page end to end.

## Discussion

### A worked example: code review with parallel writing and reviewing

Concrete scenario. You are chatting with a `coordinator` personality. The user asks "add input validation to the parseConfig function and review the diff".

The coordinator's reasoning at the LLM level:

- The work has two phases that can run in parallel-ish — `engineer` writes the validation, `reviewer` reviews the result.
- Dispatching to a team in parallel is one tool call; the coordinator picks `mixture_of_agents` so both members see the same prompt at once.
- After both return, the coordinator synthesises a reply that includes the diff and the review.

In the agent stream that comes out of `AgentLoop.run()`, the model emits something close to:

```typescript
// One tool_use from the coordinator
{
  tool: 'mixture_of_agents',
  args: {
    prompts: [
      { personality: 'engineer', prompt: 'Add input validation to parseConfig in src/config.ts...' },
      { personality: 'reviewer', prompt: 'Review the input validation added to parseConfig...' },
    ],
  },
}
```

What the framework does:

- `executeParallel` runs `mixture_of_agents` once. Inside, `mixture_of_agents` spawns two child `AgentLoop.run()` calls — one with `engineer`, one with `reviewer`.
- The engineer's child loop reads `src/config.ts`, writes the changes, returns a summary text.
- The reviewer's child loop reads the (just-written) file, evaluates the change, returns a review text.
- The two children complete; `mixture_of_agents` returns a structured `ToolResult` with both replies tagged by personality.
- Back in the coordinator's turn, the LLM sees the structured result and composes a final reply that quotes both children.

The user sees one reply that includes the diff and the review. The framework saw two child loops, each scoped to its own personality. The reviewer's `per-personality` [memory scope](../../../getting-started/glossary.md#memory-scope) means its read-only critique is not coloured by the engineer's in-flight notes; the engineer's writes never see the reviewer's opinions.

This is the headline property of the mesh model. The four dimensions of each personality — prompt, toolset, memory scope, model — apply *inside the child loop*. The engineer's write tools are unavailable in the reviewer's child even though they live in the same mesh, because the reviewer's `toolset.yaml` does not list them. The boundary is structural, not advisory; see [Why is personality architecture?](../personality-as-architecture.md) for the underlying mechanism.

## Trade-offs

See [Trade-offs](../teams-and-meshes.md#trade-offs) on [When should you use a mesh of agents, not one?](../teams-and-meshes.md).

## See also

- [When should you use a mesh of agents, not one?](../teams-and-meshes.md) — the parent page.
