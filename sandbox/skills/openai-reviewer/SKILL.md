---
name: openai-reviewer
description: Run OpenAI Codex CLI as the project's code reviewer. Code is written by Claude and reviewed by Codex — never review your own code. Invoke for ALL review requests in this project ("review", "check it", "look it over", "code review") and any time non-trivial code has been written. The Stop hook also calls this automatically.
allowed-tools: Bash(openai-review *), Bash(*/openai-review *)
---

# OpenAI Code Review

## Routing rule (hard)

**All reviews go through this skill.** When the user asks for any kind of review — explicit ("review this", "code review") or implicit ("check it", "look it over") — go through the two-pass flow below.

## Two-pass review flow

**Pass 1 — Self-review (Claude, fast):**
Before calling Codex, scan your own diff for things you would have caught yourself:
- Typos, dead code, unused imports/variables
- Lint and typecheck violations (run `pnpm lint` / `pnpm typecheck` if changes are non-trivial)
- Ethos rule violations: error handling for impossible cases, abstractions for single-use code, speculative flexibility, comments restating what the code does
- Tests missing for new behavior

Fix everything you find. Only then move to Pass 2.

**Pass 2 — Codex review (architectural, 5-year horizon):**
Invoke `openai-review`. Codex looks for what you cannot easily see in your own work: brittle abstractions, hidden coupling, API choices that will be hard to evolve, premature flexibility, things that rot under scale or team turnover.

The split exists because LLM self-review is unreliable for the things you wrote yourself. Pass 1 catches mechanical issues; Pass 2 brings an outside perspective.

## Style

Reviews run in the voice of Linus Torvalds, focused on what will break in 5 years:
- Brittle abstractions and architectural foot-guns
- Hidden coupling that surprises future maintainers
- API choices that will be hard to evolve
- "Cleverness" that obscures intent
- Premature flexibility / speculative generality

The script bakes this framing into every Codex call.

## Modes

`openai-review` defaults to `uncommitted` if no mode is given.

| Mode | When to use |
|---|---|
| `uncommitted` | Active coding — staged + unstaged changes (default) |
| `last-commit` | Review the latest commit only |
| `against-main` | Whole branch + uncommitted vs. main |
| `against-origin` | Unpushed commits vs. origin |

Add `--focus <security|performance|correctness|style|test>` to narrow scope.

## Acting on findings

Codex returns JSON. Apply judgment — not every finding is correct.

| Severity | Action |
|---|---|
| `critical`, `high` | Fix |
| `medium` | Judgment call — fix unless it conflicts with project rules |
| `low` | Usually skip; surface to user only if relevant |

**Project rules in `CLAUDE.md` take precedence over Codex.** If Codex demands an ethos-violating change (error handling for impossible scenarios, abstractions for single-use code, speculative flexibility), ignore it and explain why in one line.

## Auto-loop (Stop hook)

A `Stop` hook runs `openai-review against-main` after every code-writing turn:
- **Approved** (no critical/high) → turn ends cleanly
- **Issues + iteration < 2** → review fed back into your context, you continue fixing
- **Iteration cap (2) hit** → remaining issues surfaced to user, turn ends

Override the loop for a turn with `SKIP_CODEX_REVIEW=1` in the environment, or by user explicitly saying "ship it" / "skip review".
