#!/usr/bin/env bash
# Run tsc --noEmit across packages + apps/web.
# Called by: CI's `typecheck` job; sandbox Stop hook (future work); local devs.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh"
QUIET_FILTER='error TS|error:' quiet_run typecheck pnpm typecheck
