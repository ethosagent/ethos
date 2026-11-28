---
name: initiative-setup
description: Set up or change an initiative, a standing outcome the agent explores on its own within a budget. Pre-fills from memory and sessions, shows one summary, and saves only after one yes.
version: 1.0.0
author: ethosagent
tags: [personal, initiatives, interview, budget]
required_tools: [initiative_define]

ethos:
  category: personal
  default_personalities: []
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: [memory_read, session_search]
  integrates_with:
    - tool: initiative_define
      role: "the only way an initiative is saved or changed. Call it once, with `confirmed: true`, after the user said yes to the summary. Never hand-write the YAML."
  surface_metadata:
    invocation_trigger: "the user wants the agent to keep working on an outcome over days ('keep an eye on', 'dig into', 'work on this in the background'); or you notice a recurring area with no initiative"
    estimated_turns: "2-4"
---

# Initiative setup

An initiative is an outcome you explore on your own, in short windows, inside a budget the user sets. You read; you never write, send or execute. Your job here is to turn a loose wish into one saved initiative with one yes.

## Pre-fill first

Before you ask anything, look: memory, recent sessions, and the user's message. Fill every field you can. Show what you found ("From memory: you own self-serve activation; last week's sessions were about the signup funnel"). Ask only what you cannot work out. Never ask the user to restate something they already told you.

## What it always settles

1. **Outcome.** One sentence: what should be true or known at the end.
2. **Sources and off-limits.** Where you may read, and what is excluded. A source is one of `sessions`, `kanban`, `memory`, `web`, `slack_read`, or `{ repo: '<path>' }` for a repo. Anything else is not a source.
3. **Budget.** `usd_per_day`, `usd_per_exploration`, `max_open_explorations`, inside the operator ceiling. Say the ceiling when you propose numbers. If they ask for more, say no and name the ceiling.
4. **Autonomy.** `ask` (every exploration needs a yes), `free_under` (you proceed under a dollar threshold), or `free`. Suggest `free_under` with `ask_above_usd: 1`. Say what each costs them in interruptions.
5. **Timeline.** How many days, when the windows run, when you review with them.
6. **Delivery.** Which channel and what time the digest goes.
7. **Seed ideas.** Explorations they already want. You turn these into the first proposals.
8. **Guidance.** Standing rules in their words ("skip anything about pricing"). Each is mapped to a tool, or reported back as `unreachable` or `refused`.

## One summary, one yes

Do not ask field by field. Send one summary with every value, mark which ones you inferred, and ask one question: "Save this?" On a clear yes, call `initiative_define` with `confirmed: true`. On anything else, adjust and show the summary again. Never call it with `confirmed: true` before a yes in this turn.

## Changing an existing initiative

- **Budget, sources or autonomy changes need a yes.** They change what you spend or can reach. Show before and after side by side, for example `budget.usd_per_day: $2 -> $4`, `sources: [sessions] -> [sessions, { repo: ~/code/app }]`, `autonomy: ask -> free_under $1`. Then ask, then call with `confirmed: true`.
- **Wording changes save directly.** Title, outcome text, guidance wording, notes. Say what you changed afterwards.
- A change that mixes both counts as needing a yes.

## Sources you cannot reach

If a source or guidance entry comes back `unreachable` (for example `slack_read`, because no Slack read tool exists), say so plainly, and never claim you read it. Offer a reachable source or save with the gap named. A `refused` entry is the same: state it and leave it out.

## When to offer one unprompted

Offer once, in one sentence at the end of a reply, when the user keeps returning to an area across sessions (a metric, a repo, a market) and no initiative covers it. Do not offer in group rooms, during another task's setup, or after a no in this conversation. Never start one without their yes.
