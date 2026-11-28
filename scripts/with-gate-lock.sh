#!/usr/bin/env bash
# Run a heavy gate (typecheck/lint/test) one at a time per user across every git worktree.
# Usage: bash scripts/with-gate-lock.sh <cmd...>
# Lock: atomic `mkdir` (no flock on macOS) at ${ETHOS_GATE_LOCK_DIR:-${TMPDIR:-/tmp}/ethos-gate.lock};
# holds `pid` and `cwd`. A holder whose pid is dead is stale and gets taken over.
# Bypass (just exec): ETHOS_GATE_LOCK=0, CI set, or ETHOS_GATE_LOCK_HELD set (re-entrancy:
# children of a lock holder inherit it, so a nested `pnpm test` inside `pnpm check` cannot deadlock).
# ETHOS_GATE_LOCK_POLL overrides the 2s poll interval (tests).
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "usage: with-gate-lock.sh <cmd...>" >&2
  exit 2
fi

if [ "${ETHOS_GATE_LOCK:-}" = "0" ] || [ -n "${CI:-}" ] || [ -n "${ETHOS_GATE_LOCK_HELD:-}" ]; then
  export ETHOS_GATE_LOCK_HELD=1 # so a re-exec guarded on it (run-checks.sh) does not loop
  exec "$@"
fi

LOCK="${ETHOS_GATE_LOCK_DIR:-${TMPDIR:-/tmp}/ethos-gate.lock}"
POLL="${ETHOS_GATE_LOCK_POLL:-2}"
OWNED=0

release() {
  if [ "$OWNED" = 1 ] && [ "$(cat "$LOCK/pid" 2>/dev/null || true)" = "$$" ]; then
    rm -rf "$LOCK"
  fi
  OWNED=0
}
trap release EXIT
trap 'release; exit 130' INT
trap 'release; exit 143' TERM

holder_alive() {
  local pid
  pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

try_acquire() {
  mkdir "$LOCK" 2>/dev/null || return 1
  OWNED=1
  printf '%s\n' "$$" >"$LOCK/pid"
  pwd >"$LOCK/cwd"
}

# Move a stale lock aside atomically; if we grabbed a live one by mistake, put it back.
take_over_stale() {
  local aside="$LOCK.stale.$$"
  mv "$LOCK" "$aside" 2>/dev/null || return 0
  local pid
  pid="$(cat "$aside/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    mv "$aside" "$LOCK" 2>/dev/null || rm -rf "$aside"
  else
    rm -rf "$aside"
  fi
}

announced=0
nopid_polls=0
until try_acquire; do
  if [ -s "$LOCK/pid" ]; then
    nopid_polls=0
    holder_alive || { take_over_stale; continue; }
  else
    # Holder is between mkdir and writing its pid; only a crash there leaves this for long.
    nopid_polls=$((nopid_polls + 1))
    if [ "$nopid_polls" -ge 5 ]; then
      take_over_stale
      nopid_polls=0
      continue
    fi
  fi
  if [ "$announced" = 0 ]; then
    echo "gate lock: waiting for another run in $(cat "$LOCK/cwd" 2>/dev/null || echo unknown) (override: ETHOS_GATE_LOCK=0)" >&2
    announced=1
  fi
  sleep "$POLL"
done

export ETHOS_GATE_LOCK_HELD=1
rc=0
"$@" || rc=$?
exit "$rc"
