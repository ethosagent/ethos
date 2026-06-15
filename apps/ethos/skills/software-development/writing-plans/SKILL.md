---
name: writing-plans
description: Meta-skill that teaches the shape of a good Ethos plan file — sections, level of detail, deliverable tagging. Improves every subsequent plan invocation. Loads automatically alongside the plan skill.
version: 1.0.0
author: ethosagent
tags: [coding, planning, meta]
required_tools: []

ethos:
  category: planning-and-process
  default_personalities: [engineer, reviewer, coordinator]
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: []
  integrates_with:
    - skill: plan
      role: companion — sets the structure that the plan skill renders into
  surface_metadata:
    invocation_trigger: "loads automatically with the plan skill; user asks to write a plan in the project's standard format"
    estimated_turns: "advisory — applied by other skills"
---

# Writing Plans

Advisory skill. It is loaded together with `plan` and shapes every Ethos plan file you write. No tools to invoke; the body below is the spec.

## The 7-section Ethos plan template

Every plan under `~/.ethos/plans/` and every long-form plan under `plan/<topic>.md` in the repo follows this shape.

1. **Header** — title and one-blockquote summary. Two sentences max. The reader should know what the plan is for from the header alone.

2. **Status** — a status legend at the top (or a `🔲 / ⚠️ / ✅` marker per section). Use the legend below.

3. **Body** — the actual proposal: motivation, design, sub-sections per concern. The bulk of the document.

4. **Sequencing** — the rollout order. A numbered list or a small table with phases. Every plan that ships in more than one PR needs a sequencing block.

5. **Acceptance gate** — what must be true before the plan is considered done. Concrete, verifiable items. Tests pass / docs updated / migration applied / metric x in range.

6. **Decisions log** — every non-obvious decision gets one row: `| Date | Decision | Rationale |`. The rationale matters most — it tells future readers why a path was chosen over alternatives.

7. **Session log** — append-only record of when work happened on this plan and what changed. One entry per session, dated.

## Status legend

| Marker | Meaning |
|---|---|
| 🔲 | Not started |
| ⏳ | In progress |
| ⚠️ | Blocked or needs decision |
| ✅ | Done |
| ❌ | Dropped (with rationale in decisions log) |

## File path conventions

- Repo plans: `plan/<topic>.md`. Topic uses snake_case to match the existing files.
- Personal plans (per personality): `~/.ethos/plans/<personality>/<slug>.md`. Slug uses kebab-case.

## Cross-link conventions

- Use relative paths: `(./other_plan.md)`, `(../docs/content/skills/overview.md)`.
- Do not link to absolute paths or to `file://` URLs.
- When referencing a section: `[Section title](./other_plan.md#section-title)`.

## Decisions log discipline

A decision row is required when any of the following is true:

- You picked one approach over a clearly viable alternative.
- You set a value (cap, timeout, threshold) that future readers will wonder about.
- You declared something out of scope.
- You changed direction from a prior decision.

Format:

```markdown
| 2026-05-06 | Use mtime cache instead of inotify | Cross-platform; mtime is sub-millisecond on every fs we run on |
```

## Sources section

Whenever a plan involves external research (other agents, papers, docs), end with a `## Sources` block listing every link the plan was informed by. This is research provenance — it lets future readers re-verify the design.

## Anti-patterns

- A plan with no open questions, no risks, and no decisions log. That plan was not thought through.
- Section headers without bodies. Either fill them or drop them.
- A "session log" that contains the plan body. The session log is a record of when work happened, not the work itself.
- Mixing plan content with execution output. If the LLM writes a plan and immediately starts executing, both halves are corrupted — write the plan, stop, get review.
