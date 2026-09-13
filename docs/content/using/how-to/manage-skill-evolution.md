---
title: "Manage skill evolution"
description: "Review, replay, approve, reject and roll back the skills Ethos drafts from its own work, using the learning inbox and the ethos learning CLI."
kind: how-to
audience: user
slug: manage-skill-evolution
time: "10 min"
updated: 2026-09-13
---

## Task

Decide which drafted [skills](../../getting-started/glossary.md#skill) (markdown instruction files the agent loads when relevant) go live, and undo the ones you regret.

## Result

A drafted skill goes live only after it passes a replay against real past tasks, or after you approve it and give a reason that is recorded in the audit log. Drafts you do not want stay on record as `rejected`. A promotion you regret is rolled back to the file that was there before.

## Prereqs

- `ethos` installed and a provider configured ([Configure an LLM provider](configure-providers.md)).
- At least one drafted skill. Drafts come from four places:

| Source | Drafts when |
|---|---|
| Post-turn fork | A turn by a [personality](../../getting-started/glossary.md#personality) (the directory of files that decides the agent's role, tools and voice) with `skill_evolution.enabled: true` made at least `skill_evolution.min_tool_calls` successful tool calls, outside the cooldown |
| Chat | The agent calls `skill_propose` |
| Eval | `ethos evolve run`, or `ethos eval run … --evolve` |
| Nightly pass | `ethos nightly run`, or the schedule when `nightlyPass.enabled: true` |

Every draft lands in one place, the learning inbox, as a *candidate*. For why a replay gates it and what a replay can and cannot measure, read [Why does a learned change need a replay before it goes live?](../explanation/learning-inbox.md).

The per-personality keys, in `~/.ethos/personalities/<id>/config.yaml`:

| Key | Default | Effect |
|---|---|---|
| `skill_evolution.enabled` | `false` | Turns on the post-turn fork for this personality |
| `skill_evolution.min_tool_calls` | `5` | Successful tool calls a turn needs before the fork runs |
| `skill_evolution.cooldown_minutes` | `60` | Minimum minutes between fork runs for this personality, per process |
| `skill_evolution.promotion` | unset | `auto` lets a `pass` promote without you; `review` always waits for you. Unset falls back to `evolution_approval_mode`, then `autoApprove` |
| `skill_evolution.scope` | `shared` | `personality` writes to `~/.ethos/personalities/<id>/skills/`. Only a personality-scoped skill can promote itself; a shared one always needs you |

## Steps

### 1. List waiting candidates

```bash
ethos learning list
```

```text
ID                KIND       PERSONALITY  ORIGIN  STATUS          VERDICT  SUBMITTED
c-mf3k2x-a1b2c3   New skill  engineer     fork    pending_replay  not run  2026-09-12T21:04:11.000Z
c-mf3m9q-d4e5f6   New skill  engineer     eval    pending_review  regress  2026-09-12T22:40:03.000Z
```

Add `--personality <id>` to filter. Add `--all` to include promoted, rejected, `stale` and `invalid` candidates.

### 2. Inspect one

```bash
ethos learning show c-mf3k2x-a1b2c3
```

```text
Learning candidate c-mf3k2x-a1b2c3
  kind:         New skill (skill/create)
  personality:  engineer
  origin:       fork
  status:       pending_replay
  verdict:      not run
  destination:  /Users/you/.ethos/skills/summarize-pr.md
…
Replay scorecard  not run — ethos learning replay c-mf3k2x-a1b2c3
```

The output also shows the evidence the draft came from, the full proposed file, and a timeline of every status change.

### 3. Replay it

Replay runs real models and costs money, capped per candidate by [`learningReplay.maxCostUsd`](../reference/config-yaml.md#learning-replay).

```bash
ethos learning replay c-mf3k2x-a1b2c3
```

```text
Replaying c-mf3k2x-a1b2c3 — baseline and candidate dry runs on every selected case…
Pass · target +0.42 · regressions 0/5 · $0.31 of $0.50 · dry-run: tools stubbed · tested on engineer
waiting for review — …
```

**Replay measures approach, not answers.** Tools are stubbed, so a `pass` says the skill did not make the agent choose worse tools or take a worse approach on familiar tasks. It cannot say whether an answer that depends on real tool output got better.

If the candidate passed, is personality-scoped, and auto-promotion is on, the last line reads `promoted automatically` instead, and you are done.

### 4. Approve it

If the verdict is `pass`, approve it directly:

```bash
ethos learning approve c-mf3k2x-a1b2c3
```

```text
approved c-mf3k2x-a1b2c3 → /Users/you/.ethos/skills/summarize-pr.md
```

If the verdict is anything else (`regress`, `incomplete`, or `not run`), a plain approve is refused:

```text
not approved c-mf3m9q-d4e5f6 — Verdict is regress; approving a candidate that has not passed a replay needs an override reason
Approve anyway with: ethos learning approve c-mf3m9q-d4e5f6 --override "<reason>"
```

Give the reason:

```bash
ethos learning approve c-mf3m9q-d4e5f6 --override "regression is a tone case I accept"
```

```text
approved c-mf3m9q-d4e5f6 → /Users/you/.ethos/skills/lint-fix-loop.md
override recorded: regression is a tone case I accept
```

`ethos evolve apply <candidate-id | filename>` also approves, but only a `pass`.

### 5. Reject what you do not want

```bash
ethos learning reject c-mf3m9q-d4e5f6 --reason "duplicates an existing skill"
```

```text
rejected c-mf3m9q-d4e5f6
```

To reject every skill candidate waiting longer than 7 days, run `ethos evolve prune --older-than 7`. It lists them and asks before rejecting. Nothing is deleted either way.

### 6. Roll back a promotion

```bash
ethos learning rollback c-mf3k2x-a1b2c3 --reason "made reviews too terse"
```

```text
rolled back c-mf3k2x-a1b2c3
```

A rewrite gets its previous file back. A new skill's file is removed.

### 7. Decide on the web instead

Start the dashboard with `ethos serve`. Open the **Skills** page. Its approval queue lists waiting skill candidates with **Approve** and **Reject**. If a candidate has not passed a replay, **Approve** prompts for a required reason before it approves.

The web dashboard has no page yet that shows every candidate, runs a replay, or rolls back. Use `ethos learning` for those.

### 8. Archive skills you no longer use

```bash
ethos evolve archive --older-than 30
```

```text
archived 2 skills to .archive/2026-09-13/
```

This moves `~/.ethos/skills/*.md` files last modified more than 30 days ago into `~/.ethos/skills/.archive/<date>/`, with a `manifest.json`. It goes by file modification time, not by use. Skill discovery skips dot-directories, so archived files stop loading. To restore one, move it back to `~/.ethos/skills/`.

## Verify

Confirm the candidate is live:

```bash
ethos learning list --all --personality engineer
```

```text
ID                KIND       PERSONALITY  ORIGIN  STATUS    VERDICT  SUBMITTED
c-mf3k2x-a1b2c3   New skill  engineer     fork    promoted  pass     2026-09-12T21:04:11.000Z
```

For a shared-scope skill, confirm it loads:

```bash
ethos skills list
```

The skill appears under the `ethos` source.

Confirm your decision was recorded:

```bash
ethos audit decisions --since 1d
```

Each human decision prints one `audit.approval` line with code `learning.approve`, `learning.override`, `learning.reject` or `learning.rollback`. A candidate that promoted itself writes no line here. Its timeline in `ethos learning show <id>` records it instead.

## Troubleshoot

**No candidates appear.** Check that the personality sets `skill_evolution.enabled: true` and that turns reach `skill_evolution.min_tool_calls`. The cooldown lives in the running process, so a restart resets it.

**Files are still in `~/.ethos/skills/pending/` or `skills/.pending/`.** Those folders are retired. On first use the inbox imports their files (and `learning/pending-expression/`) as candidates with origin `legacy`, removes them, and writes `~/.ethos/learning/legacy-import.json`. Run `ethos learning list` to see them.

**The verdict is `incomplete` with too few cases.** The replay needs at least 3 cases, including one past task that is not a target. A personality whose case pool is still empty cannot reach that. Turn on [`nightlyPass.enabled`](../reference/config-yaml.md#nightly-pass) so cases are frozen nightly, or approve with `--override`.

**`replay_unavailable`.** `learningReplay.enabled` is `false` in `~/.ethos/config.yaml`.

**Approve refuses with `stale`.** The live file changed after the draft was made, so the draft no longer applies to it. Reject the candidate.

**Rollback refuses with `live_edited`.** Someone edited the skill after it was promoted. Rollback never overwrites a hand edit. Edit the file yourself.

**The agent says it cannot approve a skill.** That is intended. `skills_pending_approve` refuses in chat, because approval is a human decision. Run `ethos learning approve <id>`.

**An approved skill does not load in chat.** The personality's `toolset.yaml` may not include the skill's `required_tools`. Run `/skills` in chat to see what the personality loads.
