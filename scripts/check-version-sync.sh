#!/usr/bin/env bash
# Verify VERSION file consistency across the workspace; PR-mode adds extra checks.
# Called by: CI's `version-sync` job; local devs running pre-push verification.
set -euo pipefail
exec node scripts/verify-version.js --pr
