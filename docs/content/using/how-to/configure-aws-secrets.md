---
title: "Configure AWS Secrets Manager"
description: "Fetch provider keys and bot tokens from AWS Secrets Manager at runtime. No secrets on disk — the IAM role is the only access path."
kind: how-to
audience: user
slug: configure-aws-secrets
time: "10 min"
updated: 2026-05-19
---

## Task

Fetch Ethos [secrets](../../getting-started/glossary.md#secret) from AWS Secrets Manager instead of storing them on disk.

## Result

- Provider keys and bot tokens live in AWS Secrets Manager.
- The EC2 instance's IAM role fetches them at runtime.
- No secrets in `~/.ethos/.env`, no on-disk secret files.
- CloudTrail logs every fetch.

## Prereqs

- An EC2 instance (or ECS task, EKS pod) with an IAM role attached. If you started from the [EC2 deploy guide](deploy-on-ec2.md), you already have one.
- AWS CLI access from your laptop to create secrets.
- Ethos installed and running per the [EC2 deploy guide](deploy-on-ec2.md) or equivalent.

## Steps

### 1. Create the IAM policy

The policy grants three actions scoped to a single prefix. Nothing else.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "EthosReadOwnSecrets",
    "Effect": "Allow",
    "Action": [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:ListSecrets"
    ],
    "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:ethos/<deployment>/*"
  }]
}
```

Replace `<region>`, `<account>`, and `<deployment>` with your values. `<deployment>` is an arbitrary label you pick -- `prod`, `staging`, your instance name, whatever groups this set of secrets.

Attach the policy to the EC2 instance role:

```bash
aws iam put-role-policy \
  --role-name <your-ec2-instance-role> \
  --policy-name EthosSecretsRead \
  --policy-document file://ethos-secrets-policy.json
```

### 2. Provision secrets in AWS

From your laptop (not the instance), create one secret per [ref](../../getting-started/glossary.md#secret-ref):

```bash
aws secretsmanager create-secret \
  --name ethos/prod/providers/anthropic/apiKey \
  --secret-string "sk-ant-..."
```

Repeat for every ref your config uses. Common refs:

| Ref | What it holds |
|---|---|
| `providers/anthropic/apiKey` | Anthropic API key |
| `providers/openrouter/apiKey` | OpenRouter API key |
| `channels/telegram/default/botToken` | Telegram bot token |
| `channels/slack/default/botToken` | Slack bot token |
| `channels/discord/default/botToken` | Discord bot token |

The full secret name in AWS is `ethos/<deployment>/<ref>`. The resolver strips the prefix before matching.

### 3. Enable in config

Add three lines to `~/.ethos/config.yaml`:

```yaml
aws.secrets.enabled: true
aws.secrets.region: us-east-1
aws.secrets.prefix: ethos/prod
```

Set `aws.secrets.region` to the region where you created the secrets. Set `aws.secrets.prefix` to match the `ethos/<deployment>` prefix from step 2.

### 4. Restart Ethos

```bash
sudo systemctl restart ethos
```

On restart, the [secrets resolver](../reference/secrets-resolver.md) detects `aws.secrets.enabled: true`, initializes the AWS backend, and resolves every `${secrets:ref}` placeholder against Secrets Manager before any provider or channel adapter starts.

### 5. Grant write permissions (required)

When `aws.secrets.enabled: true`, Ethos writes secrets to AWS Secrets Manager at runtime -- MCP OAuth tokens, `ethos secrets set` values, and any other runtime secrets. The instance role needs write permissions in addition to the read permissions from step 1.

Add a second statement to your IAM policy:

```json
{
  "Sid": "EthosWriteOwnSecrets",
  "Effect": "Allow",
  "Action": [
    "secretsmanager:CreateSecret",
    "secretsmanager:PutSecretValue",
    "secretsmanager:DeleteSecret",
    "secretsmanager:RestoreSecret"
  ],
  "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:ethos/<deployment>/*"
}
```

Add this as a second `Statement` entry alongside the existing `EthosReadOwnSecrets` statement. `RestoreSecret` is required because `delete()` uses the default recovery window (reversible); when `set()` targets a secret that is still in scheduled-deletion state, it restores it first. `UpdateSecret` is deliberately omitted -- `PutSecretValue` covers value rotation, and `UpdateSecret` would allow changing metadata, KMS key, and tags that Ethos never needs.

See the [instance write role](../reference/aws-iam-policies.md#instance-write-role) reference for the combined read+write policy.

### Migrating existing on-disk secrets to AWS

After enabling AWS writes, existing on-disk secrets under `~/.ethos/secrets/` are still readable -- the file resolver remains in the [reader chain](../reference/secrets-resolver.md#resolver-precedence) as a lowest-precedence fallback. New writes go to AWS; on-disk copies become stale.

To migrate an existing secret to AWS manually:

```bash
aws secretsmanager create-secret \
  --name ethos/<deployment>/<ref> \
  --secret-string "$(cat ~/.ethos/secrets/<ref>)"
