---
title: "Use zero mode: personality, session and model"
description: "Pick a personality, resume a session, or override the model for one ethos -z turn."
kind: how-to
audience: user
time: "3 min"
updated: 2026-11-03
---

## Task

Run one `ethos -z` turn with a chosen personality, a resumed session, or a different model.

## Result

The turn runs with the personality, session history, and model you named, prints the response, and exits with code 0.

## Prereqs

- Complete [steps 1 to 4](../use-zero-mode.md): `ethos -z "what is 2+2"` prints an answer.
- For `--personality`: a personality directory under `~/.ethos/personalities/<id>/`; `ethos personality list` shows the ids.
- For `--session`: a session id from `ethos sessions list`.

## Steps

### 5. Select a personality

Override the default [personality](../../../getting-started/glossary.md#personality) with `--personality`.

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

The personality's [SOUL.md](../../../getting-started/glossary.md#ethos-md), toolset, and model configuration apply for the single turn.

### 6. Resume an existing session

Pass `--session <id>` to continue a previous conversation. The agent loads the full [session](../../../getting-started/glossary.md#session) history as context.

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

Pass `--model` to select a different [LLM provider](../../../getting-started/glossary.md#llm-provider) model for the turn.

```bash
ethos -z "explain this error" --model claude-sonnet-5
```

Combine flags freely:

```bash
cat logs/crash.txt | ethos -z "diagnose" --personality devops --model claude-sonnet-5 --no-stream
```

## Verify

Run a turn with an override and confirm the exit code:

```bash
ethos -z "say ok" --model claude-sonnet-5 --no-stream && echo "exit code: $?"
```

Expected: the response prints, then `exit code: 0`.

## Troubleshoot

**`--session` returns stale context.** -- The session ID is a string key, not a path. Verify the exact ID with `ethos sessions list`. Session IDs are case-sensitive.

**`personality not found: <id>`.** -- The personality directory does not exist at `~/.ethos/personalities/<id>/` or is missing `config.yaml`. Run `ethos personality list` to see available personalities.
