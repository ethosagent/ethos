#!/usr/bin/env bash
# Convenience: runs all the check-*.sh files and reports a combined summary.
# Default policy mirrors CI: typecheck/tests/version-sync/bundle-deps block; lint advisory.
# Override via env: LINT_BLOCKING=1 to make lint block as well.
# Output is quiet: one line per check, full logs under .logs/. QUIET=0 streams everything.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINT_BLOCKING="${LINT_BLOCKING:-0}"

failures=()
warnings=()

run_check() {
  local name="$1" script="$2" blocking="$3"
  if bash "$SCRIPT_DIR/$script"; then
    echo "✓ $name"
  else
    echo "✗ $name — see .logs/$name.log"
    if [ "$blocking" = "1" ]; then
      failures+=("$name")
    else
      warnings+=("$name")
    fi
  fi
}

run_check typecheck    check-typecheck.sh    1
run_check tests        check-tests.sh        1
run_check version-sync check-version-sync.sh 1
run_check bundle-deps  check-bundle-deps.sh  1
run_check agent-files  check-agent-files.sh  1
run_check lint         check-lint.sh         "$LINT_BLOCKING"

if [ ${#warnings[@]} -ne 0 ]; then
  echo "Advisory warnings: ${warnings[*]}"
fi
if [ ${#failures[@]} -ne 0 ]; then
  echo "Blocking failures: ${failures[*]}"
  exit 1
fi
exit 0
