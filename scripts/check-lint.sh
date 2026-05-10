#!/usr/bin/env bash
# Run Biome lint check.
# Called by: CI's `lint` job (advisory); sandbox Stop hook (future work); local devs.
set -euo pipefail
exec pnpm lint
