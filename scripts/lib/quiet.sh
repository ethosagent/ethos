#!/usr/bin/env bash
# quiet_run <name> <cmd...>: run a check from the repo root with output captured to
# <repo>/.logs/<name>.log. Success prints nothing. Failure prints the tail of the log (filtered by
# $QUIET_FILTER, an extended regex, when set and matching) plus the repo-relative log path, and
# returns the command's exit code. QUIET=0 streams output instead.
# The repo root comes from this file's own location, so callers may run from any cwd.

quiet_run() {
  local name="$1"
  shift
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  if [ "${QUIET:-1}" = "0" ]; then
    (cd "$root" && "$@")
    return $?
  fi
  mkdir -p "$root/.logs"
  local log="$root/.logs/${name}.log"
  local code=0
  (cd "$root" && "$@") >"$log" 2>&1 || code=$?
  if [ "$code" -ne 0 ]; then
    local shown=""
    if [ -n "${QUIET_FILTER:-}" ]; then
      shown="$(grep -E "$QUIET_FILTER" "$log" | tail -n 40 || true)"
    fi
    if [ -z "$shown" ]; then
      shown="$(tail -n 40 "$log")"
    fi
    printf '%s\n' "$shown"
    echo "log: .logs/${name}.log"
  fi
  return "$code"
}
