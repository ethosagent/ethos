---
title: "CLI: skill history and lock commands"
description: "ethos skills history, diff, restore, lock and release: a version timeline and a per-skill lock for flat skill files."
kind: reference
audience: user
updated: 2026-11-28
---

## Synopsis {#synopsis}

Commands for the version timeline and the lock of flat [skill](../../../getting-started/glossary.md#skill) files: `~/.ethos/skills/<id>.md`, or `~/.ethos/personalities/<pid>/skills/<id>.md` with `--personality <pid>`. Skills installed as `<slug>/SKILL.md` directories are not covered. Part of the [CLI reference](../cli.md) and of `ethos skills`.

Synopsis: `ethos skills <history | diff | restore | lock | unlock> <id> [--personality <pid>] [--json]`

## ethos skills history {#ethos-skills-history}

`history <id>` lists every version, oldest first: version id, source, actor, and the first 8 characters of the hash. A skill edited outside Ethos gets an `external` row the first time anyone looks. Ethos keeps the last 50 versions per skill.

| Source | Written by |
|---|---|
| `learning` | A learning candidate promoted by a replay pass or an approval |
| `learning-rollback` | `ethos learning rollback` |
| `web-edit` | An edit, create or delete on the web Skills page |
| `web-import` | Attaching a library skill to a personality |
| `restore` | `restore`, or **Restore** on the web |
| `external` | An edit made outside Ethos |

## ethos skills diff {#ethos-skills-diff}

`diff <id> <a> [<b>]` prints a line diff from version `a` to version `b`; `b` defaults to the live file. `-` lines are only in `a`, `+` lines only in `b`. A version id or any unique prefix of one works.

## ethos skills restore {#ethos-skills-restore}

`restore <id> <versionId>` writes that version back as a new `restore` version. Nothing is rewritten in place, and a deleted skill can be restored from its last version.

## ethos skills lock and unlock {#ethos-skills-lock}

`lock <id>` refuses every agent-authored write to the skill: a draft, a nightly draft, an auto-promotion, and your own approval of an agent draft (`ethos learning approve` answers `locked` and the candidate keeps waiting). You can still edit a locked skill and restore a version. `unlock <id>` allows agent writes again. The lock lives in `.history/<id>/lock.json` beside the skill.

| Flag | Meaning |
|---|---|
| `--personality <pid>` | Act on that personality's own skill instead of the shared one |
| `--json` | Print one JSON document, `{"ok": true, ...}` or `{"ok": false, "error": {...}}` |

## Examples {#examples}

```bash
ethos skills history tidy --json
ethos skills diff tidy 20261128T131707            # that version against the live file
ethos skills restore tidy 20261128T131707
ethos skills lock tidy --personality coach
```

```text
restored tidy to 20261128T131707.351Z-f1181ae0 (new version 20261128T132456.164Z-f1181ae0)
```

Exit code is `0` on success and `1` when the skill or version is not found or the id is invalid. With `--json`, a refusal prints `{"ok": false, "error": {"code": "NOT_FOUND" | "INVALID_INPUT", "message": ...}}`.

Source: [`apps/ethos/src/commands/skills-history.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/skills-history.ts), [`extensions/skills/src/skill-history.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/skills/src/skill-history.ts).

## See also {#see-also}

- [Review, undo and lock a skill](../../how-to/review-and-lock-skills.md)
- [CLI: batch, eval, evolve, learning and plugin commands](evolve-and-learn.md#ethos-skills)
- [Manage skill evolution](../../how-to/manage-skill-evolution.md)
