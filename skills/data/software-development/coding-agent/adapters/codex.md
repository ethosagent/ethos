# Adapter: OpenAI Codex CLI

Spawn the `codex` CLI as a delegated coding agent.

## Detection

```bash
which codex
codex --version
```

If either fails, refuse delegation and print:

> OpenAI Codex CLI is not installed. Install with `npm i -g @openai/codex` and either set `OPENAI_API_KEY` or run `codex login`.

## Authentication

Codex accepts either an API key or a login session. Check both:

```bash
[ -n "$OPENAI_API_KEY" ] || codex auth status
```

If neither is configured:

> Codex CLI is installed but no auth is configured. Set `OPENAI_API_KEY` in the environment, or run `codex login` once.

## Invocation

```bash
codex exec "<task description>"
```

Flags worth knowing:

| Flag | Purpose |
|---|---|
| `exec` | One-shot mode — runs the task and exits. |
| `--cd <path>` | Working directory. |
| `--model <id>` | Override default model. |
| `--full-auto` | Auto-approve safe operations. Use with caution. |

## Best for

- Fast iteration loops on smaller scoped changes.
- Tasks where the user wants a second opinion against a different model family.
- Quick prototypes where speed matters more than depth.

## Avoid for

- Sensitive codebases where you do not want code shipped to a third-party API by default.
- Tasks that require a deep multi-file plan; Codex is faster but less deliberative.
