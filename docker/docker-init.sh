#!/bin/sh
set -e

STATE_DIR="${ETHOS_STATE_DIR:-/home/ethos/.ethos}"
CONFIG_FILE="${STATE_DIR}/config.yaml"

# Idempotent: if config already exists, exit successfully
if [ -f "$CONFIG_FILE" ]; then
  echo "config.yaml already exists at ${CONFIG_FILE}, skipping init."
  exit 0
fi

# Detect provider API key in priority order
if [ -n "$ANTHROPIC_API_KEY" ]; then
  PROVIDER="anthropic"
  API_KEY="$ANTHROPIC_API_KEY"
elif [ -n "$OPENAI_API_KEY" ]; then
  PROVIDER="openai"
  API_KEY="$OPENAI_API_KEY"
elif [ -n "$OPENROUTER_API_KEY" ]; then
  PROVIDER="openrouter"
  API_KEY="$OPENROUTER_API_KEY"
elif [ -n "$GOOGLE_API_KEY" ]; then
  PROVIDER="google"
  API_KEY="$GOOGLE_API_KEY"
else
  echo "ERROR: No provider API key found." >&2
  echo "Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GOOGLE_API_KEY" >&2
  exit 1
fi

# Ensure state directory exists
mkdir -p "$STATE_DIR"

# Write minimal config
cat > "$CONFIG_FILE" <<EOF
schemaVersion: 1
provider: ${PROVIDER}
apiKey: ${API_KEY}
EOF

echo "config.yaml created with provider: ${PROVIDER}"
