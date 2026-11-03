---
title: "Create your first personality"
description: "Build a strategist personality end to end: SOUL.md identity, config.yaml fields, toolset.yaml allowlist, hot-reload, and a per-personality memory demo."
kind: tutorial
audience: user
slug: first-personality
time: "20 min"
updated: 2026-11-03
---

The three user-facing built-in personalities cover the common roles. This tutorial builds a fourth — a `strategist` for long-horizon planning — and uses it to prove the things personalities atomically change: prompt, tools, and model. Plus hot-reload and per-personality memory isolation, so you can edit identity prose while chat is running and verify that each personality keeps its own context.

## Goal

By the end, you have:

- A working personality at `~/.ethos/personalities/strategist/` with `SOUL.md`, `config.yaml`, and `toolset.yaml`.
- A live `ethos chat` session running as that personality with the tools you listed and the voice you wrote.
- Watched the registry hot-reload your edits to `SOUL.md` between turns without a restart.
- Verified that per-personality memory keeps the strategist's `MEMORY.md` separate from every other personality's.
- A reusable starting template — `ethos personality duplicate` — for the next personality you build.

The personality you build is small on purpose. The point of the tutorial is the contract, not the role: every dimension you set here is enforceable by the framework, not aspirational in the prompt.

## Prereqs

- [Build your first agent](./first-agent.md) finished — you have used `/personality` to switch between built-ins and know that the chip in the header is the source of truth.
- A text editor with two files open at once: `~/.ethos/personalities/strategist/SOUL.md` and a chat window.
- A working directory you do not mind associating with strategy work — sessions are still keyed per directory.
- A clear picture in your head of one role you actually want an agent to play. The tutorial uses "strategist" as a stand-in; if you have a real role (`code-reviewer`, `tech-writer`, `release-manager`, `incident-commander`), substitute its name everywhere and use this as a recipe.

## Parts

