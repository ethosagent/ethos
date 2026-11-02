#!/usr/bin/env bash
# Run Biome lint check.
# Called by: CI's `lint` job (advisory); sandbox Stop hook (future work); local devs.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh"
quiet_run lint pnpm lint
