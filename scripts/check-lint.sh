#!/usr/bin/env bash
# Run Biome lint check.
# Called by: CI's `lint` job (advisory); sandbox Stop hook (future work); local devs.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/lib/quiet.sh
quiet_run lint pnpm lint
