#!/usr/bin/env bash
# Run vitest across the workspace.
# Called by: CI's `tests` job; sandbox Stop hook (future work); local devs.
set -euo pipefail
exec pnpm test
