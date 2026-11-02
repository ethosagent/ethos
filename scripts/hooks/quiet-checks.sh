#!/usr/bin/env bash
# Claude Code PreToolUse hook (matcher: Bash): deny a whole-suite `pnpm test` / `pnpm check` and
# point at the quiet runners, which print failures only and keep full logs under .logs/.
#
# The command is split on `&&`, `||`, `;`, `|` and newlines; only a segment that is exactly
# `pnpm test` or `pnpm check` is denied. `pnpm test <path>`, `pnpm test:integration`,
# `pnpm typecheck` and `bash scripts/check-tests.sh` pass. It denies instead of rewriting with
# `updatedInput`, because a rewrite needs `permissionDecision: "allow"`, which would also skip the
# permission prompt. Any parse error exits 0 with no output.
#
# Registered in .claude/settings.json (maintainer-applied; see plan/context-budget-1-settings.diff).

HOOK_INPUT="$(cat)" exec node --input-type=module - <<'JS'
try {
  const input = JSON.parse(process.env.HOOK_INPUT || "{}");
  if (input.tool_name !== "Bash") process.exit(0);
  const command = String(input.tool_input?.command ?? "");
  const hit = command.split(/&&|\|\||;|\||\n/).some((s) => /^\s*pnpm (test|check)\s*$/.test(s));
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
process.exit(0);
JS
