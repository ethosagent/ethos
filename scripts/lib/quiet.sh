#!/usr/bin/env bash
# quiet_run <name> <cmd...>: run a check with output captured to .logs/<name>.log.
# Success prints nothing. Failure prints the tail of the log (filtered by
# $QUIET_FILTER, an extended regex, when set and matching) plus the log path, and
# returns the command's exit code. QUIET=0 streams output as before.
# Logs are relative to the cwd; callers cd to the repo root first.

quiet_run() {
  local name="$1"
  shift
  if [ "${QUIET:-1}" = "0" ]; then
    "$@"
    return $?
  fi
  mkdir -p .logs
  local log=".logs/${name}.log"
  : >"$log"
  local code=0
  "$@" >>"$log" 2>&1 || code=$?
  if [ "$code" -ne 0 ]; then
    local shown=""
    if [ -n "${QUIET_FILTER:-}" ]; then
      shown="$(grep -E "$QUIET_FILTER" "$log" | tail -n 40 || true)"
    fi
    if [ -z "$shown" ]; then
      shown="$(tail -n 40 "$log")"
    fi
    printf '%s\n' "$shown"
    echo "log: $log"
  fi
  return "$code"
}
