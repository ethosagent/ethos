---
title: Built-in Coding Skills
description: Ten Ethos-native coding skills shipped as a bundle. Categorized into planning, quality, GitHub workflow, and delegation. This page lists what each skill does and what you need to enable it.
sidebar_position: 3
---

# Built-in Coding Skills

Ethos ships a curated bundle of ten coding skills. They're loaded by the universal scanner alongside any skills in `~/.ethos/skills/`, `~/.claude/skills/`, etc. — under the `ethos-bundled` source label.

The bundle covers four categories:

| Category | Skills |
|---|---|
| **Planning & process** | [`plan`](./plan), [`writing-plans`](./writing-plans), [`spike`](./spike) |
| **Quality & testing** | [`tdd`](./tdd), [`code-review`](./code-review), [`systematic-debugging`](./systematic-debugging) |
| **GitHub workflow** | [`github-pr-workflow`](./github-pr-workflow), [`github-code-review`](./github-code-review) |
| **Delegation & orchestration** | [`coding-agent`](./coding-agent), [`subagent-driven-development`](./subagent-driven-development) |

Each skill is opt-in per personality. The default built-in personalities (`engineer`, `reviewer`, `coordinator`) ship with a sensible category set; custom personalities pick what they need.

> **Reviewer ships read-only.** The reviewer personality's `toolset.yaml` deliberately omits `terminal`, `write_file`, and `patch_file` — review is observation, not modification. The skills below list `reviewer` under "Default for" because they're _designed_ for review work, but they only become active for reviewer if you opt that personality into `terminal` (which `code-review` and `github-code-review` need for `git diff` / `gh`). The `Default for` column reflects intent; the capability filter is what enforces availability per turn.

## Prerequisites at a glance

The table answers "what do I need to enable this?". Click a skill name for the deep-dive.

| Skill | Category | Default for | External CLI | Auth | Other tools needed |
|---|---|---|---|---|---|
| [`plan`](./plan) | Planning | `engineer`, `reviewer`, `coordinator` | None | None | `read_file`, `write_file`; optional `todo` |
| [`writing-plans`](./writing-plans) | Planning | `engineer`, `reviewer`, `coordinator` | None | None | (advisory — no tools) |
| [`spike`](./spike) | Planning | `engineer`, `coordinator` | None | None | `read_file`, `write_file`, `terminal`; optional `process` |
| [`tdd`](./tdd) | Quality | `engineer`, `reviewer` | None | None | `read_file`, `write_file`, `patch_file`, `terminal`; optional `run_tests`, `process`, `todo` |
| [`code-review`](./code-review) | Quality | `engineer`, `reviewer` | `git` | None | `read_file`, `terminal`; optional `patch_file` |
| [`systematic-debugging`](./systematic-debugging) | Quality | `engineer`, `reviewer` | None | None | `read_file`, `terminal`, `search_files`; optional `process`, `write_file` |
| [`github-pr-workflow`](./github-pr-workflow) | GitHub | `engineer`, `coordinator` | `gh`, `git` | `gh auth login` | `terminal`, `read_file`, `write_file`; optional `process` |
| [`github-code-review`](./github-code-review) | GitHub | `reviewer`, `engineer` | `gh`, `git` | `gh auth login` | `terminal`, `read_file` |
| [`coding-agent`](./coding-agent) | Delegation | `coordinator` | One of: `claude`, `codex`, `opencode`, `pi` | Per CLI (see page) | `terminal`, `process_start`, `process_logs`, `process_stop` |
| [`subagent-driven-development`](./subagent-driven-development) | Delegation | `coordinator` | None | None | `list_team`, `dispatch_team` |

## How a skill becomes "enabled"

A bundled skill flows to a personality when:

1. The personality's `toolset.yaml` includes every tool listed in the skill's `required_tools` (capability-mode filter).
2. The skill is not blocked by the safety scanner.

This means enabling a skill is usually a matter of giving the personality the right tools. For example, `tdd` requires `terminal`, `read_file`, `write_file`, `patch_file` — any personality that lists those four tools sees `tdd` automatically.

To verify what got enabled for the active personality, check the boot output:

```text
$ ethos chat
Skills loaded: 47 total · 12 visible to engineer
  sources: ethos-bundled (10), claude-code (28), ethos (9)
```

## Where the skills live

The SKILL.md files ship inside Ethos at `extensions/skills-coding/data/<id>/SKILL.md`. The bundle is read-only — to customize a skill, copy it into `~/.ethos/skills/<id>/SKILL.md` and edit there. Your copy wins on name collisions because user-managed sources rank ahead of the bundle in the scanner.
