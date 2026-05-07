---
title: github-pr-workflow
sidebar_position: 7
---

# GitHub PR Workflow

> End-to-end PR lifecycle: branch → commit → push → open PR → wait for CI → merge. Each step structured; user can interrupt anywhere.

## What it does

Walks the agent through every step of opening a PR, with a preflight that fails loudly (not silently) when the environment isn't set up. Uses the `gh` CLI; pairs with the `process` tool for non-blocking CI watch — start `gh pr checks --watch` as a background process, keep working, surface progress on demand.

## When the agent uses it

- User said "open a PR" / "submit this for review" / "let's PR this".
- Agent self-invokes when a feature is complete and tests pass.

## Prerequisites

| Requirement | How to install / configure | Verify |
|---|---|---|
| `gh` CLI | macOS: `brew install gh`; other: see [cli.github.com](https://cli.github.com/) | `gh --version` |
| `gh` authentication | One-time: `gh auth login`. Browser-based flow. | `gh auth status` |
| `git` + remote | `git remote -v` shows at least one remote | Same |
| `terminal`, `read_file`, `write_file` | Built-in | `ethos personality show <id>` |
| `process` *(optional)* | Built-in | Used for non-blocking CI watch |

## Default personalities

Enabled for: `engineer`, `coordinator`.

## How it works

1. **Preflight**: `gh auth status`, `git remote -v`, `git status --porcelain`. Fails loudly if any prerequisite is missing.
2. **Clean working tree**: commit/stash existing changes (asks the user when ambiguous).
3. **Branch**: `git switch -c <kebab-case-branch>` off the repo's default branch.
4. **Commit**: structured message: `<scope>: <imperative summary>` plus optional body.
5. **Push**: `git push -u origin <branch>`. Never `--force`.
6. **Open PR**: `gh pr create --title <...> --body <...>` with summary, test plan, related links.
7. **Watch CI**: with `process` → background watch; without → blocking.
8. **Result**: on green, prints PR URL and asks whether to merge. On red, reads failed checks and proposes a fix.

## Related skills

- [`code-review`](./code-review) — pairs naturally; review locally before invoking this skill.
- [`github-code-review`](./github-code-review) — for reviewing other people's PRs.

## Configuration

The skill auto-detects the default branch from `gh repo view`. If your repo uses a non-standard default (e.g. `develop`), the detection still picks that up correctly.

## Examples

**User:** "Open a PR for this feature."

**Agent:**
1. `gh auth status` — passes.
2. `git status --porcelain` — clean.
3. `git switch -c add-rate-limit`. Commits with `feat(api): add token-bucket rate limiter`.
4. `git push -u origin add-rate-limit`.
5. `gh pr create --title "feat(api): add rate limiter" --body <body-with-test-plan>`.
6. Starts `gh pr checks --watch` as a background process. Returns control to the user.
7. When CI is green: surfaces `https://github.com/<owner>/<repo>/pull/123` and asks whether to merge.

## Troubleshooting

- **`gh auth status` fails.** Run `gh auth login`, complete the browser flow, retry.
- **Push rejected because branch already exists upstream.** The skill never creates a new branch from a name that already exists upstream — it stops and asks. To overwrite, the user has to do that explicitly (`git push --force-with-lease`).
- **CI failing on a check the skill can't read.** Some org-private checks aren't visible to `gh` without elevated scopes. Run `gh auth refresh -s repo,read:org` once.
- **The chat blocks on CI watch.** Add the `process` tool to the personality's toolset. The skill will switch to background-watch mode.

## Setup the user needs to do once

1. Install `gh`: `brew install gh` (macOS), `choco install gh` (Windows), or follow [cli.github.com](https://cli.github.com/) for Linux.
2. `gh auth login` — pick GitHub.com, pick HTTPS or SSH, complete the browser flow.
3. `gh auth status` should print "Logged in to github.com as `<your-handle>`".
