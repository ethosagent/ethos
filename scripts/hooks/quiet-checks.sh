#!/usr/bin/env bash
# Claude Code PreToolUse hook (matcher: Bash): deny a whole-suite `pnpm test` / `pnpm check` and
# point at the quiet runners, which print failures only and keep full logs under .logs/.
#
# Only a command segment (split on `&&`, `||`, `;`, `|`, newline) that is exactly `pnpm test` or
# `pnpm check` (also `pnpm run test`, `pnpm -w test`, extra spaces) is denied. It denies instead
# of rewriting with `updatedInput`, because a rewrite needs `permissionDecision: "allow"`, which
# would also skip the permission prompt.
# Fail-open: any parse error exits 0 with no output.
#
# Registered in .claude/settings.json (maintainer-applied; see plan/context-budget-1-settings.diff).

HOOK_INPUT="$(cat)"
# Cheap superset prefilter: skips the Node cold start only when the payload cannot contain both
# `pnpm` and `test`/`check`. Node decides the real match, so this must never be narrower than it.
case "$HOOK_INPUT" in
  *pnpm*test* | *pnpm*check*) ;;
  *) exit 0 ;;
esac
export HOOK_INPUT

exec node --input-type=module - <<'JS'
try {
  const input = JSON.parse(process.env.HOOK_INPUT || "{}");
  const command = input.tool_name === "Bash" ? String(input.tool_input?.command ?? "") : "";
  const RE = /^\s*pnpm(\s+(run|-w|--workspace-root))*\s+(test|check)\s*$/;
  const hit = command.split(/&&|\|\||;|\||\n/).some((s) => RE.test(s));
  if (hit) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Use the quiet runner: bash scripts/check-tests.sh (tests) or bash scripts/run-checks.sh (full gate); full output lands in .logs/.",
        },
      })}\n`,
    );
  }
} catch {
  // fail open
}
JS
