---
title: plan
sidebar_position: 1
---

# Plan

> Write a markdown plan into `~/.ethos/plans/` without executing any of it. Pure planning mode.

## What it does

`plan` is the agent's "stop and think" gate. When the user asks for a plan, or when a request has 3+ distinct tasks, this skill produces a personality-scoped markdown plan and stops the turn — no execution.

Plans are written to `~/.ethos/plans/<personality>/<slug>.md`. They survive session restarts and are greppable from any future session, so the planning artifact persists beyond the chat history.

## When the agent uses it

- The user said "plan this" / "let's plan" / "lay out the steps before we start".
- The user is about to make a non-trivial change and explicit alignment is helpful.
- The agent self-invokes when a request has three or more distinct tasks.

## Prerequisites

| Requirement | How to install / configure | Verify |
|---|---|---|
| `read_file` tool | Built-in | `ethos personality show <id>` lists it under toolset |
| `write_file` tool | Built-in | Same |
| `todo` tool *(optional)* | Built-in once Phase: tool_todo lands | Same |

## Default personalities

This skill is enabled by default for: `engineer`, `reviewer`, `coordinator`. Opt out by removing `read_file` or `write_file` from the personality's `toolset.yaml`.

## How it works

1. Reads `~/.ethos/plans/<personality>/` to avoid duplicating in-flight plans with the same slug.
2. Drafts a plan with sections: Goal, Approach, Steps, Risks, Open questions.
3. Writes to `~/.ethos/plans/<personality>/<slug>.md`.
4. Prints the plan path; **stops the turn** — does not execute.
5. (If the `todo` tool is available) Offers to convert plan steps to a todo list in one call.

## Related skills

- [`writing-plans`](./writing-plans) — companion meta-skill that teaches the shape of a good plan file.
- [`spike`](./spike) — when "plan" is the wrong tool because the question is "is this even feasible?".

## Configuration

None. The skill auto-derives the slug from the request and writes to the personality-scoped plans directory.

## Examples

**User:** "Plan how we're going to add rate limiting to the API."

**Agent:**
1. Checks `~/.ethos/plans/engineer/` for `rate-limit*` — none found.
2. Writes `~/.ethos/plans/engineer/api-rate-limit.md` with goal, approach, 5 numbered steps, 2 risks, 3 open questions.
3. Prints path; stops.

User reviews the plan, edits it, and in the next turn approves: "let's go". The agent reads the plan back and executes step-by-step.

## Troubleshooting

- **Plan was written but the path is wrong.** The personality's `memoryScope` decides whether plans land under `<personality>/` or `global/`. Check the personality config.
- **Agent skipped the plan and started executing.** The skill is gated on `read_file` + `write_file` being in the personality's toolset. Verify the toolset; if both tools are present and the agent still skipped, the user prompt may not have triggered the skill — start with "plan this" explicitly.
