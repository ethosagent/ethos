# Sandbox Agent

You are running inside a Docker sandbox dedicated to working on **ethos**.

## Environment

- **Shared directory**: `{{SANDBOX_DIR}}` (mounted from the host)
- **Ethos repo**: `{{SANDBOX_DIR}}/ethos`
- **Worktrees**: create feature-branch worktrees in `{{SANDBOX_DIR}}/worktree`

```bash
cd {{SANDBOX_DIR}}/ethos
git worktree add {{SANDBOX_DIR}}/worktree/<branch-name> <branch-name>
```

## Code review workflow (hard rule)

You write code, then run a **two-pass review** before declaring done:

**Pass 1 — Self-review (you):** scan your own diff for typos, dead code, unused imports, lint/typecheck failures, missing tests, and ethos rule violations (error handling for impossible cases, abstractions for single-use code, speculative flexibility, comments restating code). Fix what you find.

**Pass 2 — Codex review:** invoke the `openai-reviewer` skill. Codex applies a Linus Torvalds framing focused on what breaks in 5 years — brittle abstractions, hidden coupling, API choices that will be hard to evolve.

The split is intentional: Pass 1 catches mechanical issues you can see; Pass 2 brings an outside perspective on things you cannot easily see in your own work.

A `Stop` hook also fires this automatically after every code-writing turn. Flow:
- Codex approved (no critical/high) → turn ends
- Issues + iteration < 2 → review fed back into your context, you continue fixing
- Iteration cap (2) hit → remaining issues surfaced to user, turn ends

Project rules in this `CLAUDE.md` take precedence over Codex findings. If Codex demands an ethos-violating change (error handling for impossible scenarios, abstractions for single-use code, speculative flexibility), ignore it and explain why in one line.

User can opt out for a single command: prefix with `SKIP_CODEX_REVIEW=1` or say "ship it" / "skip review".

## Project commands

Run these from inside the ethos repo:

```bash
pnpm install        # install deps (first time, or when lockfile changes)
pnpm dev            # start the ethos chat REPL
pnpm check          # typecheck + lint + test (run before declaring done)
pnpm test           # vitest run
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome check .
pnpm lint:fix       # biome check --write .
```

## Tools

- Prefer `rg` (ripgrep) over `grep`
- Prefer `fd` over `find`
- `bat` for syntax-highlighted file viewing
- `tmux` for multiple shell panes

## Constraints

- Network access is **on** — pnpm install, git push, API calls all work
- This sandbox is for ethos only; don't pull in unrelated repos
- Treat the host repo at `{{SANDBOX_DIR}}/ethos` as canonical — branch via worktrees
