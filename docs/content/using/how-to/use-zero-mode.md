---
title: "Use zero mode"
description: "Run a single prompt from the command line with ethos -z, pipe stdin, capture output, and resume sessions non-interactively."
kind: how-to
audience: user
slug: use-zero-mode
time: "5 min"
updated: 2026-06-09
---

## Task

Run a single prompt through the agent from the command line, without entering the interactive REPL.

## Result

`ethos -z "prompt"` sends one [turn](../../getting-started/glossary.md#turn), streams the response to stdout, executes any tool calls, and exits. The output is scriptable, pipeable, and capturable.

## Prereqs

- `ethos` installed; `ethos --version` returns a version string.
- A provider configured via `ethos setup` ([Configure an LLM provider](configure-providers.md)).

## Steps

### 1. Run a basic prompt

Pass `-z` (zero mode) followed by a quoted prompt string.

```bash
ethos -z "what is 2+2"
```

```text
$ ethos -z "what is 2+2"
4
$
```

The agent processes the prompt, streams the response, and returns to the shell. No REPL, no session menu, no follow-up prompt.

### 2. Pipe stdin as context

Pipe file contents or command output into `ethos -z`. The piped input becomes context prepended to the prompt.

```bash
cat src/auth.ts | ethos -z "find bugs"
```

```text
$ cat src/auth.ts | ethos -z "find bugs"
Line 42: `token` is compared with `==` instead of `===`. This allows
type coercion — an attacker could pass a numeric string that coerces
to match.

Line 78: The JWT expiry check uses `Date.now()` in seconds but
`exp` is in milliseconds. Tokens expire 1000x earlier than intended.
$
```

Any command that writes to stdout works as input. The agent sees the full piped content as context for the prompt.

### 3. Use as a git hook

Combine `git diff` with zero mode for automated code review on staged changes.

```bash
git diff --staged | ethos -z "review for security issues"
```

```text
$ git diff --staged | ethos -z "review for security issues"
Security review of staged changes:

1. src/api/users.ts:23 — SQL query built with string concatenation.
   Use parameterized queries to prevent injection.

2. src/config.ts:8 — AWS_SECRET_KEY added as a string literal.
   Move to environment variable or secrets manager.

No other issues found.
$
```

Add this to `.git/hooks/pre-commit` to run automatically before every commit:

```bash
#!/bin/sh
ISSUES=$(git diff --staged | ethos -z "list only critical security issues, one per line. if none, print NONE" --no-stream)
if [ "$ISSUES" != "NONE" ]; then
  echo "$ISSUES"
  exit 1
fi
```

### 4. Capture output into a variable

Use `--no-stream` to buffer the entire response before printing. This prevents partial output from landing in shell variables.

```bash
RESULT=$(ethos -z "what is 2+2" --no-stream)
echo "The answer is: $RESULT"
```

```text
$ RESULT=$(ethos -z "what is 2+2" --no-stream)
$ echo "The answer is: $RESULT"
The answer is: 4
$
```

Without `--no-stream`, streaming chunks may interleave with other shell output in scripts. Always use `--no-stream` when capturing into a variable or piping to another command.

### 5. Select a personality

Override the default [personality](../../getting-started/glossary.md#personality) with `--personality`.

```bash
ethos -z "brief me on AAPL" --personality swing-trader
```

```text
$ ethos -z "brief me on AAPL" --personality swing-trader
AAPL — $198.42 (+1.2%)

Setup: Consolidating above 20-day MA ($195.10). Volume declining
into the base — accumulation pattern. Watch $200 resistance.

Bias: Long above $195. Stop at $192.
$
```

The personality's [SOUL.md](../../getting-started/glossary.md#ethos-md), toolset, and model configuration apply for the single turn.

### 6. Resume an existing session

Pass `--session <id>` to continue a previous conversation. The agent loads the full [session](../../getting-started/glossary.md#session) history as context.

```bash
ethos -z "summarize what we discussed" --session my-project
```

```text
$ ethos -z "what files did we change?" --session my-project
In our previous session, we modified:

1. src/auth.ts — added JWT refresh token rotation
2. src/middleware.ts — added rate limiting
3. tests/auth.test.ts — added 4 test cases for token refresh
$
```

Without `--session`, each `-z` invocation starts a fresh context. Use `--session` when a follow-up turn needs prior context.

### 7. Override the model

Pass `--model` to select a different [LLM provider](../../getting-started/glossary.md#llm-provider) model for the turn.

```bash
ethos -z "explain this error" --model claude-sonnet-4-20250514
```

Combine flags freely:

```bash
cat logs/crash.txt | ethos -z "diagnose" --personality devops --model claude-sonnet-4-20250514 --no-stream
```

## Flag reference

| Flag | Short | Effect |
|---|---|---|
| `-z "prompt"` | | Run one turn and exit |
| `--no-stream` | | Buffer response; print all at once |
| `--session <id>` | `-s` | Resume an existing session |
| `--personality <id>` | `-p` | Use a specific personality |
| `--model <model>` | `-m` | Override the model for this turn |

## Verify

Run a simple prompt and confirm the shell returns to `$` after the response:

```bash
ethos -z "echo hello"
```

Expected: the agent responds and the process exits with code 0. Confirm with:

```bash
ethos -z "say ok" --no-stream && echo "exit code: $?"
```

```text
$ ethos -z "say ok" --no-stream && echo "exit code: $?"
ok
exit code: 0
$
```

## Troubleshoot

**Response streams but the shell hangs.** -- A tool call is waiting for input (e.g. a `bash` tool prompting for confirmation). Zero mode executes tools non-interactively. If a tool requires stdin, it times out after the configured tool timeout. Avoid prompts that trigger interactive tools, or configure the personality's toolset to exclude them.

**`--session` returns stale context.** -- The session ID is a string key, not a path. Verify the exact ID with `ethos session list`. Session IDs are case-sensitive.

**Piped input is truncated.** -- Large inputs are subject to the [tool result budget](../../getting-started/glossary.md#tool-result-budget). For files over 80,000 characters, split the input or use a prompt that tells the agent to read the file directly with the `read_file` tool.

**`--no-stream` produces no output.** -- The model returned an empty response. Run without `--no-stream` to see if the agent is making tool calls that produce side effects but no final text. Add "reply with your findings" to the prompt to force text output.

**`personality not found: <id>`.** -- The personality directory does not exist at `~/.ethos/personalities/<id>/` or is missing `config.yaml`. Run `ethos personality list` to see available personalities.
