# Adapter: OpenCode

Spawn the `opencode` CLI as a delegated coding agent. OpenCode is provider-agnostic — pick it when the user wants a model that neither Claude Code nor Codex offers.

## Detection

```bash
which opencode
opencode --version
```

If either fails, refuse delegation and print:

> OpenCode is not installed. Install with `npm i -g opencode-ai` and authenticate with `opencode login`.

## Authentication

```bash
opencode auth status
```

If unauthenticated:

> OpenCode is installed but no provider is authenticated. Run `opencode login` and pick the provider you want to delegate to (Anthropic / OpenAI / Bedrock / Vertex / Azure / Ollama / etc.).

## Invocation

```bash
opencode run "<task description>"
```

Flags worth knowing:

| Flag | Purpose |
|---|---|
| `run` | One-shot mode. |
| `--model <provider/model>` | Pick the exact provider+model. |
| `--cwd <path>` | Working directory. |
| `--continue` | Resume the last session for this directory. |

## Best for

- The user wants to delegate to a specific model family that the other CLIs don't expose (e.g. a local Ollama model, a Bedrock-hosted model, an enterprise Azure deployment).
- Cost-controlled environments where the provider matters.

## Avoid for

- Tasks where you don't need provider flexibility — Claude Code or Codex have less surface area.
