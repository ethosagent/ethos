---
name: codebase-inspection
description: First-pass survey of an unfamiliar codebase. Counts LOC by language, finds entry points and config files, scans the dependency graph, and reports back in three sections (shape, conventions, risks) so the agent grounds its next action in what's actually there rather than guessing.
version: 1.0.0
author: ethosagent
tags: [coding, investigation, onboarding]
required_tools: [terminal, read_file]

ethos:
  category: quality-and-testing
  default_personalities: [engineer, reviewer, coordinator]
  prerequisites:
    external_cli: [git]
    auth: []
    env_vars: []
    optional_tools: [search_files]
  integrates_with:
    - skill: plan
      role: feeds into — a plan written without a codebase survey will miss frozen schemas, lint baselines, and existing conventions
    - skill: code-review
      role: shares convention-discovery logic — both skills read CLAUDE.md / AGENTS.md / DESIGN.md as their rule source
  surface_metadata:
    invocation_trigger: "user says 'walk me through this repo', 'I'm new to this codebase', 'before we change anything…'; agent self-invokes when asked to make changes to a repo it hasn't read yet"
    estimated_turns: "1-2"
---

# Codebase Inspection

Survey a codebase you don't already know before recommending changes. The output is a short report, not a deep dive.

## When to use this skill

- Agent is about to work in a repo it has never touched in this session.
- User asks "what does this project do?" or "walk me through the layout".
- A change request lands and you can't articulate the architecture from memory.

## When NOT to use this skill

- The repo is already familiar — re-running the survey on every turn is waste.
- The user asked for a specific file edit — read just that file, don't survey the world.
- The task is "fix this typo" — the survey is overkill.

## Step 1 — top-level shape

```bash
ls -la
git log -1 --format="%h %s · %ad" --date=short    # last commit, when
cat README.md 2>/dev/null | head -60               # what the project says it is
```

Note the top-level layout: monorepo (`packages/`, `apps/`, `extensions/`)? Library (`src/`, `lib/`)? Framework (`pages/`, `routes/`, `app/`)?

## Step 2 — language + size

```bash
# Lightweight, no install — works in any unix shell
git ls-files | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -10

# Richer if pygount is available
command -v pygount >/dev/null && pygount --format=summary . 2>/dev/null
```

Capture: which languages dominate, rough LOC, the file-type ratio (e.g. "80% TS, 12% test, 5% config, 3% docs").

## Step 3 — convention files

Read whichever exist, in order:

| File | Role |
|---|---|
| `CLAUDE.md` / `AGENTS.md` / `.cursorrules` | Project rules for agents |
| `CONTRIBUTING.md` | Human-process rules |
| `ARCHITECTURE.md` / `DESIGN.md` | Structural source of truth |
| `package.json` / `pyproject.toml` / `Cargo.toml` | Manifest + scripts + deps |
| `tsconfig.json` / `biome.json` / `eslint.config.*` | Tooling + style |
| `.github/workflows/*.yml` | CI gates |

The point is to learn the **rules** before changing anything. Don't invent new ones.

## Step 4 — entry points

Find where execution starts:

```bash
# Node / TS
grep -E '"main"|"bin"|"exports"' package.json 2>/dev/null
# CLI binary?
ls bin/ 2>/dev/null; ls cmd/ 2>/dev/null
# Tests
find . -name "*.test.*" -not -path "*/node_modules/*" | head -5
```

## Step 5 — dependency surface

```bash
# Node
jq -r '.dependencies // {} | keys[]' package.json 2>/dev/null | head -20
# Python
head -40 pyproject.toml 2>/dev/null
# Anything
find . -maxdepth 2 -name "*.lock" -o -name "package-lock.json" -o -name "yarn.lock" -o -name "pnpm-lock.yaml" -o -name "uv.lock" 2>/dev/null | head
```

## Step 6 — write the report

Return three short sections — no more than 20 lines total. The user wanted a survey, not a re-read of the codebase.

```markdown
## Shape
- <language(s) + LOC bucket + monorepo/library/framework>
- <top-level layout in one sentence>
- <entry point(s)>

## Conventions
- <rules source: CLAUDE.md / AGENTS.md / etc.>
- <build/test commands from the manifest>
- <style/lint tooling>

## Risks for the requested change
- <pre-existing test failures / lint baselines / frozen schemas>
- <relevant constraints from rules files>
- <anything surprising>
```

## Anti-patterns

- **Re-reading every file.** Survey is fast and shallow. Deep reads are for the actual change.
- **Inventing rules.** If `CLAUDE.md` says nothing about commit messages, don't enforce a convention you imagined.
- **Skipping the rules step.** The whole point of the survey is to ground later changes in documented rules.
- **Re-running the survey on every turn.** Once is enough per repo per session.

## Hard rules

- **Findings come with file paths.** "There's a frozen schema" without `<path>` is gossip.
- **Survey reads, never writes.** No `write_file`, no `patch_file`, no `git` mutations.
- **Stop at the report.** The next turn decides what to do; this skill's job ends at "here's what's there".
