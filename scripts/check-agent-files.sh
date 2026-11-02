#!/usr/bin/env bash
# Gate the always-loaded agent context: CLAUDE.md/AGENTS.md twin, rules and skill sizes.
# Called by: CI's `context-budget` job, lefthook pre-push, scripts/run-checks.sh.
set -euo pipefail
exec node scripts/check-agent-files.mjs "$@"
