#!/usr/bin/env bash
# Verify VERSION file consistency across the workspace; PR-mode adds extra checks.
# Called by: CI's `version-sync` job; local devs running pre-push verification.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh"
quiet_run version-sync node scripts/verify-version.js --pr
