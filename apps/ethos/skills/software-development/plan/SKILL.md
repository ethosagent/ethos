---
name: plan
description: Render a long-form plan file in the standard Ethos shape (header, status, body, sequencing, acceptance gate, decisions log, session log). Companion to `writing-plans`, which loads alongside and supplies the spec the plan rendered against.
version: 1.0.0
author: ethosagent
tags: [coding, planning]
required_tools: [read_file, write_file]

ethos:
  category: planning-and-process
  default_personalities: [engineer, reviewer, coordinator]
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: []
  integrates_with:
    - skill: writing-plans
      role: companion — provides the plan template + section conventions this skill renders into
  surface_metadata:
    invocation_trigger: "user says 'write a plan for…', 'draft a plan', 'let's plan X'; agent self-invokes when a multi-PR change needs design before code"
    estimated_turns: "1 (single drafting turn, often followed by review)"
---

# Plan

Drafts a structured plan file in the Ethos 7-section shape. This skill writes the file; the `writing-plans` companion supplies the conventions for what each section must contain.

## When to use this skill

- A change spans more than one PR or one author.
- A change touches a frozen schema or a documented contract.
- A change has trade-offs the team should debate before code lands.
- The user asks for a plan, design doc, or proposal in the repo's standard format.

## When NOT to use this skill

- One-line fixes, typos, or local refactors. Just write the code.
- Investigations that don't yet have a recommendation. Write a discovery note in the session log first.
- Production incidents — write a runbook entry, not a plan.

## Output shape

Plans live under `plan/phases/<topic>.md` (repo-scoped) or `~/.ethos/plans/<personality>/<slug>.md` (personal). File naming: snake_case for repo plans, kebab-case for personal. The file must contain the seven sections the `writing-plans` companion specifies, in that order, with a Status legend at the top.

## Workflow

1. Confirm the plan target path with the user.
2. Read related plans the new one cross-links to so the references are accurate (`plan/phases/<existing>.md`).
3. Draft the seven sections. The body section can be deeply nested; everything else stays compact.
4. Hand the draft back for review before any execution begins. Plans land via PR; execution follows in a separate PR keyed off the plan.

## Anti-patterns

- Mixing plan and execution in one turn — write the plan, stop, wait for review.
- Acceptance gates without verifiable conditions ("ship when ready" is not a gate).
- A decisions log entry without a rationale — the *why* is the artefact.
