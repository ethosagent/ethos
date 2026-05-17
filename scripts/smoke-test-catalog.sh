#!/usr/bin/env bash
# Verifies the model-catalog.json exists and has the expected shape.
# Run after docs build in CI.
set -euo pipefail

CATALOG="docs/static/api/model-catalog.json"

if [ ! -f "$CATALOG" ]; then
  echo "ERROR: $CATALOG not found"
  exit 1
fi

VERSION=$(cat "$CATALOG" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.parse(d).version)")
if [ "$VERSION" != "1" ]; then
  echo "ERROR: expected version 1, got $VERSION"
  exit 1
fi

PROVIDERS=$(cat "$CATALOG" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(Object.keys(JSON.parse(d).providers).sort().join(','))")
if [ "$PROVIDERS" != "anthropic,azure,openai-compat" ]; then
  echo "ERROR: expected providers anthropic,azure,openai-compat, got $PROVIDERS"
  exit 1
fi

echo "OK: model-catalog.json version=$VERSION providers=$PROVIDERS"
