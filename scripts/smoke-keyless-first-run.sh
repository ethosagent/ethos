#!/usr/bin/env bash
# Release smoke for plan keyless-first-run §6.3 / §9.3 (run by hand before tagging;
# listed in RELEASE.md Step 1). Needs a running Ollama with the `< 12 GiB` tier
# model already pulled. Budget: <= 120 s first launch -> first answer on the
# reference machine, excluding download. A miss is a release note, not a blocker.
set -euo pipefail

command -v jq >/dev/null || { echo "smoke: jq is required" >&2; exit 2; }

export ETHOS_STATE_DIR="$(mktemp -d)"
trap 'rm -rf "$ETHOS_STATE_DIR"' EXIT
ETHOS="pnpm tsx apps/ethos/src/index.ts"
STATE="$ETHOS_STATE_DIR/funnel-state.json"
BUDGET_S=120

# Non-interactive: accepts only a `local` / `ethos-login` candidate.
$ETHOS setup --keyless
$ETHOS -z "Reply with the word ready."

jq -e '.firstLaunchAt and .firstReplyAt and .keylessPath == "local"' "$STATE" >/dev/null \
  || { echo "smoke: funnel-state.json is missing firstLaunchAt / firstReplyAt / keylessPath=local" >&2; cat "$STATE" >&2; exit 1; }

elapsed=$(jq -r '(.firstReplyAt - .firstLaunchAt) / 1000' "$STATE")
echo "first launch -> first answer: ${elapsed}s (budget ${BUDGET_S}s)"
if awk -v e="$elapsed" -v b="$BUDGET_S" 'BEGIN { exit !(e > b) }'; then
  echo "smoke: over budget; record it in the release notes" >&2
fi
