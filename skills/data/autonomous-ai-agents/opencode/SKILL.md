---
name: opencode
description: Deep-dive reference for delegating implementation work to the OpenCode CLI. Provider-agnostic — pick it when the user wants a specific non-Anthropic, non-OpenAI model (local Ollama, Bedrock, Vertex, Azure). Covers binary resolution, one-shot mode, provider selection, and common pitfalls.
version: 1.0.0
author: ethosagent
tags: [delegation, opencode, coding-agent]
required_tools: [terminal, process_start, process_logs, process_stop]

ethos:
  category: delegation-and-orchestration
  default_personalities: [engineer, coordinator]
  prerequisites:
    external_cli: [opencode]
    auth: ["opencode login (per-provider auth)"]
    env_vars: []
    optional_tools: [memory_write]
  integrates_with:
    - skill: coding-agent
      role: coding-agent routes here when opencode is the chosen CLI
  surface_metadata:
    invocation_trigger: "coding-agent selected opencode as the delegation target; user says 'use OpenCode for this' or wants a specific non-Anthropic/non-OpenAI model"
    estimated_turns: "2-5"
---

# OpenCode — Deep-Dive Delegation Reference

Comprehensive reference for spawning and managing the OpenCode CLI (`opencode`) as a delegated coding agent under ethos process control. OpenCode is provider-agnostic — it connects to any LLM backend (Ollama, AWS Bedrock, Google Vertex, Azure OpenAI, OpenRouter, and more).

## When to use

- **Provider-agnostic delegation** — the user wants a specific model that neither Claude Code nor Codex exposes (local Ollama, a Bedrock-hosted model, an enterprise Azure deployment, a Google Vertex model).
- **Cost-controlled environments** — where the choice of provider matters for billing, data residency, or compliance reasons.
- **Local models** — when the user wants to run a local LLM (via Ollama) for privacy or offline work.
- **Multi-provider comparison** — delegate the same task to multiple providers via OpenCode and compare results.

**Do not use** when Claude Code or Codex would suffice. Those CLIs have tighter integration with their respective APIs and less surface area for configuration errors. OpenCode's strength is flexibility, not depth — use it when flexibility is what you need.

## Binary resolution and PATH caveat

OpenCode may not be in `$PATH` depending on how it was installed. Always verify before delegating:

```bash
which opencode || command -v opencode
```

If the command is not found, check common installation locations:

```bash
# npm global install
ls ~/.local/bin/opencode 2>/dev/null

# npm local install (project-local)
ls ./node_modules/.bin/opencode 2>/dev/null

# Go install
ls ~/go/bin/opencode 2>/dev/null

# Homebrew
ls /opt/homebrew/bin/opencode 2>/dev/null
```

If none of these resolve, the CLI is not installed. Print the install instructions:

