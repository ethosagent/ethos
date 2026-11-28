---
title: "Review, undo and lock a skill"
description: "See every version of a skill and who wrote it, diff two versions, restore an old one, and lock a skill so agents cannot change it."
kind: how-to
audience: user
slug: review-and-lock-skills
time: "10 min"
updated: 2026-11-28
---

## Task

See what changed in a [skill](../../getting-started/glossary.md#skill) (a markdown instruction file the agent loads when relevant), undo a change you regret, and protect a skill you wrote by hand from every agent write.

## Result

Each flat skill has a timeline: every version, who wrote it and how. A restore brings an old version back as a new version, so nothing is lost. A locked skill refuses every change an agent drafts, including a draft you approve yourself. You can still edit it.

## Prereqs

- `ethos` installed ([Install and use skills](use-skills.md)).
- At least one flat skill file: `~/.ethos/skills/<id>.md`, or `~/.ethos/personalities/<personality-id>/skills/<id>.md` for a skill that belongs to one personality. Skills installed as `<slug>/SKILL.md` directories keep the version history of their source and are not covered here.

Every version records one source:

| Source | Written by |
|---|---|
| `learning` | A learning candidate that was promoted, by a replay pass or your approval |
| `learning-rollback` | `ethos learning rollback` putting the previous file back |
| `web-edit` | An edit, create or delete on the web Skills page |
| `web-import` | Attaching a library skill to a personality on the web |
| `restore` | A restore from this page or `ethos skills restore` |
| `external` | An edit made outside Ethos, in an editor or a shell. Ethos records it the next time anyone looks |

Ethos keeps the last 50 versions of each skill.

## Steps

### 1. List the versions

```bash
ethos skills history tidy
```

```text
tidy
  20261128T131707.351Z-f1181ae0  external          external   f1181ae0
  20261128T132108.810Z-db3a64d4  learning          cli        db3a64d4 l-3de356d66a76cf43
```

Oldest first. A hand-written skill starts with one `external` row, its baseline. Add `--personality <personality-id>` for a personality's own skill, and `--json` for scripts.

### 2. Diff two versions

```bash
ethos skills diff tidy 20261128T132108 20261128T131707
```

```text
--- 20261128T132108.810Z-db3a64d4
+++ 20261128T131707.351Z-f1181ae0
-name: rewrite-tidy-1
-description: "tighter"
+name: tidy
+description: "Keep answers short"
 ---
 
-Keep answers very short.
+Keep answers short.
```

Lines starting with `-` are in the first version only, `+` in the second only. Leave out the second version to compare against the live file. Any unique prefix of a version id works.

### 3. Restore a version

```bash
ethos skills restore tidy 20261128T131707
```

```text
restored tidy to 20261128T131707.351Z-f1181ae0 (new version 20261128T132456.164Z-f1181ae0)
```

The old bytes become the live file, recorded as a new `restore` version. The versions before it stay as they were.

### 4. Lock a skill

```bash
ethos skills lock tidy
```

```text
locked tidy — agents can no longer change it; you still can
```

While a skill is locked:

- `skill_propose` and `ethos evolve` refuse or skip a rewrite of it.
- A learning candidate that rewrites it cannot be promoted by a replay, by `ethos learning approve`, or from the web. The candidate stays waiting.
- You can still edit it on the web, in an editor, and restore a version.

Unlock it with `ethos skills unlock tidy`, then approve the waiting candidate again.

### 5. Do the same on the web

Start the dashboard with `ethos serve` and open **Skills**. Each skill row has a **Lock** switch and a **History** button with its version count. **History** lists the versions newest first with a chip for how each was written. Pick **From** and **To** on any two rows to see their diff. **Restore** asks first, then writes the old version back as a new one. The newest version has no **Restore**, because it is already live.

A personality's own skills, under **Skills** in that personality's workspace, have the same controls.

## Verify

Lock a skill, then try to approve a draft that rewrites it:

```bash
ethos skills lock tidy
ethos learning approve <candidate-id> --override "smoke test"
```

```text
not approved <candidate-id> — tidy is locked — unlock it on the Skills page or with `ethos skills unlock tidy`
```

The file is unchanged and `ethos learning list` still shows the candidate.

## Troubleshoot

**`No skill "tidy".`** — `lock`, `restore` and `history` need a flat skill file. Check the spelling, or add `--personality <personality-id>` when the skill lives under a personality.

**`No version "…". List them with: ethos skills history <id>`** — The id is not in the timeline, or it was pruned after 50 newer versions. Copy an id from `ethos skills history`.

**`Version "…" is ambiguous; use more of its id.`** — The prefix matches more than one version. Use more characters.

**`Invalid skillId: "Tidy"`.** — Skill ids are lowercase letters, digits, `_` and `-`, the same rule as every other id. A file named `Tidy.md` loads as a skill but has no history or lock; rename it to `tidy.md`.

**An edit you made in an editor shows as `external`, not as your name.** — Ethos cannot see who edited a file outside it. It records the new bytes as `external` the next time anyone runs `history` or writes the skill.

**A shell tool changed a locked skill.** — The lock stops agent-authored content that goes through the learning inbox. A personality with a shell tool on local execution can still edit the file directly. Ethos records that edit as `external` the next time anyone looks; it does not prevent it.

## See also

- [Manage skill evolution](manage-skill-evolution.md)
- [Install and use skills](use-skills.md)
- [CLI: skill history and lock commands](../reference/cli/skills-history.md)
- [Why does a learned change need a replay before it goes live?](../explanation/learning-inbox.md)