```

Repeat for each ref under `~/.ethos/secrets/`. Ethos does not ship a migration tool in v1.

## Verify

Run `ethos doctor` on the instance:

```bash
sudo -iu ethos ethos doctor
```

The output should show each secret resolved from AWS. If a secret is missing or inaccessible, `doctor` prints the ref name and the AWS error code.

Check CloudTrail to confirm the fetches are logged:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
  --max-results 5
```

You should see one `GetSecretValue` event per secret, with the instance role as the principal.

## Cost

AWS Secrets Manager charges ~$0.40/secret/month plus $0.05 per 10,000 API calls. A typical deployment with 15-25 secrets costs $6-10/month. Secrets are fetched once at startup and cached in memory -- the API call volume is negligible unless you restart frequently.

## Day-to-day operations

**Rotate a secret:**

```bash
aws secretsmanager put-secret-value \
  --secret-id ethos/prod/providers/anthropic/apiKey \
  --secret-string "sk-ant-new-key-..."
```

**Clear the in-memory cache** so Ethos picks up the new value without a full restart:

```bash
sudo kill -HUP $(pgrep -f "ethos gateway")
```

SIGHUP clears the secrets cache and re-fetches all refs from AWS. See the [secrets resolver reference](../reference/secrets-resolver.md) for cache behavior details.

**List all secrets under your prefix:**

```bash
aws secretsmanager list-secrets \
  --filters Key=name,Values=ethos/prod
```

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `ethos doctor` shows `AccessDeniedException` for a ref | IAM policy missing or scoped wrong | Verify the policy resource ARN matches `arn:aws:secretsmanager:<region>:<account>:secret:ethos/<deployment>/*` and is attached to the instance role |
| `ethos doctor` shows `ResourceNotFoundException` | Secret name in AWS doesn't match the ref | Run `aws secretsmanager list-secrets --filters Key=name,Values=ethos/<deployment>` and compare names |
| `ethos doctor` shows credential failure | No IAM role on the instance, or IMDS blocked | Confirm an instance profile is attached; confirm IMDSv2 is reachable (`curl -H "X-aws-ec2-metadata-token-ttl-seconds: 60" -X PUT http://169.254.169.254/latest/api/token`) |
| Secrets resolve on restart but stale after rotation | Cache not cleared | Send SIGHUP: `sudo kill -HUP $(pgrep -f "ethos gateway")` |

## See also

- [Secrets resolver reference](../reference/secrets-resolver.md) -- resolver precedence, backend behavior, failure modes.
- [Secrets architecture](../explanation/secrets-architecture.md) -- why per-ref secrets, lazy fetching, and SIGHUP cache invalidation.
- [Deploy Ethos on AWS EC2](deploy-on-ec2.md) -- the base deployment this guide builds on.
- [config.yaml reference](../reference/config-yaml.md) -- all configuration fields including `aws.secrets.*`.
