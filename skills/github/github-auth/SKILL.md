---
name: github-auth
description: Operator setup for GitHub auth — HTTPS tokens (PAT, fine-grained, classic), SSH keys (ed25519), and `gh` CLI login. Diagnoses the common failure modes ("Permission denied", "Bad credentials", "Token expired") and walks the user to a working `git push` + `gh auth status`.
version: 1.0.0
author: ethosagent
tags: [coding, github, setup, auth]
required_tools: [terminal]

ethos:
  external_cli_alternatives:
    - gh
  category: github-workflow
  default_personalities: [engineer, coordinator, reviewer]
  prerequisites:
    external_cli: [git, gh, ssh-keygen]
    auth: []
    env_vars: []
    optional_tools: [read_file]
  integrates_with:
    - skill: github-pr-workflow
      role: prereq — PR workflow's preflight (`gh auth status`) fails without this first
    - skill: github-code-review
      role: prereq — `gh` API calls fail with "Bad credentials" until auth is configured
  surface_metadata:
    invocation_trigger: "user says 'set up github', 'gh auth login isn't working', 'permission denied on git push'; agent self-invokes when `gh auth status` returns non-zero before a PR workflow"
    estimated_turns: "2-4"
---

# GitHub Auth

Get the operator's machine talking to GitHub. Three credential paths exist — pick the right one and stop.

## When to use this skill

- `gh auth status` reports "not logged in" or "expired token".
- `git push` returns "Permission denied (publickey)" or "fatal: Authentication failed".
- User says "set up GitHub" / "configure git" on a fresh machine or fresh repo.

## When NOT to use this skill

- The error is repo-level (branch protection, missing collaborator access) — that's a permissions problem on github.com, not a credential problem here.
- The user is using GitHub Enterprise Server — the flows differ; ask before running `gh auth login`.

## Step 1 — diagnose

Run these and read the output before doing anything:

```bash
gh auth status
git config --get remote.origin.url    # capture: https://... or git@github.com:...
ssh -T git@github.com 2>&1 | head -5  # for SSH paths
```

The current `remote.origin.url` tells you which path to fix. Don't switch the user from HTTPS to SSH (or vice versa) without asking — they may have habits or scripts that depend on the choice.

## Step 2 — pick the credential path

### Path A — `gh` CLI (recommended for most operators)

Best when the user does most GitHub work through `gh pr`, `gh issue`, `gh repo`. Token is stored in the OS keychain; `git` operations against `https://github.com/...` remotes pick it up automatically via the `gh` credential helper.

```bash
gh auth login
# Pick: GitHub.com → HTTPS → "Login with a web browser"
# Paste the one-time code from the terminal into the opened browser.
```

After login:

```bash
gh auth setup-git    # registers gh as the git credential helper
gh auth status       # should print "Logged in to github.com as <user>"
```

### Path B — Fine-grained Personal Access Token (best for CI / scripts)

Use when `gh` isn't available or when scoping matters (per-repo, expiry, narrow permissions).

1. Visit github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new.
2. Scope to specific repositories. Set an expiry (90 days is a reasonable default).
3. Pick the permissions the user actually needs (Contents: Read+Write, Pull requests: Read+Write for typical PR work).
4. Store the token in a credential helper, not in shell history:

```bash
# macOS — uses Keychain via osxkeychain helper (shipped with git)
git config --global credential.helper osxkeychain

# Linux — libsecret helper (per-distro install)
sudo apt-get install libsecret-1-0 libsecret-1-dev
sudo make --directory=/usr/share/doc/git/contrib/credential/libsecret
git config --global credential.helper /usr/share/doc/git/contrib/credential/libsecret/git-credential-libsecret
```

The next `git push` prompts for username (the GitHub login) and password (paste the token). The helper caches it.

### Path C — SSH key (best for power users with multiple machines)

```bash
ssh-keygen -t ed25519 -C "<email@example.com>" -f ~/.ssh/id_ed25519_github
eval "$(ssh-agent -s)"
ssh-add --apple-use-keychain ~/.ssh/id_ed25519_github   # macOS; drop --apple-use-keychain on Linux
cat ~/.ssh/id_ed25519_github.pub                         # copy to clipboard
```

Paste the public key into github.com → Settings → SSH and GPG keys → New SSH key. Verify:

```bash
ssh -T git@github.com
# Expected: "Hi <user>! You've successfully authenticated..."
```

Switch the remote to SSH if not already:

```bash
git remote set-url origin git@github.com:<owner>/<repo>.git
```

## Step 3 — verify end-to-end

Regardless of which path you took, run this sequence and confirm each step:

```bash
gh auth status                # path A only
ssh -T git@github.com         # path C only
git ls-remote                 # both paths — must succeed without prompting
git fetch                     # both paths — silent success
```

If `git ls-remote` prompts for credentials, the helper isn't wired. Re-check Step 2 for your chosen path.

## Common failures and their cause

| Symptom | Cause | Fix |
|---|---|---|
| `Permission denied (publickey)` | SSH key not loaded in the agent, or not added on github.com | `ssh-add -l` to list loaded keys; re-add if missing |
| `remote: Invalid username or password` | Stale token cached by credential helper | Clear the entry: `git credential-osxkeychain erase` (macOS) and retry — it will reprompt |
| `gh auth status` shows "expired" | PAT or device-flow token rotated past its TTL | Re-run `gh auth login` |
| `git push` works but `gh pr create` fails | `gh auth setup-git` not run after `gh auth login` | Run it |
| 2FA bypass prompt every push | HTTPS without a credential helper | Pick A or B above; never paste tokens at every push |

## Hard rules

- **Never write tokens to shell history.** Use a credential helper, OS keychain, or a secret manager (`pass`, `1password-cli`, `op`).
- **Never check tokens into git.** Even in `.env.example`. If a token leaks, rotate it immediately and grep history.
- **Prefer fine-grained tokens over classic PATs.** Classic PATs grant everything-on-everything; fine-grained scope per repo + per permission.
- **Set an expiry.** A token without an expiry is a leak waiting to happen.

## Setup the user needs to do once

- Install `gh`: `brew install gh` (macOS) or per [cli.github.com](https://cli.github.com/) for other OSes.
- Authenticate via one of the three paths above.
- Verify with `gh auth status` (Path A) or `ssh -T git@github.com` (Path C) or `git ls-remote` (any).
