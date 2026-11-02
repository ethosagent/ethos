#!/usr/bin/env bash
# Gate the always-loaded agent context: CLAUDE.md/AGENTS.md twin, rules and skill sizes.
# Called by: CI's `context-budget` job, lefthook pre-push, scripts/run-checks.sh.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh"
quiet_run agent-files node scripts/check-agent-files.mjs "$@"
