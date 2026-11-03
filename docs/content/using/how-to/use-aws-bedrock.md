---
title: "Run Ethos on AWS Bedrock"
description: "Point Ethos at Amazon Bedrock: region, model id, IAM permission, and the two credential paths — the AWS node credential chain or the Ethos secret store."
kind: how-to
audience: user
slug: use-aws-bedrock
time: "10 min"
updated: 2026-11-03
---

## Task

Run Ethos against a model hosted on Amazon Bedrock, and pick the credential path that fits where Ethos runs — an EC2 instance, an ECS task, an EKS pod, or a laptop logged in with `aws sso login`.

## Result

`ethos chat` streams tokens from Bedrock. On an AWS host with an IAM role attached, no credential is configured anywhere: Ethos resolves one through the standard AWS credential chain and re-resolves it as it expires.

## Prereqs

- `ethos` on `PATH` (Node 24+). Run `ethos --version` to confirm.
- Model access granted for the model you want, in the AWS region you plan to call. Bedrock model access is per-account and per-region — request it once in the Bedrock console under **Model access**.
- An IAM identity Ethos can assume or authenticate as. What that looks like depends on the credential path you choose below.
- Write access to `~/.ethos/config.yaml`.

## Parts

| Part | Covers |
|---|---|
| This page | Steps 1-2: get the model id, choose and configure a credential path |
| [IAM, config and capabilities](use-aws-bedrock/iam-and-config.md) | Steps 3-4: the IAM permission, the Ethos config, what the Bedrock provider supports, the end-to-end check |

## Steps

### 1. Get the model id

Bedrock model ids are account- and region-dependent. Copy the exact id from the Bedrock console under **Model catalog** → the model → **Model ID**, or list them from the CLI:

```bash
aws bedrock list-inference-profiles --region <your-region> \
  --query 'inferenceProfileSummaries[].inferenceProfileId' --output text
```

```
us.anthropic.claude-sonnet-4-6	us.anthropic.claude-haiku-4-5-20251001-v1:0
```

An id prefixed `us.` is a *cross-region inference profile* — it routes a request to whichever US region has capacity. A bare id like `anthropic.claude-haiku-4-5-20251001-v1:0` is a single-region foundation model. Either works; the prefix matters when you write the IAM policy in step 3.

### 2. Choose a credential path

Ethos resolves Bedrock credentials in a fixed priority order. The first source that resolves wins.

