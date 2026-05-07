---
title: systematic-debugging
sidebar_position: 6
---

# Systematic Debugging

> Four-phase root-cause investigation: Investigate → Analyze → Hypothesize → Verify → Implement. No fix lands without a confirmed root cause and a regression test.

## What it does

Investigation discipline. The fix is the last step, not the first. The skill enforces an ordered procedure: gather evidence, analyze it, hypothesize, verify the chosen hypothesis with a concrete test, then implement a fix paired with a regression test.

For non-trivial investigations, the skill writes the log to `~/.ethos/investigations/<personality>/<slug>.md` so future debugging has prior art to grep.

## When the agent uses it

- User reported a bug, error, regression, or "X was working yesterday".
- A `terminal` command unexpectedly failed with a non-obvious cause.
- User said "debug this" / "why is X broken" / "track this down".

For one-line errors with one-line fixes, the skill defers — just fix it.

## Prerequisites

| Requirement | How to install / configure | Verify |
|---|---|---|
| `read_file`, `terminal`, `search_files` | Built-in | `ethos personality show <id>` |
| `process` *(optional)* | Built-in | Used for tailing logs without blocking |
| `write_file` *(optional)* | Built-in | Used to persist the investigation log |
| `patch_file` *(optional)* | Built-in | Used for the implement step |

## Default personalities

Enabled for: `engineer`. Recommended for `reviewer` once you add `terminal` to its toolset (the reviewer ships read-only by default — see [the bundle overview](./)).

## How it works

1. **Investigate**: collect error messages, stack traces, recent commits (`git log --since="1 week"`), related files via `search_files`, environment info, and a minimal repro.
2. **Analyze**: cluster the evidence by what each piece tells you about what's actually happening.
3. **Hypothesize**: name 1-3 candidate root causes, ranked by likelihood. Design a small experiment that distinguishes them. Run; revise.
4. **Verify**: reproduce the failure deterministically, apply the proposed fix, confirm it no longer reproduces, confirm no regression.
5. **Implement**: smallest fix + a regression test that would have caught the original. Run the full suite.

While investigating, prefer **per-boundary logging** (entry/exit at component boundaries) over scattered `console.log` inside a single function. Higher signal-to-noise.

## Related skills

- [`tdd`](./tdd) — once the regression test is written, the skill hands off to TDD's discipline for the fix.
- [`code-review`](./code-review) — review the resulting fix before commit.

## Configuration

Investigation logs are written under `~/.ethos/investigations/<personality>/`. To disable persistence, omit `write_file` from the personality's toolset (the in-memory investigation still works; only persistence is dropped).

## Examples

**User:** "The signup endpoint started returning 500 for emails with `+` in them. It was working last week."

**Agent:**
1. **Investigate**: pulls the 500 response body, `git log --since="1 week"` shows a commit that added a query-param parser. Searches for `parseEmail` — finds it.
2. **Analyze**: the parser URL-decodes the email twice, which collapses `+` to space.
3. **Hypothesize**: ranks "double-decode" vs "regex change" vs "library upgrade". Experiment: log the email at each step.
4. **Verify**: confirms the email is `"alice space@x.com"` after the second decode. Reverts the offending line locally; reproduces no longer fires.
5. **Implement**: fixes the double-decode; adds a regression test for `+` in the local-part. Full suite green.

The investigation log writes to `~/.ethos/investigations/engineer/signup-500-plus-emails.md` for future reference.

## Troubleshooting

- **The skill keeps asking for more evidence.** That's correct — the discipline refuses to hypothesize on thin data. Either provide more (a fuller stack trace, a clearer repro) or invoke a debugging tool to capture more.
- **I want to skip the regression test.** The iron rule says no. Override only when explicitly authorized as a hotfix-with-followup, and only if a follow-up task is created to add the test.
