#!/usr/bin/env bash
# Run the docs-check page-acceptance gate (front-matter, voice, anchors,
# required sections, prohibited content, JSON-LD parse, length, orphans).
# Called by: CI's `docs` job; sandbox Stop hook (future work); local devs.
set -euo pipefail
exec pnpm docs:check
