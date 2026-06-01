#!/usr/bin/env bash
# Stop hook: quality gate — lint, typecheck, scoped tests, docs check, tool-import check.
# Runs only the checks relevant to what actually changed in the active worktree.
# Silent on clean; emits systemMessage JSON on failures.
#
# {{ETHOS_DIR}} is rendered by sandbox-setup.sh.

set -uo pipefail

ETHOS_DIR="{{ETHOS_DIR}}"

# ── locate active repo root ───────────────────────────────────────────────────
# Prefer a git worktree if we're inside one, fall back to canonical checkout.
REPO_ROOT="$(git -C "$ETHOS_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$ETHOS_DIR")"

# ── detect changed files ──────────────────────────────────────────────────────
changed="$(git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null)"
[ -z "$changed" ] && exit 0   # nothing uncommitted — skip all checks

# Classify what changed
has_source=0     # .ts / .tsx / .js (non-test)
has_tests=0      # *.test.ts / __tests__/
has_docs=0       # docs/content/**
has_tools=0      # extensions/tools-*/src/**
has_config=0     # *.json / *.yaml / *.md (non-docs)

while IFS= read -r f; do
  case "$f" in
    docs/content/*)   has_docs=1 ;;
    extensions/tools-*/src/*.ts|extensions/tools-*/src/*.js) has_tools=1; has_source=1 ;;
    *.test.ts|*/__tests__/*)  has_tests=1 ;;
    *.ts|*.tsx|*.js)  has_source=1 ;;
    *.json|*.yaml|*.yml|*.md) has_config=1 ;;
  esac
done <<< "$changed"

# docs-only: skip typecheck/tests/lint entirely
if [ "$has_docs" = 1 ] && [ "$has_source" = 0 ] && [ "$has_tests" = 0 ] && [ "$has_config" = 0 ]; then
  cd "$REPO_ROOT"
  out="$(bash scripts/check-docs.sh 2>&1)"
  if [ $? -ne 0 ]; then
    msg="$(printf '%s' "$out" | tail -20 | sed 's/"/\\"/g; s/$/\\n/' | tr -d '\n')"
    printf '{"systemMessage":"❌ docs check failed:\\n%s"}' "$msg"
  fi
  exit 0
fi

# config-only: just lint
if [ "$has_config" = 1 ] && [ "$has_source" = 0 ] && [ "$has_tests" = 0 ] && [ "$has_docs" = 0 ]; then
  cd "$REPO_ROOT"
  out="$(bash scripts/check-lint.sh 2>&1)"
  if [ $? -ne 0 ]; then
    msg="$(printf '%s' "$out" | tail -20 | sed 's/"/\\"/g; s/$/\\n/' | tr -d '\n')"
    printf '{"systemMessage":"❌ lint failed (config change):\\n%s"}' "$msg"
  fi
  exit 0
fi

# ── source or test files changed — full quality gate ─────────────────────────
cd "$REPO_ROOT"

failures=()
outputs=()

# 1. typecheck + lint in parallel (only when source changed)
if [ "$has_source" = 1 ]; then
  tc_out="$(bash scripts/check-typecheck.sh 2>&1)"; tc_exit=$?
  lint_out="$(bash scripts/check-lint.sh 2>&1)"; lint_exit=$?
  if [ $tc_exit -ne 0 ]; then
    failures+=("typecheck")
    outputs+=("$(printf '%s' "$tc_out" | grep -E 'error TS|Error' | head -8 | sed 's/"/\\"/g')")
  fi
  if [ $lint_exit -ne 0 ]; then
    failures+=("lint")
    outputs+=("$(printf '%s' "$lint_out" | grep -E 'error|Found' | grep -v WARN | head -5 | sed 's/"/\\"/g')")
  fi
fi

# 2. scoped tests — detect changed packages, cap at 3
if [ "$has_source" = 1 ] || [ "$has_tests" = 1 ]; then
  pkg_dirs="$(printf '%s\n' $changed \
    | grep -E '^(packages|extensions|apps)/' \
    | sed 's|^\([^/]*/[^/]*\)/.*|\1|' \
    | sort -u)"
  pkg_count="$(printf '%s\n' $pkg_dirs | grep -c . 2>/dev/null || echo 0)"

  if [ "$pkg_count" -gt 3 ]; then
    # Too many packages changed — skip scoped tests, surface advisory
    outputs+=("tests skipped: $pkg_count packages changed (run pnpm test manually)")
  elif [ "$pkg_count" -gt 0 ]; then
    filter_args=""
    while IFS= read -r pkg_dir; do
      [ -z "$pkg_dir" ] && continue
      pkg_json="$REPO_ROOT/$pkg_dir/package.json"
      if [ -f "$pkg_json" ]; then
        pkg_name="$(node -e "console.log(require('$pkg_json').name)" 2>/dev/null || true)"
        [ -n "$pkg_name" ] && filter_args="$filter_args --filter $pkg_name"
      fi
    done <<< "$pkg_dirs"

    if [ -n "$filter_args" ]; then
      # shellcheck disable=SC2086
      test_out="$(pnpm $filter_args test 2>&1)"; test_exit=$?
      if [ $test_exit -ne 0 ]; then
        failures+=("tests")
        outputs+=("$(printf '%s' "$test_out" | grep -E 'FAIL|✗|AssertionError|× ' | head -8 | sed 's/"/\\"/g')")
      fi
    fi
  fi
fi

# 3. tool-import check (if tools source changed)
if [ "$has_tools" = 1 ]; then
  ti_out="$(bash scripts/check-tool-imports.sh 2>&1)"; ti_exit=$?
  if [ $ti_exit -ne 0 ]; then
    failures+=("tool-imports")
    outputs+=("$(printf '%s' "$ti_out" | head -8 | sed 's/"/\\"/g')")
  fi
fi

# 4. docs check (if docs changed alongside source)
if [ "$has_docs" = 1 ]; then
  doc_out="$(bash scripts/check-docs.sh 2>&1)"; doc_exit=$?
  if [ $doc_exit -ne 0 ]; then
    failures+=("docs")
    outputs+=("$(printf '%s' "$doc_out" | tail -10 | sed 's/"/\\"/g')")
  fi
fi

# ── emit result ───────────────────────────────────────────────────────────────
[ ${#failures[@]} -eq 0 ] && exit 0

# Build systemMessage
lines="❌ Quality gate — ${#failures[@]} failure(s): $(IFS=', '; echo "${failures[*]}")"
for i in "${!failures[@]}"; do
  lines="$lines\n[${failures[$i]}]\n${outputs[$i]}"
done

printf '{"systemMessage":"%s"}' "$(printf '%s' "$lines" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n')"
exit 0
