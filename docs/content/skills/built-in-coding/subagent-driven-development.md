---
title: subagent-driven-development
sidebar_position: 10
---

# Subagent-Driven Development

> Decompose a multi-part task across team members; each subagent owns one piece; coordinator reviews + integrates. Two-stage review is mandatory. Coordinator-only — uses `dispatch_team`.

## What it does

This skill is the prose teaching of Ethos's `dispatch_team` pattern. The coordinator decomposes a multi-part task into independent subtasks, dispatches them in parallel where possible, then reviews and integrates the returns. A two-stage review (subagent self-review then coordinator review) is enforced — no rubber-stamping.

If integration reveals a gap, the skill dispatches a follow-up subtask. **It does not paper over gaps** — papering over is how subagent-driven work degrades.

## When the agent uses it

- The task has 3+ parallelizable parts (e.g. research + scope + implement + document).
- The coordinator personality is active.
- A team is configured (`~/.ethos/teams/<name>.yaml`) and currently running.

For sequential or two-step tasks, the skill defers — execute directly.

## Prerequisites

| Requirement | How to install / configure | Verify |
|---|---|---|
| `list_team`, `dispatch_team` | Built-in (`@ethosagent/tools-delegation`) | `ethos personality show <id>` |
| Configured team | `~/.ethos/teams/<name>.yaml` | `ethos team list` |
| Team running | `ethos team start <name>` | `ethos team status` |
| Coordinator personality | Use one of the built-in coordinators or define your own | `ethos personality show <id>` |

## Default personalities

Enabled for: `coordinator` only. The skill is fundamentally orchestration-shaped; workers do not decompose.

## How it works

1. **Confirm a team is available** via `list_team`. Cross-reference the capabilities you need against what's exposed.
2. **Decompose**: write the subtask map before dispatching. One owner per subtask, one deliverable per subtask, named dependencies.
3. **Dispatch**: `dispatch_team({ subtasks: [...] })`. Subtasks with no dependencies run in parallel.
4. **Two-stage review**:
   - Stage 1: each subagent self-reviews before returning.
   - Stage 2: coordinator reviews each return + integrates.
5. **Integration**: if a gap appears, dispatch a follow-up. Never paper over.
6. **Synthesize**: produce one coherent output for the user.

## Related skills

- [`coding-agent`](./coding-agent) — when the right move is to delegate a single big chunk to an external CLI rather than fan out to team members.

## Configuration

The skill reads team config from `~/.ethos/teams/`. To change which capabilities are available, edit the team YAML and restart with `ethos team start <name>`.

## Examples

**User:** "Build an end-to-end report on our product analytics pipeline: data sources, schema, dashboard, gaps."

**Agent (coordinator):**
1. `list_team` — confirms `researcher`, `data-engineer`, `analyst`, `writer` are present.
2. Decomposes:

   | Subtask | Owner | Deliverable | Depends on |
   |---|---|---|---|
   | Inventory data sources | researcher | sources.md | — |
   | Document schemas | data-engineer | schema.md | — |
   | Audit dashboards | analyst | dashboards.md | — |
   | Write final report | writer | report.md | All three |

3. Dispatches the first three in parallel, then writer once their returns are reviewed.
4. Reviews each: notes that researcher missed an internal source the data-engineer mentioned. Dispatches a follow-up to researcher to cover it.
5. Once the gap is filled, hands integrated bundle to the writer.
6. Returns one coherent report to the user.

## Troubleshooting

- **"No team is configured."** Start one: `ethos team start <name>`. Verify with `ethos team status`.
- **"Capability X not available."** The team you started doesn't expose that capability. Edit the team YAML to include it, or pick a different team.
- **The coordinator integrated subagent returns without reviewing.** That's a bug — file an issue. The skill enforces stage-2 review.
- **Integration revealed a gap and the agent papered over it.** Same — bug. The skill should dispatch a follow-up. File an issue.
