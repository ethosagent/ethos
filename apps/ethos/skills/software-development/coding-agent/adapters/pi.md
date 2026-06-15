# Adapter: Pi (earendil-works)

Minimal terminal coding harness from earendil-works. Multi-provider (Anthropic, OpenAI, others via the model/provider flags), MIT licensed, open source. Useful when the user wants a specific provider the other CLIs don't expose, wants tight per-call tool allowlists, or wants OAuth-bound subscription billing without committing to one vendor's full CLI.

Source: `https://pi.dev/` · `github.com/earendil-works/pi` · package `@earendil-works/pi-coding-agent`

## Detection

Probe before spawning:

```bash
which pi && pi --version
```

If `pi` is missing, refuse with:

> Pi CLI not installed. Install with `npm install -g @earendil-works/pi-coding-agent` or `curl -fsSL https://pi.dev/install.sh | sh`, then retry.

## Authentication

Three auth paths. Any one works:

1. **Env var** — export `ANTHROPIC_API_KEY` (or the equivalent for the target provider) before `process_start`.
2. **OAuth** — user runs `pi /login` once interactively; pi stores credentials and reuses them. Providers: Anthropic, OpenAI, GitHub. Ties to upstream subscriptions where applicable (e.g. Claude.ai).
3. **Inline flag** — pass `--api-key <key>` to a single invocation. Avoid in shared sessions; the key lands in process args.

**Gap:** pi has no documented `pi auth status` command. To probe auth without running the real task, either:

- Check the env var directly (`ANTHROPIC_API_KEY` non-empty), or
- Invoke `pi -p ""` and grep stderr for an auth error before sending the real prompt.

Neither is great. Pick env-var probing in scripted contexts.

## Invocation

Canonical one-shot form:

```bash
pi -p "<task description>"
```

`-p` is short for `--print` — direct analog to `claude --print` and `codex exec`. Pi reads `AGENTS.md` from cwd, so spawn it via `process_start({ cwd: <repo-root> })`. Pi has no documented `--cwd` flag.

File input is supported:

```bash
pi -p @path/to/file.ts "Review this file"
cat README.md | pi -p "Summarize this"
```

### Flags

| Flag | Purpose |
|---|---|
| `-p`, `--print` | One-shot mode. Prints final output, exits. |
| `--mode <text\|json\|rpc>` | Output mode. `text` (default), `json` (event stream), `rpc` (subprocess integration — see deferred). |
| `--model <pattern>` | Model selector (e.g. `claude-sonnet-4-6`). Pattern syntax; check `pi --help`. |
| `--provider <name>` | Provider override (e.g. `anthropic`, `openai`). |
| `--thinking <off\|minimal\|low\|medium\|high\|xhigh>` | Reasoning budget. |
| `--tools <list>` | Comma-separated tool allowlist (`read,bash,edit,write,...`). Tight allowlists are pi's main differentiator. |
| `--no-session` | Ephemeral run. Don't persist session state. |
| `--system-prompt <text>` | Override system prompt. |
| `--session <path\|id>` | Resume a saved session. |
| `--fork <path\|id>` | Fork an existing session. |
| `--api-key <key>` | Inline auth (see Authentication). |
| `-v`, `--version` | Version. |
| `-h`, `--help` | Help. |

## Best for

- Multi-provider work where the user wants a specific model not exposed by claude-code or codex CLIs.
- Fine-grained tool allowlists per call (`--tools read,bash` for a read-only sweep).
- Ephemeral runs (`--no-session`) where session pollution is unwanted.
- OAuth-bound subscription billing without committing to a single vendor's CLI.

## Avoid for

- Environments without npm-global install rights (no system package equivalent yet).
- Tasks that need a clean `pi auth status` preflight — the probe workaround is brittle.
- Workflows already standardized on `claude-code` or `codex` — switching costs outweigh the multi-provider benefit unless the user explicitly asks.
