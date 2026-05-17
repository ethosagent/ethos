#!/usr/bin/env bash
#
# Idempotently wire `.githooks/` as this repo's hook directory. Invoked by the
# root `prepare` script in package.json, so any contributor cloning the repo
# and running `pnpm install` picks up the pre-push gate automatically.
#
# No-op in three cases:
#   - The current directory isn't a git checkout (e.g. an extracted tarball
#     or a workspace install far from the repo root).
#   - The `.githooks/` directory doesn't exist (defensive — only relevant
#     if someone runs this script outside the repo).
#   - core.hooksPath is already pointing at `.githooks` (saves a redundant
#     git config write on every install).
#
# Run manually after a fresh clone if you skipped `pnpm install`:
#     bash scripts/install-hooks.sh

set -euo pipefail

if [[ ! -d .git ]] || [[ ! -d .githooks ]]; then
  exit 0
fi

# Mark the hook executable — required by git, and `git clone` doesn't
# always preserve the bit on every platform.
chmod +x .githooks/pre-push 2>/dev/null || true

current=$(git config --get core.hooksPath 2>/dev/null || echo "")
if [[ "$current" != ".githooks" ]]; then
  git config core.hooksPath .githooks
  echo "[install-hooks] wired .githooks/ via core.hooksPath"
fi
