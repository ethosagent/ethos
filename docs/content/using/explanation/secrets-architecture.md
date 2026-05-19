---
title: "Why is Ethos's secrets architecture shaped this way?"
description: "Why Ethos uses per-ref secrets, lazy fetching, and SIGHUP cache invalidation — the design decisions behind the secrets resolver."
kind: explanation
audience: shared
slug: secrets-architecture
updated: 2026-05-19
---

## Context

Ethos needs provider API keys and channel bot tokens to function. Those [secrets](../../getting-started/glossary.md#secret) have to live somewhere, and every "somewhere" has a threat model. A `.env` file on an encrypted EBS volume is the simplest option and the default. But the moment you ask "what if someone snapshots the volume?" or "who accessed the Anthropic key last Tuesday?" the on-disk story stops being sufficient.

AWS Secrets Manager is one answer. This page explains the design decisions behind how Ethos integrates with it -- per-ref secrets, lazy fetching, SIGHUP cache invalidation -- and the threat model those decisions serve.

## Discussion

### Why per-ref secrets, not a single JSON blob

Each secret in AWS Secrets Manager is one ref: `ethos/prod/providers/anthropic/apiKey` holds one API key. Not a JSON object with all keys. Three reasons.

**Atomicity.** Rotating one key is a single `put-secret-value` call. No read-modify-write race on a shared blob. No risk of clobbering the Telegram token while rotating the Anthropic key.

**IAM granularity.** You can scope IAM policies to individual secret ARNs. A deployment that uses Anthropic and Telegram can have a policy that grants access to exactly those two secrets and nothing else. A JSON blob is all-or-nothing -- you either have access to every secret in it or none.

**Per-secret CloudTrail audit.** Every `GetSecretValue` call logs the exact secret ARN. When the security team asks "who accessed the Slack bot token?" the answer is one CloudTrail filter, not "someone accessed the secrets blob and the token was in it."

The cost is more secrets to manage. AWS charges ~$0.40/secret/month. A deployment with 20 secrets costs $8/month for this granularity. That is cheap compared to the cost of a rotation race condition or an audit gap.

### Why lazy fetching, not eager

The [resolver](../reference/secrets-resolver.md) fetches secrets when they are first accessed, not at startup in a batch. Two reasons.

**Latency budget.** Startup fetches all secrets that the active config actually references. But a secret referenced only by a disabled channel adapter is never fetched. Lazy evaluation means the resolver does not pay for secrets the deployment does not use. This matters when someone has 30 secrets provisioned but only 10 active channels.

**Blast radius.** If the Telegram bot token is inaccessible (permissions, region mismatch, deleted secret), only the Telegram adapter fails. The gateway starts, the Anthropic provider works, other channels work. Eager batch fetching would fail the entire startup on one bad secret.

The trade-off: you discover a misconfigured secret when the component that needs it starts, not at boot. `ethos doctor` exists to catch this earlier -- it probes every configured ref and reports failures before you rely on the deployment being healthy.

### Why SIGHUP, not polling

After initial fetch, secrets are cached in memory with no TTL. The cache clears on SIGHUP. No background polling thread, no refresh interval config.

**Operator-driven invalidation is honest.** A 5-minute polling interval means the old key is live for up to 5 minutes after rotation. A 30-second interval means 30 seconds of stale key plus 30-second API call cadence against Secrets Manager for every running instance. Neither interval is obviously right, and the choice is invisible to the operator. SIGHUP is explicit: you rotate the secret in AWS, you send SIGHUP, the new value is live. The operator knows exactly when the transition happens.

**Polling adds complexity for marginal value.** A background thread needs error handling (what if the refresh call fails -- use the stale value? crash?), jitter (many instances polling at the same interval cause thundering herd), and configuration (the interval itself becomes a tunable that someone has to think about). SIGHUP is one signal handler and zero config.

**The escape hatch is a restart.** If SIGHUP is not granular enough for your deployment, `systemctl restart ethos` clears everything. For deployments that need zero-downtime rotation with automatic propagation, a sidecar that watches Secrets Manager and sends SIGHUP is a straightforward addition -- and it lives outside Ethos, where the polling policy belongs.

### Threat model

What the AWS Secrets Manager integration protects against, and what it does not.

**Wins:**

| Threat | Without AWS SM | With AWS SM |
|---|---|---|
| EBS snapshot theft | Attacker gets `config.yaml` with plaintext keys | Attacker gets `config.yaml` with `${secrets:...}` placeholders -- no secret material |
| Lost/stolen operator laptop | `.env` or `config.yaml` copy on laptop has keys | Keys are in AWS, not on the laptop. `aws secretsmanager get-secret-value` requires IAM credentials the laptop may or may not have. |
| "Who accessed key X?" audit | No record | CloudTrail logs every `GetSecretValue` with timestamp, principal, and source IP |
| Key rotation | Edit file, restart, hope you didn't typo | `put-secret-value` + SIGHUP. The old value is versioned in AWS. Rollback is one API call. |
| Runtime secret writes | MCP OAuth tokens and `ethos secrets set` values land on disk at `~/.ethos/secrets/` | Runtime secrets go directly to AWS Secrets Manager. No secret material touches the filesystem. |

**Limits:**

| Threat | Status |
|---|---|
| Process memory dump | Secrets are in memory after fetch. A root user or debugger attached to the process can read them. AWS SM does not help here. |
| Root on the running instance | Root can read `/proc/<pid>/environ`, attach `gdb`, or read memory. The instance role's credentials are also accessible to root via IMDS. |
| AWS account compromise | If the attacker has IAM access to `secretsmanager:GetSecretValue`, they have the secrets. AWS SM is not a defense against a compromised AWS account -- it is a defense against compromised instances and laptops. |

The honest summary: AWS Secrets Manager moves the trust boundary from "whoever can read the filesystem" to "whoever has the IAM role." That is a meaningful improvement for the EBS-snapshot and lost-laptop cases. It is not a defense against a compromised instance or a compromised AWS account.

### The three deployment shapes

| Shape | Where secrets live | When to use |
|---|---|---|
| **Native (on-disk)** | `~/.ethos/secrets/<ref>` files | Development, single-user laptop, air-gapped environments |
| **Env-driven** | `~/.ethos/.env` or `process.env` | Container deployments (ECS, EKS) where secrets are injected as env vars by the orchestrator |
| **AWS-only** | AWS Secrets Manager (reads **and writes**) | EC2 production deployments where audit, rotation, and no-secrets-on-disk are requirements |

You can mix them. The [resolver precedence chain](../reference/secrets-resolver.md#resolver-precedence) means `.env` overrides AWS, which overrides on-disk files. A common pattern during migration: provision secrets in AWS, keep `.env` as a fallback, remove `.env` once you have confirmed AWS resolution works.

When `aws.secrets.enabled: true`, Ethos writes all runtime secrets (MCP OAuth tokens, CLI `ethos secrets set`) to AWS Secrets Manager. On-disk files under `~/.ethos/secrets/` remain in the read chain as a lowest-precedence fallback for pre-existing secrets. New writes never touch the filesystem. Stale on-disk copies are an operator responsibility to clean up.

## See also

- [Secrets resolver reference](../reference/secrets-resolver.md) -- resolver precedence, backend behavior, failure modes.
- [Configure AWS Secrets Manager](../how-to/configure-aws-secrets.md) -- step-by-step setup.
- [Deploy Ethos on AWS EC2](../how-to/deploy-on-ec2.md) -- the base deployment shape.
