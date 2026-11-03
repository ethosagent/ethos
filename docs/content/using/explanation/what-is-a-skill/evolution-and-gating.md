---
title: "Why can skills evolve from usage, and why are they gated?"
description: "Skill evolution, environment gating, proposal review and per-personality directories."
kind: explanation
audience: user
updated: 2026-11-03
---

## Context

This page covers how skills change over time and what gates them.

## Discussion

### Skills can evolve from usage

Ethos can draft new skills, and rewrites of existing ones, from its own work. Four sources draft them:

| Source | When it drafts |
|---|---|
| Post-turn fork | After a turn, when the [personality's](../what-is-a-personality.md) `config.yaml` sets `skill_evolution.enabled: true`, the turn exceeded `skill_evolution.min_tool_calls`, and `skill_evolution.cooldown_minutes` has passed |
| Chat | When the agent calls `skill_propose` during a conversation |
| Nightly pass | When `ethos nightly` runs, or the scheduled nightly pass if `nightlyPass.enabled: true` |
| Eval | `ethos eval run <tasks.jsonl> --expected <expected.jsonl> --evolve`, or `ethos evolve run` over the last 7 days of sessions |

Every draft becomes a candidate in the [learning inbox](../learning-inbox.md), never a live file. A candidate goes live in one of two ways. A replay against this personality's past tasks can pass and promote it automatically, but only for a skill with `skill_evolution.scope: personality`. Or a human approves it, with `ethos learning approve <id>` or from the web dashboard's Learning page. Approving a candidate whose replay did not pass, or never ran, needs a written reason (`LearningInbox.approve`, `extensions/learning-inbox/src/inbox.ts`). The agent cannot approve its own proposal: `skills_pending_approve` refuses and names those two human paths.

A rewrite replaces the skill it names in `target_file`; it is not added as a second file beside the original. Promotion snapshots the replaced file first, so `ethos learning rollback <id>` can restore it unless someone has edited the file since (`promote.ts`). The older verbs still work as adapters onto the same inbox: `ethos evolve apply <candidate-id | filename>` and `--approve` approve only a candidate whose replay passed, and `--reject` rejects.

### Environment gating

Skills can declare runtime requirements in their frontmatter via the `requires` field (from the OpenClaw compatibility layer). If the requirement is not met, the skill is silently skipped — it never reaches the per-personality filter.

Available requirement types:

| Field | Semantics |
|---|---|
| `requires.env` | Environment variables that must be set |
| `requires.bins` | Binaries that must be on `PATH` |
| `requires.anyBins` | At least one of the listed binaries must be present |
| `os` | Operating system constraint (`linux`, `macos`, `windows`) |

Example frontmatter:

```yaml
metadata:
  openclaw:
    requires:
      env: [SLACK_BOT_TOKEN]
      bins: [curl]
    os: [linux, macos]
```

The check runs at discovery time, before safety scanning and before the per-personality capability filter. A skill that requires `SLACK_BOT_TOKEN` on a machine where that variable is unset disappears from the pool entirely — no personality ever sees it.

### Reviewing proposals in the web dashboard

The web dashboard (launched via `ethos serve`) has a **Learning** page that lists every candidate, skill and Expression alike, with its evidence, diff, replay scorecard and timeline. Its decisions go through the same learning inbox, so the same override rule applies: on a candidate that has not passed a replay, the button reads **Approve anyway…** and requires a reason. The Skills page's **Evolver** tab keeps configuration and run history; its **Approval queue** tab is a link to the Learning page, filtered to skills. A personality's Living Soul section still drafts and applies Expression changes, and links to that personality's waiting candidates. In a terminal, `ethos learning list` and `ethos learning show <id>` show the same candidates.

### Per-personality skills directories

A personality directory can contain its own `skills/` subdirectory. Skills under `~/.ethos/personalities/<id>/skills/` are loaded unfiltered for that personality — the per-personality filter does not apply because the user has already declared the binding by placing the file there.

This is the path for role-specific guidance the user does not want polluting the global pool. A `reviewer/skills/our-coding-conventions.md` applies only to the reviewer and does not need to declare `required_tools: [read_file]` to pass the filter. The directory placement is the binding.

## Trade-offs

See [Trade-offs](../what-is-a-skill.md#trade-offs) on [Why skills, separate from tools and personalities?](../what-is-a-skill.md).

## See also

- [Why skills, separate from tools and personalities?](../what-is-a-skill.md) — the parent page.
