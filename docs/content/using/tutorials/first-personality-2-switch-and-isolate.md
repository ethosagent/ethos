---
title: "Create your first personality, part 2: switch, hot-reload and isolate memory"
description: "Switch to the new personality, hot-reload it and prove memory isolation."
kind: tutorial
audience: user
updated: 2026-11-03
---

## Goal

Finish steps 5-9 of [Create your first personality](first-personality.md): Switch to the new personality; Hot-reload — edit identity while chat is running; Prove per-personality memory isolation; Set a per-session budget cap; List the user personalities you have built.

## Prereqs

- Complete [part 1 of 3](first-personality.md).

## 5. Switch to the new personality

If `ethos chat` is not already running, open it:

```bash
ethos chat
```

Inside chat, switch:

```
/personality strategist
```

The header chip updates to `Strategist`. Send a probe message in the voice you wrote:

```
You > i have three projects competing for the next two weeks. which should i ask about first?
```

A working strategist asks a clarifying question (per the `SOUL.md`) rather than guessing. If you see a generic "here are five frameworks!" answer, the personality did not load — check the chip in the header and `/personality list` for typos in the directory name.

If `/personality strategist` errors with `Unknown personality`, the directory either does not exist or has the wrong path. The registry expects `~/.ethos/personalities/<id>/`. Listing helps:

```bash
ls -la ~/.ethos/personalities/strategist/
```

You should see all three files. If `SOUL.md` is missing, the personality loads but speaks in the framework default; if `config.yaml` is missing, the personality is rejected and not listed.

## 6. Hot-reload — edit identity while chat is running

The registry caches each personality directory by the mtimes of its three files. On every [turn](../../getting-started/glossary.md#turn), `FilePersonalityRegistry.loadFromDirectory` checks the fingerprint; if any file changed on disk, it re-reads them before the prompt is built.

Test it. Without exiting chat, open `SOUL.md` in your editor and add one line:

```diff
 I am a strategic advisor. My job is long-horizon planning and prioritisation. I help you decide what to commit to, what to defer, and what to cut entirely.

+I name the mental model I am using when I give advice. "Eisenhower" for urgent-vs-important sorts. "Opportunity cost" for trade-offs. "Sunk cost" when I am asking you to abandon something. Naming the model makes the reasoning checkable.
+
 I think in terms of leverage. ...
```

Save the file. Send the next turn in the same chat session:

```
You > rank those three projects by leverage. show your reasoning.
```

The reply names the mental model in the first line — the edit landed without a restart. Hot-reload covers all three files: change a tool in `toolset.yaml` and the next turn sees the new catalog; change `model` in `config.yaml` and the next turn uses it.

The fingerprint is per-directory; only personalities whose files changed are reloaded. Cost is one `stat` per file on each turn — cheap enough to run unconditionally.

Practical use cases for hot-reload:

- Tune voice live. Send a message, edit one line, send the next. Iterate until the agent sounds right.
- Restrict the toolset after the fact. Remove `web_search` from `toolset.yaml`, save, send a follow-up — the agent now has no web access.
- Swap the model on suspicion of an issue. Edit `model:`, send a probe, decide whether the regression is the model or the prompt.

## 7. Prove per-personality memory isolation

[Memory](../../getting-started/glossary.md#memory) and sessions are different layers. Sessions are the per-conversation log in SQLite, keyed by `cli:<cwd-basename>`. Memory is two markdown files — `MEMORY.md` (per-personality at `~/.ethos/personalities/<id>/MEMORY.md`) and `USER.md` (per-user at `~/.ethos/users/<userId>/USER.md`) — that the agent reads at the start of every session and updates after every turn.

Every personality has its own `MEMORY.md`. The strategist's memory lives at `~/.ethos/personalities/strategist/MEMORY.md` and the researcher's at `~/.ethos/personalities/researcher/MEMORY.md`. They never share a file.

Watch it happen.

First, ask the strategist to record something memorable:

```
You > remember that i prefer quarterly horizons over annual ones.
```

The agent confirms, and (under the hood) `MarkdownFileMemoryProvider.sync` appends a line to the strategist's memory file. Verify it:

```bash
cat ~/.ethos/personalities/strategist/MEMORY.md
```

You should see the new line. Now switch to the researcher and ask:

```
/personality researcher
You > what do you remember about my planning horizon preference?
```

The researcher does not see it. Its memory provider reads `~/.ethos/personalities/researcher/MEMORY.md` — a different file entirely. Switch back:

```
/personality strategist
You > what was my planning horizon preference?
```

The strategist remembers — its memory is its own. Each personality's `MEMORY.md` lives in its own directory, and that isolation is automatic.

A few practical notes:

- The per-personality memory file is created lazily on the first write. Until then, `cat` returns `No such file or directory`.
- Memory is plain markdown. You can read, grep, diff, and commit it. Edit it by hand if you want — the agent will read your edits on the next turn.
- Memory updates surface as `MemoryUpdate[]` entries (`add` / `replace` / `remove`). The framework applies them after `agent_done` fires, so they are visible from the next turn onward.
- Memory is rolling context. The [memory model](../explanation/memory-model.md) page covers `prefetch`/`sync`, retention, and the trade-offs between markdown and vector backends.

## 8. Set a per-session budget cap

A strategist on Opus is expensive per turn. Cap it at the personality level so a runaway session refuses gracefully rather than billing you.

Add one line to `config.yaml`:

```yaml
budgetCapUsd: 0.50
```

Save. The change picks up on the next turn — no restart. Inside chat:

```
/budget
```

You see:

```
Session spend: $0.04321
Cap          : $0.50000
```

When the cap is crossed, the next turn refuses with a `BUDGET_EXCEEDED` error. `/budget reset` clears the counter and lets you continue.

The cap is session-scoped — `/new` starts a fresh count. If you want a daily or monthly cap, that lives elsewhere (provider-side billing limits, observability retention policies in [config.yaml](../reference/config-yaml.md#retention)).

## 9. List the user personalities you have built

```
/personality list
```

Output:

```
Built-ins: researcher · engineer · reviewer
System:    personality-architect · team-architect
User personalities: ~/.ethos/personalities/<id>/
```

The TUI version of the same command (or `ethos personality list` from outside chat) prints both the built-ins and the user-created ones with their descriptions:

```bash
ethos personality list
```

You should see `strategist` listed with the description you wrote.

To make `strategist` the default personality for new sessions:

```bash
ethos personality set strategist
```

This writes `personality: strategist` to `~/.ethos/config.yaml`. The next `ethos chat` starts in strategist without an explicit switch.

## What you learned

- Steps 5-9 done: Switch to the new personality; Hot-reload — edit identity while chat is running; Prove per-personality memory isolation; Set a per-session budget cap; List the user personalities you have built.

## Next step

Continue with [part 3 of 3: duplicate, tighten and extend](first-personality-3-duplicate-and-patterns.md).
