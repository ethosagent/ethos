---
title: "Production hardening: secrets, tokens, filesystem and network"
description: "Steps 1-4: plaintext secrets, token scopes, filesystem reach, network policy."
kind: how-to
audience: shared
time: "10 min"
updated: 2026-11-03
---

## Task

Move secrets out of plaintext config, scope the platform tokens, and declare filesystem reach and network policy for each personality.

## Result

Every step on this page is applied and the checks in [Verify](../production-hardening-checklist.md#verify) on the main page pass.

## Prereqs

Complete the [Prerequisites](../production-hardening-checklist.md#prerequisites) listed on the main page, [Production hardening checklist](../production-hardening-checklist.md).

## Steps

### 1. Move secrets out of plaintext config

Replace every literal credential in `~/.ethos/config.yaml` with a `${secrets:ref}` substitution. Ethos resolves these at startup through the configured secrets provider.

Available providers:

| Provider | When to use |
|---|---|
| `FileSecretsResolver` | Single-machine deployments. Reads from a JSON file outside `~/.ethos/` (e.g. `/etc/ethos/secrets.json`) with restrictive file permissions. |
| `EnvSecretsResolver` | Container deployments where secrets are injected as environment variables by the orchestrator. |
| AWS Secrets Manager | Production cloud deployments. Configure the resolver with the secret ARN; values are fetched at startup and cached for the process lifetime. |

**Verify:**

```bash
# Confirm no plaintext secrets remain in config
grep -rn 'sk-ant-\|sk-\|xoxb-\|AKIA' ~/.ethos/config.yaml
# Should return no matches

# Confirm secrets resolve at startup
ethos secrets list
# Should show each ref and its resolution status (resolved / missing)
```

### 2. Scope platform tokens to minimum privilege

Each platform token (Slack, Telegram, Discord, GitHub, Linear) should be minted with the narrowest scopes the agent actually needs. Over-scoped tokens widen the blast radius if a token leaks.

- Slack: `chat:write`, `channels:read`, `users:read` -- not `admin.*`.
- Telegram: BotFather token with no payment or group-admin permissions.
- Discord: bot scope only; no `Administrator` intent.
- GitHub: fine-grained PAT scoped to specific repos, read-only where possible.
- Linear: API key scoped to the workspace; no organisation-admin access.

For per-platform scope tables and rotation instructions, see [Least-privilege tokens](.././least-privilege-tokens.md).

**Verify:** Review each token's granted scopes in the platform's developer console. Confirm no token has admin-level access.

### 3. Declare filesystem reach per personality

Every personality must declare `fs_reach` in its `config.yaml` with explicit read and write paths. The global deny floor (`.ssh`, `.aws`, `/etc/shadow`, and the rest of the always-deny set) is enforced by `ScopedStorage` regardless of what `fs_reach` allows -- see [Security controls -- ScopedStorage](.././controls.md#scoped-storage-and-boundary-error).

```yaml
# ~/.ethos/personalities/engineer/config.yaml
fs_reach:
  read:
    - ~/projects/myapp
  write:
    - ~/projects/myapp/src
```

A personality with no `fs_reach` declaration gets no filesystem access beyond its own personality directory.

**Verify:**

```bash
ethos personality show <id>
# Check the "Filesystem reach" section.
# Confirm read/write paths match what this personality needs — nothing more.
```

### 4. Declare network policy per personality

Personalities with web tools (`web_extract`, `browse_url`, `browser_navigate`) should declare `safety.network.allow` in their config. A personality without an allow list (absent, `[]`, or `['*']`) can reach any public host -- the global SSRF, scheme-allowlist, and cloud-metadata controls still apply to all personalities. See [Security controls -- network](.././controls.md#per-personality-network-policy).

```yaml
# In the personality's config.yaml
safety:
  network:
    allow:
      - api.github.com
      - "*.slack.com"
```

**Verify:**

```bash
grep -A6 'network:' ~/.ethos/personalities/<id>/config.yaml
# Confirm only the hosts this personality needs are listed.
```

## Verify

Run the [Verify](../production-hardening-checklist.md#verify) steps on the main page once all parts are done.

## Troubleshoot

See [Troubleshooting](../production-hardening-checklist.md#troubleshooting) on the main page.
