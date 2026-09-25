#!/bin/sh
set -e

# The state dir must be writable by the runtime user. A fresh named volume is
# (the Dockerfile chowns /home/ethos/.ethos, which Docker copies into it); a
# bind-mounted host directory keeps the HOST's ownership and mode, and an
# unwritable one used to crash-loop every child with a raw `EACCES: mkdir …`
# stack. Refuse it once, by name, with the fix. A real write probe, not
# `test -w`: through Docker Desktop's file sharing a read-only bind reports
# writable to access(2) and still fails the mkdir.
STATE_DIR="${ETHOS_STATE_DIR:-$HOME/.ethos}"
if [ -d "$STATE_DIR" ]; then
  probe="$STATE_DIR/.ethos-write-probe.$$"
  if ! ( : > "$probe" ) 2>/dev/null; then
    echo "ethos: state dir $STATE_DIR (owner $(stat -c '%u:%g mode %a' "$STATE_DIR" 2>/dev/null || echo '?')) is not writable by uid $(id -u) — on the host, run: sudo chown -R $(id -u):$(id -g) <the directory you mounted there> && sudo chmod -R u+rwX <that directory>" >&2
    exit 1
  fi
  rm -f "$probe"
fi

# Single-service profile provisions config from env at boot (W1.3). The CLI
# `ethos setup --from-env` is idempotent by contract: config.yaml is written
# once (skip-if-exists), secrets re-sync from env every boot, and it emits the
# init last-line contract (✓ on success / an actionable error before a
# non-zero exit). The three-service topology provisions via a dedicated `init`
# service instead and leaves ETHOS_PROVISION_FROM_ENV unset.
if [ "${ETHOS_PROVISION_FROM_ENV:-0}" = "1" ]; then
  ethos setup --from-env
fi

# `boot` is the merged single-process profile: gateway role + serve role in ONE
# process, so boot-time reconciliation runs in full on every start
# (plan/phases/single-process-boot-profile.md). `all` still spawns two
# subprocesses and keeps the crash isolation between them; `boot` trades that
# isolation for one cold boot and complete reconciliation, which is the right
# call for a single-tenant scale-to-zero microVM and the wrong one for a
# shared always-on host.
# `boot` is now the default when ETHOS_MODE is unset: single-tenant deployments
# (Fly Machines, etc.) are the common case; docker-compose.yml's three-service
# topology and docker-compose.single.yml are unaffected because both set
# ETHOS_MODE explicitly.
case "${ETHOS_MODE:-boot}" in
  all)     exec ethos run-all "$@" ;;
  gateway) exec ethos gateway start "$@" ;;
  ui)      exec ethos serve "$@" ;;
  boot)    exec ethos boot "$@" ;;
  *)       echo "Unknown ETHOS_MODE: $ETHOS_MODE (valid: all, gateway, ui, boot)" >&2; exit 1 ;;
esac
