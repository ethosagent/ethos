---
title: "Configure AWS Secrets Manager: write permissions and migration"
description: "Grant the instance role write access to Secrets Manager and move on-disk secrets to AWS."
kind: how-to
audience: user
time: "5 min"
updated: 2026-11-03
---

## Task

Let Ethos write secrets to AWS Secrets Manager at runtime, and move existing on-disk secrets there.

## Result

`ethos secrets set` values and MCP OAuth tokens are stored in AWS under `ethos/<deployment>/`, and secrets that were under `~/.ethos/secrets/` are available from AWS.

## Prereqs

- Complete [Configure AWS Secrets Manager](../configure-aws-secrets.md) through step 4: the read policy is attached and Ethos restarted with `aws.secrets.enabled: true`.
- AWS CLI access from your laptop to edit the IAM policy.

## Steps

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

See the [instance write role](../../reference/aws-iam-policies.md#instance-write-role) reference for the combined read+write policy.

### Migrating existing on-disk secrets to AWS

After enabling AWS writes, existing on-disk secrets under `~/.ethos/secrets/` are still readable -- the file resolver remains in the [reader chain](../../reference/secrets-resolver.md#resolver-precedence) as a lowest-precedence fallback. New writes go to AWS; on-disk copies become stale.

To migrate an existing secret to AWS manually:

```bash
aws secretsmanager create-secret \
  --name ethos/<deployment>/<ref> \
  --secret-string "$(cat ~/.ethos/secrets/<ref>)"
```

Repeat for each ref under `~/.ethos/secrets/`. Ethos does not ship a migration tool in v1.

## Verify

Store a test secret from the instance:

```bash
sudo -iu ethos ethos secrets set write-check/ping hello
```

Then confirm it exists in AWS, from your laptop:

```bash
aws secretsmanager describe-secret --secret-id ethos/<deployment>/write-check/ping
```

The command prints the secret's metadata. Remove the test secret afterwards:

```bash
aws secretsmanager delete-secret --secret-id ethos/<deployment>/write-check/ping --force-delete-without-recovery
```

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `ethos secrets set` fails with `AccessDeniedException` | The `EthosWriteOwnSecrets` statement is missing from the instance role's policy | Add the statement from step 5 and confirm its `Resource` matches `ethos/<deployment>/*` |
| Migrated secret is not picked up | Secret name in AWS doesn't match the ref | Name it `ethos/<deployment>/<ref>` exactly, as in the migration command |

## See also

- [Secrets resolver reference](../../reference/secrets-resolver.md) -- resolver precedence, backend behavior, failure modes.
- [Configure AWS Secrets Manager](../configure-aws-secrets.md) -- read policy, provisioning and rotation.