| Part | Covers |
|---|---|
| 1. Create your first personality (this page) | Steps 1-4: Lay out the directory, Write `SOUL.md` — the identity, Write `config.yaml` — the wiring, Write `toolset.yaml` — the [tool](../../getting-started/glossary.md#tool) allowlist |
| [2. Switch, hot-reload and isolate memory](first-personality-2-switch-and-isolate.md) | Steps 5-9: Switch to the new personality, Hot-reload — edit identity while chat is running, Prove per-personality memory isolation, Set a per-session budget cap, List the user personalities you have built |
| [3. Duplicate, tighten and extend](first-personality-3-duplicate-and-patterns.md) | Steps 10-13: Duplicate a built-in as a starting template, Tighten the filesystem allowlist (optional, recommended), What does NOT belong on a personality, Common patterns for the next few personalities |

## 1. Lay out the directory

A [personality](../../getting-started/glossary.md#personality) is a directory with three files. The directory name is the id you reference from `/personality <id>` — it must be filesystem-safe (no spaces) and globally unique across built-ins and user personalities.

```bash
mkdir -p ~/.ethos/personalities/strategist
cd ~/.ethos/personalities/strategist
```

Confirm where the registry will look:

```bash
ls ~/.ethos/personalities/
```

You should see `strategist/`. The three user-facing built-ins are not listed here — they ship inside the CLI package at `extensions/personalities/data/`. Both directories merge into one list at runtime; user files override builtins on the same id. If you name your directory `researcher`, your version wins over the bundled one — useful for taking a built-in and editing it in place.

## 2. Write `SOUL.md` — the identity

`SOUL.md` is first-person prose. It defines who the agent is and how it speaks. The registry loads it as the system-prompt baseline; the framework then layers memory context and personality metadata on top.

Keep it concrete. Six paragraphs is plenty. No marketing voice ("Welcome!", "I'll help you unlock..."). No emoji. Active voice over passive.

```bash
cat > ~/.ethos/personalities/strategist/SOUL.md <<'EOF'
# Strategist

I am a strategic advisor. My job is long-horizon planning and prioritisation. I help you decide what to commit to, what to defer, and what to cut entirely.

I think in terms of leverage. Some actions compound across months; some are one-time costs that look productive but do not move the trajectory. I name which is which when I see it.

I ask clarifying questions before I give advice. I would rather take one extra turn to ground a recommendation than offer five plausible-sounding options.

I am direct about tradeoffs. I do not pretend a decision is easier than it is. I say what each option costs as well as what it earns.

When I do not know something, I say so. When the answer depends on a value judgement only you can make, I name the judgement and ask which way you lean.

I structure plans into three layers: what to do this week, what to do this quarter, what to do this year. I do not load the weekly layer with quarterly work — that is how plans break.
EOF
```

A few rules that make `SOUL.md` productive:

- **First person.** "I do X" beats "The strategist does X". The model assumes the voice more reliably and refers to itself with the right pronoun.
- **Behaviour, not skills.** "I cite sources" is behaviour. "Knows everything about strategy" is a skill claim and a hallucination magnet — the model will fabricate to live up to it.
- **Concrete refusals.** "I do not pad responses" is enforceable in tone. "I write clearly" is a vibe.
- **Length is a budget.** Every token here ships on every turn, on every session, forever. Keep it tight — the engineer's `SOUL.md` is under 200 tokens for a reason.
- **Read it as the agent.** Open it later and ask "would I want this read aloud at me at every turn?". If a paragraph is filler, cut it.

The shipped researcher and engineer ETHOS files are good reference material — read them at `extensions/personalities/data/researcher/SOUL.md` and `extensions/personalities/data/engineer/SOUL.md` in the repo for tone.

## 3. Write `config.yaml` — the wiring

`config.yaml` is a flat `key: value` subset of YAML. Dotted keys (`fs_reach.read`, `safety.approvalMode`) encode nested structure without indentation. Most fields are optional; only `name` is worth setting by hand the first time.

```bash
cat > ~/.ethos/personalities/strategist/config.yaml <<'EOF'
name: Strategist
description: Long-horizon planning and prioritisation advisor.
model: claude-opus-4-7
capabilities: planning, prioritisation, decision-support
EOF
```

What each field does:

- **`name`** — human label printed in pickers and `/personality list`. Pick something readable.
- **`description`** — one-line role summary. Shown in `/personality list` and the `--help` output for `ethos personality`.
- **`model`** — overrides the global default model for this personality only. Opus is a deliberate choice for strategy work; Sonnet would be faster and cheaper at the cost of depth. The full provider/model pairing is in [config.yaml](../reference/config-yaml.md).
- **`capabilities`** — free-form tags consumed by the skill ingestion filter and the personality picker. Tags do not change behaviour by themselves; they are routing hints.

Memory is always per-personality — each personality reads and writes its own `MEMORY.md` at `~/.ethos/personalities/<id>/MEMORY.md`. No configuration field is needed.

For the full field list, including `provider`, `streamingTimeoutMs`, `fs_reach`, `mcp_servers`, `plugins`, `budgetCapUsd`, `context_layering`, `skill_evolution`, and the nested `safety` block, see [Personality config reference](../reference/personality-yaml.md).

Two fields you will likely add later:

- `fs_reach.read` and `fs_reach.write` — per-personality filesystem allowlists for the `read_file` / `write_file` [tools](../../getting-started/glossary.md#tool). When unset, the default scope is `~/.ethos/personalities/<self>/` and the current working directory. Tightening this is the right move once you start handing the personality real files.
- `budgetCapUsd` — per-session spending cap. Step 8 below adds one.

## 4. Write `toolset.yaml` — the [tool](../../getting-started/glossary.md#tool) allowlist

`toolset.yaml` is a flat list of tool names. The registry filters the LLM's visible tool catalog to exactly this list. A tool not listed here is invisible to the model and rejected at execution time (`DefaultToolRegistry.toDefinitions(allowedTools)` enforces both halves).

A strategist needs to read primary sources, capture decisions, and search prior conversations. It should not write code or run shell commands.

```bash
cat > ~/.ethos/personalities/strategist/toolset.yaml <<'EOF'
- web_search
- web_extract
- read_file
- search_files
- memory_read
- memory_write
- session_search
EOF
```

What each grants:

| Tool | What it does |
|---|---|
| `web_search` | Query a web search index and return result snippets. |
| `web_extract` | Fetch a URL and return its main-text content. |
| `read_file` | Read a file under the personality's [fs_reach](../../getting-started/glossary.md#fs-reach). |
| `search_files` | Grep across files under fs_reach. |
| `memory_read` | Read this personality's memory files (`MEMORY.md` and `USER.md`). |
| `memory_write` | Append, replace, or remove lines in those memory files. |
| `session_search` | FTS5-search prior sessions for relevant context. |

What we deliberately left out:

- `write_file`, `patch_file`, `terminal`, `run_tests` — strategist plans, it does not execute. The toolset boundary is the enforcement; a prompt instruction is not.
- `web_crawl` — overkill for the role; the agent can request individual extracts when it needs depth.

Tool names that do not exist in the registry are silently inert. There is no penalty for misspelling — but the agent will not get the tool. From inside the TUI, `/tools` lists the tools the active personality can actually see; from the readline REPL, run `ethos chat`, switch to the personality, and ask `what tools do you have?` — the agent reads its catalog from the system prompt.

### Toolset hygiene

Two patterns to follow as you build more personalities:

- **Start narrow, widen on need.** A toolset of five tools the agent uses is better than ten the agent might use. Every extra tool widens the LLM's reasoning surface and the chance it picks the wrong one. Add tools when the agent says it can't do something it should.
- **Mirror the role in the toolset.** A reviewer that has `write_file` is mis-typed. A researcher that has `terminal` is mis-typed. The toolset is the contract — if you wouldn't trust this role with this capability, do not list it.

You can audit any personality's effective toolset by switching to it and asking the agent directly:

```
/personality strategist
You > list the tools you can call. one per line, with one phrase on what each does.
```

The reply is read straight from the system prompt the framework built. Any tool you expected to see that is missing means a typo in `toolset.yaml`; any tool the agent claims that is not in the file is a hallucination — the registry will reject the call when the agent tries.

## What you learned

- Steps 1-4 done: Lay out the directory; Write `SOUL.md` — the identity; Write `config.yaml` — the wiring; Write `toolset.yaml` — the [tool](../../getting-started/glossary.md#tool) allowlist.

## Next step

Continue with [part 2 of 3: switch, hot-reload and isolate memory](first-personality-2-switch-and-isolate.md).
