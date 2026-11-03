---
title: "Create your first personality, part 3: duplicate, tighten and extend"
description: "Duplicate a built-in, tighten the allowlist and plan the next personalities."
kind: tutorial
audience: user
updated: 2026-11-03
---

## Goal

Finish steps 10-13 of [Create your first personality](first-personality.md): Duplicate a built-in as a starting template; Tighten the filesystem allowlist (optional, recommended); What does NOT belong on a personality; Common patterns for the next few personalities.

## Prereqs

- Complete [part 2 of 3](first-personality-2-switch-and-isolate.md).

## 10. Duplicate a built-in as a starting template

Writing `SOUL.md` from a blank file is harder than editing. Future personalities are usually easier to start from a copy:

```bash
ethos personality duplicate engineer engineer-paired
```

This copies the engineer's three files into `~/.ethos/personalities/engineer-paired/` with a fresh id. You can then edit any of the three to specialise the role — a paired engineer with stricter `safety.approvalMode: smart` and a tighter `budgetCapUsd`, for example — without losing the base toolset.

Common duplicate-and-customise patterns:

- `researcher-domain` — restrict `fs_reach` to one project tree, tighten `web_search` to a domain allowlist via the `safety.network.allow` block.
- `engineer-paired` — flip `safety.approvalMode` to `smart` so the agent confirms destructive tool calls before running them.
- `reviewer-strict` — start from `reviewer`, remove every write tool, narrow `fs_reach.write` to nothing.

The full safety block lives in [Personality config reference](../reference/personality-yaml.md#safety).

## 11. Tighten the filesystem allowlist (optional, recommended)

By default, a personality's `read_file` and `write_file` tools can reach `~/.ethos/personalities/<self>/` and the current working directory. For a personality you trust to run anywhere, that is fine. For one bound to a specific project, narrow the scope.

Add to `config.yaml`:

```yaml
fs_reach.read: ${ETHOS_HOME}/personalities/${self}, ${ETHOS_HOME}/skills, ${HOME}/notes
fs_reach.write: ${ETHOS_HOME}/personalities/${self}, ${HOME}/notes
```

Substitutions are resolved at turn construction:

- `${ETHOS_HOME}` → `~/.ethos`
- `${self}` → the personality's id (`strategist`)
- `${CWD}` → the current working directory the agent is operating from

A read or write outside the allowlist raises a `BoundaryError` at the tool boundary; surfaces translate it into a tool error the agent can see and recover from. The agent does not silently fail — it reads the error and explains what it tried to do.

`fs_reach` is enforced for the agent's file tools (`read_file`, `write_file`, `patch_file`, `search_files`). It is distinct from the `Storage` interface's per-personality boundary, which constrains the framework's own I/O. Both layers exist; only `fs_reach` is something you tune at the personality level.

## 12. What does NOT belong on a personality

The personality schema is intentionally frozen. The following categories do NOT belong in `config.yaml`:

- **Voice modes / TTS engine settings** — operator concerns, set in `~/.ethos/config.yaml`. (Which *voice* the personality speaks in is identity and does belong here — that is the `voice` block.)
- **Emotion / mood / sentiment tags** — prompt-engineering concerns; put them in `SOUL.md`.
- **Per-channel UI affordances** (button text, response templates) — adapter concerns.
- **Default skill content** — skills are their own files, not personality fields.

If you find yourself wanting to add a free-form field, the right answer is usually a skill (markdown file under `~/.ethos/skills/`) or an adapter config (in `~/.ethos/config.yaml` at the top level). The personality stays small on purpose — every field on the schema has a behavioural consequence, and the frozen surface lets the field count be a CI gate.

## 13. Common patterns for the next few personalities

Once you have one custom personality working, the second is faster. A few shapes that show up repeatedly:

- **A read-only reviewer.** Start with `reviewer`, duplicate to `reviewer-strict`, remove every write tool, set `safety.approvalMode: manual`, narrow `fs_reach.write` to nothing. The agent can read and reason but cannot edit.
- **A project-bound engineer.** Duplicate `engineer` to `engineer-<project>`, set `fs_reach.read` and `.write` to that project's tree, attach a project-specific `safety.network.allow` list. The agent cannot accidentally touch unrelated code.
- **A specialist that takes orders from a supervisor.** Build the specialist with a tight toolset and a minimal `SOUL.md`, then reference it from a mesh manifest (see [Teams and meshes](../../building/explanation/teams-and-meshes.md)). The specialist is callable from a coordinator personality.

There is no rule that says you must use all three user-facing built-ins. Many teams end up with two custom personalities — a researcher-style one for exploration and an engineer-style one for execution — and use the rest as references. Two system personalities (personality-architect, team-architect) are also available for meta-level tasks. Start narrow; broaden when you feel the friction of a missing role.

## What you learned

- A personality is three files at `~/.ethos/personalities/<id>/`: identity (`SOUL.md`), wiring (`config.yaml`), allowlist (`toolset.yaml`).
- `config.yaml` is flat YAML; the parser ignores unknown keys. The full field list is in the [Personality config reference](../reference/personality-yaml.md).
- The registry hot-reloads on file mtime — edit any file, send the next turn, the change is live.
- Memory is always per-personality — each personality reads and writes its own `MEMORY.md` automatically.
- `budgetCapUsd` caps the per-session spend and refuses the next turn when crossed; `/budget reset` releases the counter.
- `ethos personality duplicate <src> <dst>` is the cheap way to start a new personality from a working one.

## Next step

Your personality runs locally inside `ethos chat`. The next tutorial puts it in front of real users on Telegram — one bot token, one daemon, one channel adapter, and a first reply in production.

- [Deploy your first Telegram agent](./first-deploy-telegram.md) — from BotFather to a replying bot.
- [Personality config reference](../reference/personality-yaml.md) — every field on `config.yaml`, including `fs_reach`, `safety`, `context_layering`, and `skill_evolution`.
- [Memory model](../explanation/memory-model.md) — how `prefetch` and `sync` interact with the rest of the turn cycle.
- [What is a personality?](../explanation/what-is-a-personality.md) — the design rationale behind making personality a structural component.
