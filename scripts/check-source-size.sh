#!/usr/bin/env bash
# Size gate for source, test and doc files with a shrink-only .size-baseline.json.
# Called by: CI's `context-budget` job, lefthook pre-push, scripts/run-checks.sh.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh"
quiet_run source-size node scripts/check-source-size.mjs "$@"
