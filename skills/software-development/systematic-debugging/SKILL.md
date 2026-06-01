---
name: systematic-debugging
description: Four-phase root-cause investigation — Investigate → Analyze → Hypothesize → Verify → Implement. No fix lands without a confirmed root cause and a regression test that would have caught the original failure.
version: 1.0.0
author: ethosagent
tags: [coding, debugging, quality]
required_tools: [read_file, terminal, search_files]

ethos:
  category: quality-and-testing
  default_personalities: [engineer, reviewer]
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: [process, write_file, patch_file]
  integrates_with:
    - tool: process
      role: tail logs while iterating without blocking the chat
    - tool: write_file
      role: persist the investigation log under ~/.ethos/investigations/<personality>/
  surface_metadata:
    invocation_trigger: "user reports a bug, regression, or unexpected behaviour; agent self-invokes when a terminal command unexpectedly fails"
    estimated_turns: "5-20 (investigations vary widely in length)"
---

# Systematic Debugging

Investigation discipline. The fix is the *last* step, not the first.

## When to use this skill

- The user reported a bug, error, regression, or "X was working yesterday".
- A `terminal` command unexpectedly failed and the cause is not immediately obvious.
- The user said "debug this" / "why is X broken" / "track this down".

When the cause is obvious from a one-line error message and a one-line fix exists, do not invoke the full procedure — just fix it. Reserve this skill for problems where the root cause is unclear.

## The four phases

### 1. Investigate — gather evidence

Collect, do not theorize:

- The exact error message and stack trace, copied verbatim.
- Recent changes: `git log --since="1 week" --oneline`, `git diff <last-known-good>...HEAD`.
- Related files: search for the failing identifier with `search_files`.
- Environment: relevant env vars, library versions, OS specifics.
- Reproduction: what minimal input triggers it? Capture the smallest repro.

Write all of this down — into the conversation or, for longer investigations, into `~/.ethos/investigations/<personality>/<slug>.md`.

### 2. Analyze — group the evidence

Group what you collected by what each piece tells you about *what is actually happening*. Cluster similar errors. Note what's *not* there (e.g. "no entry in the access log" is a finding, not noise).

If the evidence is thin, return to step 1. Do not skip ahead to hypotheses with insufficient data.

### 3. Hypothesize — name 1-3 candidate root causes

A hypothesis is a sentence of the form: "X is happening because Y, which is observable as Z."

- Rank by likelihood given the evidence.
- For each, design a small experiment that would distinguish it from the others.
- Run the experiments. The result either confirms a hypothesis or invalidates it.

If all hypotheses are invalidated, return to step 1 — the data was not enough.

### 4. Verify — confirm the root cause

Before writing a fix, verify the chosen hypothesis with a final concrete test:

- Reproduce the failure deterministically.
- Apply the proposed fix locally.
- Confirm the failure no longer reproduces.
- Confirm no other behaviour regressed.

Only now do you have a confirmed root cause.

### 5. Implement

Two parts, both required:

1. **The fix.** Smallest change that addresses the root cause. No collateral cleanup.
2. **A regression test.** A test that would have caught the original failure. Without this, the fix is invisible — the next regression slips through.

Run the full test suite. Do not move on until all tests pass.

## Per-boundary logging

While investigating, prefer adding entry/exit logging at component boundaries (function boundaries, network boundaries, queue boundaries) over scattering `console.log` inside a single function. The signal-to-noise is much higher: you see *what crossed the boundary*, not the internal arithmetic.

Remove the boundary logging when the bug is confirmed and a regression test is in place.

## Persisting investigations

For non-trivial investigations, write the log to `~/.ethos/investigations/<personality>/<slug>.md`. Include: the symptoms, the evidence collected, the hypothesis tested, the root cause, and the fix. Future investigations of similar bugs benefit from being able to grep this directory.

## The iron rule

**No fix lands without a confirmed root cause and a regression test.** A bug fix without a test that would have caught the original is not really fixed — it just isn't visible right now.

If the user asks you to skip the test "because we're in a hurry", refuse and explain that you'll skip the test only when explicitly authorized as a hotfix-with-followup, and only if a follow-up task is created to add the test.
