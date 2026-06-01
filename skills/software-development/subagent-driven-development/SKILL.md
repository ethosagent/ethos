---
name: subagent-driven-development
description: Decompose a multi-part task across team members; each subagent owns one piece; coordinator reviews and integrates. Two-stage review (subagent self-review then coordinator review) is mandatory. Coordinator-only — uses dispatch_team.
version: 1.0.0
author: ethosagent
tags: [coding, orchestration, teamwork]
required_tools: [list_team, dispatch_team]

ethos:
  category: delegation-and-orchestration
  default_personalities: [coordinator]
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: [route_to_agent, broadcast_to_agents, memory_write]
  integrates_with:
    - tool: dispatch_team
      role: parallel dispatch with typed inputs/outputs — the engine of this skill
    - tool: list_team
      role: confirm capability availability before dispatching
  surface_metadata:
    invocation_trigger: "task has 3+ parallelizable parts; coordinator personality is active and a team is configured"
    estimated_turns: "1-3 from coordinator perspective; team members run in parallel"
---

# Subagent-Driven Development

Coordinator-only skill. Decompose, dispatch, integrate. Make heavy use of `dispatch_team` so the work runs in parallel.

## When to use this skill

- The task has three or more parallelizable parts (e.g. research + scope + implement + document).
- The coordinator personality is active and a team is configured (`~/.ethos/teams/<name>.yaml`).
- The team has been started (`ethos team start <name>`).

When the task is sequential (each step depends on the previous one) or has only one or two parts, **do not** dispatch — execute directly.

## Step 1 — confirm a team is available

```
list_team()
```

If the result is empty or doesn't include the capabilities you need, stop and tell the user: "no team is configured for this. Start a team with `ethos team start <name>`."

Cross-reference the capabilities each team member exposes with the subtasks you're about to create. If a capability is missing, tell the user before dispatching — don't paper over with a worker that doesn't have the right tools.

## Step 2 — decompose the task

Write the decomposition out before dispatching. Each subtask:

1. **Has a single owner.** One member, one task. If two members both need it, the task is wrong.
2. **Has a single deliverable.** A file, a JSON object, a paragraph — something concrete.
3. **Names its dependencies.** "Subtask B depends on Subtask A's output" is a sequencing constraint; flag it.

A good decomposition fits in a small table:

| Subtask | Owner (capability) | Deliverable | Depends on |
|---|---|---|---|
| Research X | `researcher` | summary.md | — |
| Scope the API | `architect` | api-shape.md | Research X |
| Implement | `engineer` | feature/<files> | Scope the API |
| Document | `writer` | docs/<page>.md | Implement |

## Step 3 — dispatch

Use `dispatch_team` with the subtask map. Subtasks with no dependencies go in the first batch (they run in parallel). Dependent subtasks go in subsequent batches.

```
dispatch_team({
  subtasks: [
    { capability: 'researcher', input: { ... } },
    { capability: 'architect', input: { ... } },
  ],
})
```

## Step 4 — two-stage review

**Stage 1 — subagent self-reviews before returning.** Each member, before reporting back, asks itself: "would I accept this if I received it as a coordinator?" Members that haven't passed their own review must not return.

**Stage 2 — coordinator reviews each return + integrates.** Don't merge subagent outputs blindly. For each return:

- Did the deliverable match the requested shape?
- Are the dependencies satisfied?
- Does the integrated output make sense as a whole?

If integration reveals a gap (e.g. researcher's summary missed a fact the architect needs), **dispatch a follow-up subtask** for that gap. **Do not paper over it** — that's how subagent-driven work degrades.

## Step 5 — synthesize

Collect all returns. Produce one integrated output for the user. The user should see one coherent answer, not a stack of independently-returned packets.

## Hard rules

- **Coordinator-only.** Workers cannot decompose. If the active personality is not the coordinator, this skill should not be invoked.
- **One subtask, one capability, one deliverable.** Multi-deliverable subtasks are decomposition failures.
- **Two-stage review is non-negotiable.** A coordinator that merges without reviewing is a coordinator that rubber-stamps.
- **No papering over integration gaps.** If integration reveals a gap, dispatch a follow-up.
