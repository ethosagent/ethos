#!/bin/sh
set -e

# Single-service profile provisions config from env at boot (W1.3). The CLI
# `ethos setup --from-env` is idempotent by contract: config.yaml is written
# once (skip-if-exists), secrets re-sync from env every boot, and it emits the
# init last-line contract (✓ on success / an actionable error before a
# non-zero exit). The three-service topology provisions via a dedicated `init`
# service instead and leaves ETHOS_PROVISION_FROM_ENV unset.
if [ "${ETHOS_PROVISION_FROM_ENV:-0}" = "1" ]; then
  ethos setup --from-env
fi

case "${ETHOS_MODE:-all}" in
  all)     exec ethos run-all "$@" ;;
  gateway) exec ethos gateway start "$@" ;;
  ui)      exec ethos serve "$@" ;;
  *)       echo "Unknown ETHOS_MODE: $ETHOS_MODE (valid: all, gateway, ui)" >&2; exit 1 ;;
esac