> OpenCode is not installed. Install with `npm i -g opencode-ai` (or see https://opencode.ai for alternative install methods) and authenticate with `opencode login`.

### Version check

After resolving the binary, verify the version:

```bash
opencode --version
```

Some features (like `--format json`) are version-dependent. Document the minimum version you tested against when adding new invocation patterns.

## One-shot invocation — the core pattern

```bash
opencode run "<task description>"
```

`run` mode executes the task and exits. This is the canonical pattern for delegation from `process_start`. Do not use interactive mode — it opens a TUI that cannot be driven programmatically.

### Minimal delegation

```bash
process_start({
  command: 'opencode run "Add error handling to the database connection pool in src/db/pool.ts"',
  name: 'delegated-opencode-db-error-handling',
  cwd: '/path/to/project'
})
```

### With provider and model

```bash
process_start({
  command: 'opencode run "Refactor the auth middleware to support JWT rotation" --model ollama/llama3',
  name: 'delegated-opencode-auth-refactor',
  cwd: '/path/to/project'
})
```

## Provider and model selection

OpenCode's key differentiator is provider flexibility. The `--model` flag uses a `provider/model` syntax:

### Provider examples

| Provider | Syntax | Auth required |
|---|---|---|
| Ollama (local) | `--model ollama/llama3` | None (local) |
| AWS Bedrock | `--model bedrock/anthropic.claude-v2` | AWS credentials |
| Google Vertex | `--model vertex/gemini-pro` | GCP credentials |
| Azure OpenAI | `--model azure/gpt-4` | Azure credentials |
| OpenRouter | `--model openrouter/anthropic/claude-3.5-sonnet` | OPENROUTER_API_KEY |
| Together | `--model together/meta-llama/Llama-3-70b` | TOGETHER_API_KEY |

### Provider selection guidelines

- **Local/private:** Ollama — no data leaves the machine. Best for sensitive codebases or offline work.
- **Enterprise AWS:** Bedrock — uses existing AWS IAM roles. Best for teams already on AWS.
- **Enterprise GCP:** Vertex — uses existing GCP service accounts. Best for teams already on GCP.
- **Enterprise Azure:** Azure OpenAI — uses existing Azure AD. Best for teams on Azure.
- **Cost optimization:** OpenRouter or Together — access many models with a single API key, often at lower cost.

### Authentication per provider

Each provider has its own auth flow. Run `opencode login` and follow the interactive setup, or set the provider-specific environment variable before spawning:

```bash
# Ollama — no auth needed (local)
# Bedrock — standard AWS credential chain (AWS_PROFILE, AWS_ACCESS_KEY_ID, etc.)
# Vertex — standard GCP credential chain (GOOGLE_APPLICATION_CREDENTIALS, gcloud auth)
# Azure — standard Azure credential chain (AZURE_OPENAI_API_KEY, az login)
# OpenRouter — OPENROUTER_API_KEY
```

## The `/exit` trap

In interactive mode (the TUI), `/exit` is the only way to quit cleanly. `Ctrl+C` may leave the process dangling with orphaned child processes.

**This does not apply to `run` mode** — one-shot invocations exit cleanly on their own. But if someone accidentally spawns OpenCode in interactive mode (by omitting `run`), the only reliable cleanup is:

1. Send `/exit` via the PTY.
2. If that fails, `process_stop` (SIGTERM).
3. If that fails, SIGKILL.

Always use `run` mode for delegation to avoid this entirely.

## Smoke test

Before delegating real work, verify the CLI and provider are functional:

```bash
opencode run "echo hello"
```

This should produce a response within a few seconds. If it hangs, errors, or produces no output:

1. Check that the provider is reachable (network, auth).
2. Check that the model exists on the provider.
3. Check `opencode --version` for a supported version.

Run the smoke test once per session, not per delegation.

## Structured output with `--format json`

When available (version-dependent), use `--format json` for structured output:

```bash
opencode run "<task>" --format json
```

Expected JSON shape (when supported):

```json
{
  "result": "The response text — what was done.",
  "model": "ollama/llama3",
  "duration_ms": 12400
}
```

### Fallback for plain text

Not all OpenCode versions support `--format json`. The fallback parsing strategy:

```
1. Check if --format json is supported: opencode run "test" --format json 2>&1
2. If it errors with "unknown flag", fall back to plain text mode.
3. In plain text mode, capture raw stdout as the result.
4. Use the exit code as the success/failure indicator.
```

Always attempt JSON first and fall back gracefully. Do not hard-fail on a missing `--format` flag.

## Working directory

Set the project root explicitly with `--cwd`:

```bash
opencode run "<task>" --cwd /absolute/path/to/project
```

If `--cwd` is not supported by the installed version, set the working directory via `process_start`'s `cwd` parameter instead. Both achieve the same result — `process_start.cwd` is the more reliable option since it works regardless of OpenCode version.

## Session continuation

Resume the last session for the current directory:

```bash
opencode run "<follow-up task>" --continue
```

`--continue` carries over the conversation history from the previous invocation in the same directory. Use it for multi-step delegations where context should accumulate (e.g., "now add tests for what you just changed").

**Caveat:** session continuation is directory-scoped. If you use worktrees, each worktree has its own session history. This is usually the desired behavior — parallel delegations in different worktrees should not share context.

## Error recovery

### Common failures

| Symptom | Cause | Recovery |
|---|---|---|
| "command not found" | Binary not in PATH | Check install locations (see Binary Resolution above) |
| Connection refused (Ollama) | Ollama server not running | Start it: `ollama serve` |
| Auth error (cloud providers) | Credentials expired or missing | Re-authenticate: `opencode login` or set the provider env var |
| Model not found | Model name typo or model not pulled | For Ollama: `ollama pull <model>`. For cloud: verify model ID in provider docs |
| Timeout | Model too slow or network issue | Retry; for Ollama, check that the model fits in available RAM |
| Garbled output | Encoding issue with local model | Try a different model; some local models produce malformed output |

### Recovery pattern

```
1. Capture exit code and stderr from process_logs.
2. Match stderr against known failure patterns.
3. For transient errors (timeout, rate limit): retry up to 2 times with a 30-second backoff.
4. For permanent errors (auth, model not found): surface to the user with specific remediation.
5. For local model issues (Ollama): check RAM, model compatibility, and suggest alternatives.
```

## Delegation checklist

Before spawning an OpenCode delegation, verify:

1. `which opencode` succeeds — the CLI is installed.
2. Smoke test passes — `opencode run "echo hello"` produces output.
3. The target provider is reachable and authenticated.
4. The target model exists on the provider.
5. `--cwd` or `process_start.cwd` points to the correct project root.
6. A `process_start` name is chosen (descriptive slug).
7. The user has authorized the delegation.

## Comparison with other CLIs

| Dimension | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Provider | Anthropic only | OpenAI only | Any |
| Structured output | `--output-format json` (rich) | None (plain text) | `--format json` (if supported) |
| Tool scoping | `--allowedTools` | None | None |
| Git requirement | No | Yes | No |
| PTY requirement | No | Yes | No |
| Best for | Deep reasoning, large refactors | Fast iteration, batch ops | Provider flexibility, local models |

Use this table to choose the right CLI for the task. OpenCode is the fallback when the other two do not support the required provider or model.

## Hard rules

- **Always use `run` mode.** Interactive TUI mode cannot be driven from `process_start`.
- **Always smoke-test first.** Provider misconfigurations fail silently or with opaque errors.
- **Always verify the binary is in PATH.** OpenCode installs vary — do not assume it is available.
- **Never delegate without the process tool.** Without `process_start`, the orchestrator blocks for the full duration and the user cannot kill the delegation.
- **Fall back gracefully on `--format json`.** Not all versions support it — parse plain text as a fallback.

# Adapted from NousResearch/hermes-agent (MIT)
