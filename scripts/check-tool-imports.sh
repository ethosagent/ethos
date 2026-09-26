#!/usr/bin/env bash
# Check for direct side-effect imports in tool source files.
#
# Tool code should use ctx.* (network, fs, secrets, process, storage) instead
# of importing node:fs or node:child_process directly.
#
# process.env is NOT scanned here: archcheck's `tools-read-env-through-ctx` rule
# (architecture.config.ts) owns it, with its exceptions recorded there. This
# script keeps the node:fs / node:child_process import scan, which archcheck
# cannot express (it cannot ban a Node built-in import).
#
# During the capability migration (P1→P5) this script is advisory — it prints
# violations but exits 0. After P5, flip BLOCKING=1 to fail the build.
set -euo pipefail

BLOCKING="${TOOL_IMPORT_LINT_BLOCKING:-1}"
violations=0

# Scan non-test source files under extensions/tools-*/src/
while IFS= read -r file; do
  # Skip test files
  case "$file" in
    *__tests__*|*.test.ts|*.spec.ts) continue ;;
  esac

  # tools-process internals: plan Q9 allows thin abstractions below ctx.process
  case "$file" in
    *tools-process/src/spawn.ts|*tools-process/src/operations.ts|*tools-process/src/registry.ts|*tools-process/src/watcher.ts) continue ;;
  esac

  # tools-code/src/shim/js-shim.ts: textual false positive — the `node:fs` import lives inside a
  # String.raw literal (the container-side shim client source delivered at exec time); the module
  # itself performs no host filesystem access. Same carve-out CLAUDE.md records for no-raw-fs.
  case "$file" in
    *tools-code/src/shim/js-shim.ts) continue ;;
  esac

  hits=$(awk '
    /from .node:fs|from .node:child_process/ { print NR": "$0 }
  ' "$file" 2>/dev/null || true)

  if [ -n "$hits" ]; then
    echo "TOOL-IMPORT: $file"
    echo "$hits" | sed 's/^/  /'
    echo ""
    violations=$((violations + 1))
  fi
done < <(find extensions/tools-*/src -name '*.ts' -type f 2>/dev/null)

if [ "$violations" -gt 0 ]; then
  echo "Found $violations file(s) with direct side-effect imports."
  echo "Tools should use ctx.* capabilities instead."
  if [ "$BLOCKING" = "1" ]; then
    echo "BLOCKING=1 — failing build."
    exit 1
  else
    echo "(advisory — set TOOL_IMPORT_LINT_BLOCKING=1 to fail)"
  fi
else
  echo "No direct side-effect imports found in tool sources."
fi