| Priority | Source | Where it lives | Use it when |
|---|---|---|---|
| 1 | Ethos [secret](../../getting-started/glossary.md#secret) store (sensitive material Ethos resolves at runtime) | `providers/bedrock/accessKeyId`, `providers/bedrock/secretAccessKey`, `providers/bedrock/sessionToken` | You hold a long-lived or externally-minted key pair and want it vaulted with every other Ethos credential. |
| 2 | AWS node credential chain **(Recommended)** | Nothing configured in Ethos — the chain finds it | Anywhere else. |

**Use the credential chain unless you have a specific reason not to.** It is the only path where nothing expires in your care: credentials from an instance role, a task role, IRSA, or an SSO session are short-lived and refreshed automatically on each signed request. A static key pair in the secret store is a credential you now own the rotation of.

#### Option A — The credential chain (Recommended)

Configure no Bedrock credential in Ethos at all. When the secret store holds no `providers/bedrock/accessKeyId`, Ethos falls back to the standard AWS node credential provider chain, in this order:

1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` environment variables
2. A profile in `~/.aws/config` or `~/.aws/credentials` — named by `awsProfile:` in `~/.ethos/config.yaml`, else `AWS_PROFILE`, else `default`. An SSO profile resolves from the session `aws sso login` cached.
3. An EKS web-identity token (IRSA)
4. ECS container credentials (`taskRoleArn`)
5. EC2 instance metadata (the instance role)

Steps 3 through 5 are the zero-config deployments. Attach the role and set nothing:

| Where Ethos runs | What you attach |
|---|---|
| EC2 | An instance profile carrying the Bedrock policy from step 3 |
| ECS | `taskRoleArn` on the task definition |
| EKS | An `eks.amazonaws.com/role-arn` annotation on the pod's service account (IRSA) |

On a laptop, log in first:

```bash
aws sso login --profile my-sso
```

Then name that profile in `~/.ethos/config.yaml`, so it applies to every process that runs Ethos:

```yaml
awsProfile: my-sso
```

The key is `awsProfile:`, not `profile:` — `profile` already means a per-model `ModelProfile` under `models.*` in this config. Ethos passes it to the chain as the profile to select.

`AWS_PROFILE` in the environment does the same job and is the better fit when one machine switches between accounts:

```bash
AWS_PROFILE=my-sso ethos chat
```

`awsProfile:` wins when both are set. Omit both and the chain falls back to `AWS_PROFILE`, then the `default` profile, then the non-profile sources.

#### Option B — A key pair in the secret store

Store the pair under the `providers/bedrock/` refs. `ethos secrets set` writes to `~/.ethos/secrets/`:

```bash
ethos secrets set providers/bedrock/accessKeyId AKIAIOSFODNN7EXAMPLE
ethos secrets set providers/bedrock/secretAccessKey <your-secret-access-key>
```

```
✓ Secret set: providers/bedrock/accessKeyId
✓ Secret set: providers/bedrock/secretAccessKey
```

For temporary credentials from `aws sts assume-role`, add the third ref:

```bash
ethos secrets set providers/bedrock/sessionToken <your-session-token>
```

These are ordinary secret refs, so any backend in the [resolver precedence chain](../reference/secrets-resolver.md#resolver-precedence) can supply them — `~/.ethos/.env`, a process environment variable (`PROVIDERS_BEDROCK_ACCESSKEYID`), or AWS Secrets Manager when `aws.secrets.enabled: true`.

A session token from `assume-role` expires. Ethos does not renew it — that is the cost of choosing this path over the chain.

Steps 3 and 4, the IAM permission and the Ethos config, are in [IAM, config and capabilities](use-aws-bedrock/iam-and-config.md).

## Verify

To confirm *which* credential the chain picked, ask AWS with the same environment Ethos will run under:

```bash
aws sts get-caller-identity
```

```json
{
    "UserId": "AROAEXAMPLEID:i-0123456789abcdef0",
    "Account": "123456789012",
    "Arn": "arn:aws:sts::123456789012:assumed-role/EthosInstanceRole/i-0123456789abcdef0"
}
```

An `assumed-role` ARN naming your instance, task, or service-account role confirms step 2 Option A is live.

## Troubleshoot

**`Bedrock has no accessKeyId/secretAccessKey configured, so requests are signed from the AWS default credential chain — and the chain could not resolve any credentials.`** — Every step of the chain came up empty. Resolution is lazy, so this surfaces on the first turn rather than at startup. Four fixes, by deployment:

1. **EC2** — attach an instance profile with the Bedrock policy.
2. **ECS** — set `taskRoleArn` on the task definition.
3. **EKS** — annotate the pod's service account with `eks.amazonaws.com/role-arn`.
4. **Laptop** — `aws sso login --profile <your-profile>`, then set `awsProfile: <your-profile>` in `~/.ethos/config.yaml` or export `AWS_PROFILE=<your-profile>` in the shell that starts Ethos.

Confirm the fix with `aws sts get-caller-identity` before re-running `ethos chat`.

**`Bedrock has accessKeyId but no secretAccessKey. Static AWS credentials need both ...`** (or the same message with the two names swapped) — exactly one half of a static key pair resolved. Ethos refuses rather than falling through to the credential chain, because signing as a different AWS identity than you configured is worse than stopping. Either complete the pair at `providers/bedrock/accessKeyId` and `providers/bedrock/secretAccessKey`, or remove the half that is set so the chain takes over deliberately. Both halves absent is the intended zero-config path and is never an error.

## See also

- [Configure an LLM provider](configure-providers.md) -- every other provider (Anthropic, OpenAI, Azure, OpenRouter, Ollama, vLLM) and the fallback chain.
- [AWS IAM policies for Ethos](../reference/aws-iam-policies.md) -- the Bedrock inference policy and the Secrets Manager policies, in one place.
- [Secrets resolver](../reference/secrets-resolver.md) -- what backs `providers/bedrock/*` and in what order.
- [Configure AWS Secrets Manager](configure-aws-secrets.md) -- keep the `providers/bedrock/*` refs in Secrets Manager instead of on disk.
- [Deploy Ethos on EC2](deploy-on-ec2.md) -- the instance and role this page assumes when it says "attach an instance profile."
