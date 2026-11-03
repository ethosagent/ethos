# Migrating from OpenClaw or Hermes

[Back to the README](../../README.md)

`ethos claw migrate` carries memory, skills, platform tokens, and provider keys from an existing OpenClaw or Hermes install into the Ethos layout. Dry-run first:

```bash
ethos claw migrate --dry-run     # preview the plan; touches nothing
ethos claw migrate               # apply
```

What moves cleanly:

- `MEMORY.md` and `USER.md` → the new personality's memory scope, identical semantics.
- `SOUL.md` (OpenClaw) → a `migrated` personality with `SOUL.md` derived from it; built-in matches resolve automatically (`engineer.md` lands on the built-in `engineer`, etc.).
- Platform tokens (Telegram bot tokens, Slack app credentials, Discord tokens) → the new `SecretsResolver` with `chmod 0600`, referenced from `config.yaml` as `${secrets:slack/<bot>/botToken}`.
- Provider API keys → `~/.ethos/secrets/providers/<provider>/apiKey`.
- Skills directory → unchanged path semantics; OpenClaw-compat parses `SKILL.md` frontmatter, env substitutions, and OS gates, so existing clawhub skills install and run without modification.

Idempotent — safe to re-run. What does not move (and why is documented in the migration guide):

- Anything that was inline plaintext in `config.yaml` migrates to the secrets resolver; the config file gets rewritten to use `${secrets:...}` refs.
- Personality boundary settings (`fs_reach`, `safety.network.allow`) are *added* on migration with safe defaults; review them before the first bot run.

Full migration reference: [Migrate from OpenClaw →](https://ethosagent.ai/docs/using/how-to/migrate-from-openclaw).

You can also stay on your existing setup and install Ethos-native skills *into* OpenClaw or Hermes — every Ethos skill is `SKILL.md`-shaped and runs unmodified. The migration command is for operators who want the full personality-is-architecture model.
