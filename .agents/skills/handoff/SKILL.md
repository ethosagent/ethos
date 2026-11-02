---
name: handoff
description: 'Write HANDOFF.md at the repo root: what is done, what remains, the failing gate with its .logs/ path, open decisions, and files touched. Use before ending a session or when asked to hand off.'
---

# Handoff

Write `HANDOFF.md` at the repo root so a fresh session can resume without this conversation. The file is gitignored (`/HANDOFF.md`) and local only.

## Gather

Run these first, read-only:

1. `git status --short`
2. `git diff --stat main...HEAD`
3. The newest `.logs/*.log` with a non-zero result: list with `ls -t .logs/*.log`, open the newest ones until a failure shows. If none failed, say so.
4. The active plan path, by the same rule as `session-compact.sh`: `plan/.active` if it exists (its contents name the plan), else the newest-mtime file across `plan/*.md` and `plan/phases/*.md`.

## Write

Overwrite `HANDOFF.md`, never append. Use exactly five H2 headings, in this order, and no others:

- `## Done`: what is finished and verified this session, one bullet each. Cite the commit or test that proves it.
- `## Remaining`: what is left, in order, naming the active plan path and the next task or step in it.
- `## Failing gate`: the gate that failed (typecheck, lint, test, archcheck), its `.logs/` path, and the first error lines. Write `None` if everything passed.
- `## Open decisions`: questions that need the maintainer, each with the options and your recommendation.
- `## Files touched`: paths from `git status` and `git diff --stat`, each with a few words on what changed.

## Rules

- State only what you checked. Mark anything unverified as unverified.
- Keep it short: a reader should finish in a minute.
- Do not commit `HANDOFF.md`.
- After writing, confirm with `grep -c '^## ' HANDOFF.md`, which must print `5`.
