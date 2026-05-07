# Adapter: Pi (Inflection)

Spawn the `pi` CLI as a delegated coding agent. Pi optimizes for natural conversation flow — useful when the work involves a lot of back-and-forth clarification.

## Detection

```bash
which pi
pi --version
```

If either fails, refuse delegation and print:

> Pi CLI is not installed. Install per Inflection's documentation and authenticate with `pi login`.

## Authentication

```bash
pi auth status
```

If unauthenticated:

> Pi CLI is installed but no auth is configured. Run `pi login` and complete the browser flow.

## Invocation

The exact invocation depends on the Pi CLI version installed. The skill should:

1. Run `pi --help` once and parse the supported subcommands.
2. Prefer a `pi exec` / `pi run` / `pi chat --print` style depending on what the version exposes.
3. If no one-shot mode is available, fall back to driving Pi via stdin and capture output.

## Best for

- Tasks that benefit from natural-language clarification mid-flight.
- Lighter-touch code work (small features, refactor explanations).

## Avoid for

- Headless CI use cases where the CLI must be 100% non-interactive — verify a one-shot flag exists in the installed version first.

## Note

Pi's CLI surface evolves faster than the others'. If this adapter's flags do not match what your installed version exposes, run `pi --help` and update the invocation. Adapter PRs welcome.
