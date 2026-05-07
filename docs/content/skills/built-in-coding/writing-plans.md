---
title: writing-plans
sidebar_position: 2
---

# Writing Plans

> Meta-skill that teaches the agent the shape of a good Ethos plan file. Improves every subsequent `plan` invocation.

## What it does

`writing-plans` is advisory — it has no tool of its own. It loads alongside [`plan`](./plan) and shapes every plan the agent writes to match the Ethos plan template (the same template used in `plan/*.md` across the Ethos repo).

Without this skill, plans drift in shape: some have decisions logs, some don't; some have sequencing blocks, some don't. With this skill, every plan has the same seven sections in the same order — making them greppable, auditable, and consistent across personalities and sessions.

## When the agent uses it

- Loaded automatically when [`plan`](./plan) is loaded — they're a pair.
- The user asks "write a plan in the project's standard format".

## Prerequisites

None. Advisory skill, no tools required.

## Default personalities

Enabled for: `engineer`, `reviewer`, `coordinator` (same as `plan`).

## How it works

The skill body is a spec. The seven sections it enforces:

1. **Header** — title and one-blockquote summary.
2. **Status** — status legend at the top, or per-section markers (🔲 / ⏳ / ⚠️ / ✅ / ❌).
3. **Body** — the actual proposal: motivation, design, sub-sections.
4. **Sequencing** — rollout order, numbered or in a phase table.
5. **Acceptance gate** — verifiable items that must be true before the plan is "done".
6. **Decisions log** — every non-obvious decision: `| Date | Decision | Rationale |`.
7. **Session log** — append-only record of when work happened.

It also enforces:
- File path conventions (`plan/<topic>.md` for repo plans; `~/.ethos/plans/<personality>/<slug>.md` for personal).
- Cross-link conventions (relative paths, no absolute URLs).
- A `## Sources` section when external research was involved.

## Related skills

- [`plan`](./plan) — the companion that actually writes the plan file.

## Configuration

None.

## Examples

When `plan` produces a draft, `writing-plans` ensures every section is present. If the agent forgets the "Risks" section, the meta-skill nudges it back in. Status emojis are picked from the legend rather than improvised.

## Troubleshooting

- **My plans don't have a session log.** That's fine for a brand-new plan — the session log is append-only as work happens. If you've been running on the plan and there's still no entry, the agent isn't updating it; remind it.
- **The format is too rigid for my use case.** The skill is opt-in; remove `writing-plans` from your personality's enabled set (or fork it into your own `~/.ethos/skills/writing-plans/` and edit it there).
