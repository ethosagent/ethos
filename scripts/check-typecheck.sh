#!/usr/bin/env bash
# Run tsc --noEmit across packages + apps/web.
# Called by: CI's `typecheck` job; sandbox Stop hook (future work); local devs.
set -euo pipefail
exec pnpm typecheck
