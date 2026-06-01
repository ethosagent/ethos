---
name: github-repo-management
description: Repository administration — clone, create, fork and sync, settings, branch protection, secrets, releases, GitHub Actions workflows, and gists. Uses gh CLI exclusively.
version: 1.0.0
author: ethosagent
tags: [coding, github, repo, admin]
required_tools: [terminal]

ethos:
  category: github-workflow
  default_personalities: [engineer, coordinator]
  prerequisites:
    external_cli: [git, gh]
    auth: ["gh auth login (one-time browser-based flow)"]
    env_vars: []
    optional_tools: [read_file, write_file]
  integrates_with:
    - skill: github-auth
      role: prereq — all gh commands require auth
    - skill: github-pr-workflow
      role: branch protection rules affect PR merge requirements
  surface_metadata:
    invocation_trigger: "user says 'create a repo', 'set up branch protection', 'add a secret', 'cut a release', 'fork and sync this repo'"
    estimated_turns: "2-8"
---

# GitHub Repository Management

Repository administration — clone, create, fork, settings, branch protection, secrets, releases, Actions, and gists. Uses `gh` CLI exclusively.

## When to use this skill

- User wants to create, clone, or fork a repository.
- User needs to configure repo settings, branch protection, or secrets.
- User wants to cut a release, manage GitHub Actions, or create gists.

## When NOT to use this skill

- **Code changes or PR workflow** — use `github-pr-workflow` instead.
- **Issue management** — use `github-issues` instead.
- **Code review** — use `github-code-review` instead.

## Preflight

```bash
gh auth status          # must succeed
gh --version            # confirm gh >= 2.x
```

If `gh` is not installed, stop and point the user to [cli.github.com](https://cli.github.com/).

## Clone / Create / Fork+Sync

```bash
# Clone
gh repo clone owner/repo                               # HTTPS default
gh repo clone owner/repo -- --depth 1                  # shallow clone for large repos

# Create
gh repo create my-project --public --add-readme --clone # new repo + clone locally
gh repo create my-project --private --source . --push   # push existing dir as new repo
gh repo create my-project --template owner/tpl --clone  # from template

# Fork + sync
gh repo fork owner/repo --clone                         # fork and clone locally
gh repo sync owner/my-fork --source owner/repo          # sync fork with upstream
```

`gh repo sync` fast-forwards your default branch to match upstream. If branches have diverged, it refuses — merge or rebase manually.

## Repository settings

```bash
gh repo edit --description "A fast widget library"
gh repo edit --add-topic "typescript" --remove-topic "javascript"
gh repo edit --visibility private
gh repo edit --default-branch develop
gh repo edit --enable-issues=false --enable-wiki=false
gh repo edit --enable-squash-merge=true --enable-rebase-merge=false
gh repo edit --delete-branch-on-merge=true

# View current settings
gh repo view --json name,description,visibility,defaultBranchRef,isPrivate,hasIssuesEnabled
```

## Branch protection

Branch protection requires `gh api` because `gh repo edit` does not cover protection rules.

### Set required reviews + status checks

```bash
gh api repos/{owner}/{repo}/branches/main/protection \
  --method PUT \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["ci/build", "ci/test"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null
}
EOF
```

Key fields in the JSON payload:

| Field | Purpose |
|---|---|
| `required_status_checks.strict` | Require branch to be up-to-date before merging |
| `required_status_checks.contexts` | List of required CI check names |
| `enforce_admins` | Apply rules to repo admins too |
| `required_approving_review_count` | Minimum number of approvals |
| `dismiss_stale_reviews` | Dismiss approvals when new commits are pushed |
| `restrictions` | Limit who can push (`null` = no restriction) |

### View current protection

```bash
gh api repos/{owner}/{repo}/branches/main/protection --jq '{
  status_checks: .required_status_checks.contexts,
  reviews: .required_pull_request_reviews.required_approving_review_count,
  enforce_admins: .enforce_admins.enabled
}'
```

### Remove protection

```bash
gh api repos/{owner}/{repo}/branches/main/protection --method DELETE
```

**Warning:** removing protection is destructive. Confirm with the user first.

## Secrets

Use `gh secret set` exclusively. Do NOT use raw curl with PyNaCl encryption — `gh` handles the encryption transparently.

```bash
# Set from value / file / env var
gh secret set API_KEY --body "sk-abc123"
gh secret set DEPLOY_KEY < ~/.ssh/deploy_key
printenv DATABASE_URL | gh secret set DATABASE_URL

# Environment-scoped secrets
gh secret set API_KEY --env production --body "sk-prod-abc123"

# List and delete (names only — values are never exposed)
gh secret list
gh secret list --env production
gh secret delete API_KEY

# Organization secrets
gh secret set ORG_TOKEN --org my-org --visibility all --body "token"
gh secret set ORG_TOKEN --org my-org --visibility selected --repos "repo1,repo2" --body "token"
```

**Hard rule:** never echo, log, or print secret values. `gh secret list` shows names and timestamps only — that is by design.

## Releases

```bash
# Create
gh release create v1.2.0 --title "v1.2.0" --notes "Bug fixes and performance."
gh release create v1.2.0 --generate-notes                         # auto-notes from merged PRs
gh release create v2.0.0-beta.1 --prerelease --title "Beta 1"     # pre-release
gh release create v1.3.0 --draft --title "v1.3.0" --notes "WIP"   # draft (not published)
gh release create v1.2.0 ./dist/*.tar.gz --generate-notes          # with assets

# List / view / edit / delete
gh release list
gh release view v1.2.0 --json tagName,publishedAt,assets
gh release edit v1.2.0 --title "v1.2.0 (patched)" --notes "Updated."
gh release delete v1.2.0 --yes
```

## GitHub Actions

```bash
# Workflows
gh workflow list
gh workflow view build.yml
gh workflow run build.yml                                        # trigger dispatch
gh workflow run deploy.yml --field environment=production         # with inputs
gh workflow run build.yml --ref feature-branch                   # on a branch

# Runs — monitor, inspect, retry
gh run list --limit 10
gh run list --workflow build.yml
gh run view 12345                          # summary
gh run view 12345 --log-failed             # failed step logs only
gh run watch 12345                         # real-time tail
gh run rerun 12345 --failed                # re-run failed jobs only
gh run cancel 12345
gh run download 12345 --name my-artifact --dir ./artifacts
```

## Gists

```bash
# Create
gh gist create script.py --public --desc "Utility script"
gh gist create file1.py file2.py --desc "Related scripts"   # multi-file
echo '{"key": "value"}' | gh gist create --filename config.json  # from stdin

# List / view / edit / delete
gh gist list --limit 20
gh gist view <gist-id>
gh gist view <gist-id> --raw                    # raw content
gh gist edit <gist-id> --add new.py             # add a file
gh gist clone <gist-id>
gh gist delete <gist-id>
```

## Hard rules

- **Never store secrets via raw API calls.** Use `gh secret set` exclusively — it handles encryption.
- **Never log or echo secret values.** `gh secret list` shows names only; that is by design.
- **Confirm before destructive operations** — deleting repos, removing branch protection, deleting releases.
- **Never change visibility from private to public without explicit user confirmation.** This exposes all history.

## Setup the user needs to do once

1. Install `gh`: per [cli.github.com](https://cli.github.com/).
2. Authenticate: `gh auth login`. Follow the browser flow.
3. Verify: `gh auth status` should print "Logged in to github.com as ...".

# Adapted from NousResearch/hermes-agent (MIT)
