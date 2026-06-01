---
name: session-audit
description: Analyze the current Claude Code session transcript for execution failures, classify each error type, and suggest concrete CLAUDE.md rules or settings.json hooks to surface them clearly on every future run. Use when asked to "audit this session", "what failed", "analyze errors", or "what went wrong".
allowed-tools: Bash
---

# Session Audit

Analyze the current Claude Code session for execution failures and present a structured report.

## Phase 1 — Parse transcript

Run the parse script:

```bash
python3 "$(dirname "$0")/scripts/parse-transcript"
```

The script outputs JSON:
```json
{
  "session": "<path>",
  "total_tool_calls": 42,
  "failures": [
    {
      "category": "git-state",
      "count": 1,
      "examples": ["fatal: 'messaging-queue-background' is already used by worktree at ..."],
      "suggestion": {
        "type": "claude_md",
        "rule": "Before any `git worktree add` or `git checkout -b`, first run `git worktree list` and `git branch --list <name>` to verify the target does not already exist."
      }
    }
  ]
}
```

## Phase 2 — Present the report

For each failure in the output, format it as:

```
## <CATEGORY> (<count> occurrence(s))

**What failed:**
> <example snippet — first 200 chars>

**Suggested fix:**
<type: CLAUDE.md rule | settings.json hook>
<the rule or hook config>
```

Categories and their fix types:
- `git-state` → CLAUDE.md rule about verifying git state before operations
- `typecheck` → CLAUDE.md rule to always run `pnpm typecheck` before declaring done
- `lint` → settings.json Stop hook: `cd <project> && pnpm lint 2>&1 | grep "error" | grep -v WARN || true`
- `build` → CLAUDE.md rule to run `pnpm build` in affected package before reporting complete
- `test` → CLAUDE.md rule to run `pnpm test` before declaring done
- `dependency` → CLAUDE.md rule to run `pnpm install && pnpm typecheck` after package changes
- `permission` → CLAUDE.md rule: never bypass hooks with --no-verify; investigate root cause
- `runtime` → CLAUDE.md rule to check `~/.ethos/logs/errors.jsonl` for context
- `exit-code` → no rule (informational only)

Show the full report and stop. Do not ask to apply anything.
