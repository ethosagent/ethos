#!/usr/bin/env bash
# Run vitest across the workspace.
# Called by: CI's `tests` job; sandbox Stop hook (future work); local devs.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh"
QUIET_FILTER='FAIL|✗|×|AssertionError|Error:' quiet_run tests pnpm test --reporter=minimal
