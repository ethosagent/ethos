#!/bin/sh
set -e
case "${ETHOS_MODE:-all}" in
  all)     exec ethos run-all "$@" ;;
  gateway) exec ethos gateway start "$@" ;;
  ui)      exec ethos serve --web-experimental "$@" ;;
  *)       echo "Unknown ETHOS_MODE: $ETHOS_MODE (valid: all, gateway, ui)" >&2; exit 1 ;;
esac
