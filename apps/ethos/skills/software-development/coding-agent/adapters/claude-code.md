# Adapter: Claude Code

Spawn the `claude` CLI as a delegated coding agent.

## Detection

```bash
which claude || command -v claude       # path resolution
claude --version                         # version sanity check
```

If either fails, refuse delegation and print:

> Claude Code CLI is not installed. Install with `npm i -g @anthropic-ai/claude-code` and authenticate with `claude auth login`.

## Authentication

```bash
claude auth status
```

If unauthenticated:

> Claude Code is installed but not authenticated. Run `claude auth login` and complete the browser flow, then retry.

## Invocation

```bash
claude --print --output-format text "<task description>"
```

Flags worth knowing:

| Flag | Purpose |
|---|---|
| `--print` / `-p` | One-shot mode (no interactive REPL). Required for delegation from a process. |
| `--output-format text` | Plain text output, easier to capture into a log. |
| `--cwd <path>` | Run inside a specific working directory (use the project root). |
| `--model <id>` | Override the model — pass through if the user specified one. |

## Best for

- Large refactors that span many files.
- Multi-file edits where the same change pattern is applied repeatedly.
- Tasks that benefit from deep codebase reasoning before editing.

## Avoid for

- One-line fixes (overhead is not worth it).
- Tasks where the failure mode of "spends 20 minutes thinking" is unacceptable.
