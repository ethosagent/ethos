#!/usr/bin/env bash
# PreToolUse hook: forbid Edit/Write/MultiEdit/NotebookEdit on paths under
# the canonical ethos checkout. Forces all work to happen in a worktree
# under {{WORKTREE_DIR}}/<slug>/.
#
# Reads the tool-call payload as JSON on stdin, exits 2 (with stderr
# message) to deny, exits 0 to allow.
#
# {{ETHOS_DIR}} and {{WORKTREE_DIR}} are rendered by sandbox-setup.sh.

set -euo pipefail

ETHOS_DIR="{{ETHOS_DIR}}"
WORKTREE_DIR="{{WORKTREE_DIR}}"

input="$(cat)"

tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty')
case "$tool_name" in
  Edit|Write|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

file_path=$(printf '%s' "$input" | jq -r '
  .tool_input.file_path
  // .tool_input.notebook_path
  // .tool_input.path
  // empty
')
[ -z "$file_path" ] && exit 0

abs=$(realpath -m -- "$file_path" 2>/dev/null || printf '%s' "$file_path")

case "$abs" in
  "$ETHOS_DIR"|"$ETHOS_DIR"/*)
    cat >&2 <<EOF
[sandbox-agent] Blocked $tool_name on $abs

Direct edits under $ETHOS_DIR are forbidden. Create a worktree and edit there:

  slug=<short-slug>
  git -C $ETHOS_DIR checkout -b "\$slug"
  git -C $ETHOS_DIR worktree add $WORKTREE_DIR/"\$slug" "\$slug"
  cd $WORKTREE_DIR/"\$slug"

Then re-run the edit against the worktree path
($WORKTREE_DIR/\$slug/...), not the canonical checkout.

This rule has no exceptions — see CLAUDE.md "Workflow — MANDATORY".
EOF
    exit 2
    ;;
esac

exit 0
