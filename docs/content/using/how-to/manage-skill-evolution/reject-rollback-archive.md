---
title: "Manage skill evolution: reject, roll back and archive"
description: "Reject drafted skills, roll back a promotion, decide on the web, and archive unused skills"
kind: how-to
audience: user
time: "5 min"
updated: 2026-11-03
---

## Task

Reject drafted skills you do not want, undo a promotion you regret, and archive skills you no longer use.

## Result

Rejected drafts stay on record as `rejected`, a rolled-back promotion has its previous file back, and archived skills stop loading.

## Prereqs

- Complete [part 1](../manage-skill-evolution.md): you can run `ethos learning list` and at least one candidate exists or has been promoted.

## Steps

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

Start the dashboard with `ethos serve`. Open **Learning** in the Library section of the sidebar. Its count shows candidates a replay has measured that now wait on you.

The page groups candidates into **Needs review**, **Waiting for replay**, **Promoted**, and **Rejected & rolled back**. Select one to see its evidence, its diff, its replay scorecard with the dry-run caveat beside the numbers, and its timeline.

| Button | Shown when | What it does |
|---|---|---|
| **Approve** | Waiting, verdict `pass` | Promotes the candidate. |
| **Approve anyway…** | Waiting, any other verdict | Asks for a reason. **Approve anyway** stays disabled until you type one. |
| **Reject…** | Waiting, `invalid` or `stale` | Rejects, with an optional reason. |
| **Run replay** | Waiting | Replays now, the same as `ethos learning replay <id>`. |
| **Rollback** | Promoted | Rolls back, with an optional reason. When rollback is not allowed, it is disabled and the reason is shown beside it. |

The Skills page's **Approval queue** tab approves nothing. It links to this page, filtered to skill candidates.

### 8. Archive skills you no longer use

```bash
ethos evolve archive --older-than 30
```

```text
archived 2 skills to .archive/2026-09-13/
```

This moves `~/.ethos/skills/*.md` files last modified more than 30 days ago into `~/.ethos/skills/.archive/<date>/`, with a `manifest.json`. It goes by file modification time, not by use. Skill discovery skips dot-directories, so archived files stop loading. To restore one, move it back to `~/.ethos/skills/`.

## Verify

```bash
ethos learning list --all
```

A rejected candidate shows status `rejected`, and a rolled-back one shows a rolled-back status. Archived skills no longer appear in `ethos skills list`.

## Troubleshoot

**Rollback refuses with `live_edited`.** Someone edited the skill after it was promoted. Rollback never overwrites a hand edit. Edit the file yourself.
