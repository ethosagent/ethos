---
title: "AWS IAM policies for Ethos"
description: "Copy-paste IAM policy templates for Ethos on AWS — read-only instance role and rotation-operator role."
kind: reference
audience: user
slug: aws-iam-policies
updated: 2026-05-19
---

## Synopsis {#synopsis}

Two IAM policies cover every AWS Secrets Manager operation Ethos needs. The **read-only instance role** goes on the EC2/ECS/EKS workload. The **rotation-operator role** goes on the human (or CI pipeline) that provisions and rotates secrets from outside the instance.

## Read-only instance role {#read-only-instance-role}

Attach this policy to the IAM role your Ethos instance assumes. It grants exactly three actions: fetch a secret value, describe its metadata, and list secrets under the prefix.

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

This is the policy from the [Configure AWS Secrets Manager](../how-to/configure-aws-secrets.md) guide. The instance can read and list its own secrets and nothing else.

## Rotation-operator role {#rotation-operator-role}

Attach this policy to the IAM user or role you use from your laptop (or CI) to create, rotate, and delete secrets.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "EthosRotateSecrets",
    "Effect": "Allow",
    "Action": [
      "secretsmanager:PutSecretValue",
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:ListSecrets",
      "secretsmanager:DescribeSecret"
    ],
    "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:ethos/<deployment>/*"
  }]
}
```

The operator can write, list, and delete secrets under the deployment prefix. The operator does **not** need `GetSecretValue` -- you provision secrets, you don't read them back. If you need to verify a value, use the AWS Console's "Retrieve secret value" button under your own login.

## Instance write role {#instance-write-role}

When `aws.secrets.enabled: true`, the instance role needs write permissions in addition to read. Ethos writes MCP OAuth tokens, `ethos secrets set` values, and any other runtime secrets to AWS Secrets Manager. This is **required** for deployments with `aws.secrets.enabled: true`. Without these permissions, every secret write fails at runtime.

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
  },
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
  }]
}
```

`RestoreSecret` is required because `delete()` uses the default recovery window (reversible); when `set()` targets a secret that is still in scheduled-deletion state, it restores it first. `UpdateSecret` is deliberately omitted -- `PutSecretValue` covers value rotation, and `UpdateSecret` would allow changing metadata, KMS key, and tags that Ethos never needs.

## Placeholders {#placeholders}

Replace three values in both policies:

| Placeholder | What to use | Example |
|---|---|---|
| `<region>` | The AWS region where your secrets live | `us-east-1` |
| `<account>` | Your 12-digit AWS account ID | `123456789012` |
| `<deployment>` | The label you picked when provisioning secrets | `prod`, `staging`, `dev` |

The resulting ARN looks like: `arn:aws:secretsmanager:us-east-1:123456789012:secret:ethos/prod/*`

## Common mistakes {#common-mistakes}

**Do not use `Resource: "*"`.**
This is the single most common IAM mistake with Secrets Manager. A wildcard resource grants access to every secret in the account -- not just Ethos secrets. Scope to your prefix.

**Do not share roles across deployments.**
If you run `prod` and `staging`, create separate policies scoped to `ethos/prod/*` and `ethos/staging/*`. A shared role means a staging compromise can read production secrets.

**You do not need `kms:*` actions.**
AWS Secrets Manager encrypts secrets at rest using the AWS-managed `aws/secretsmanager` KMS key by default. The `secretsmanager:GetSecretValue` permission implicitly grants the necessary KMS decrypt. You only need explicit `kms:Decrypt` if you use a customer-managed KMS key -- and if you're reading this guide, you probably don't.

## Applying the policies {#applying-the-policies}

Save each policy to a file and attach with the AWS CLI:

**Instance role (read-only):**

```bash
aws iam put-role-policy \
  --role-name <your-ec2-instance-role> \
  --policy-name EthosSecretsRead \
  --policy-document file://ethos-secrets-read.json
```

**Operator role (rotation):**

```bash
aws iam put-role-policy \
  --role-name <your-operator-role> \
  --policy-name EthosSecretsRotate \
  --policy-document file://ethos-secrets-rotate.json
```

## See also {#see-also}

- [Configure AWS Secrets Manager](../how-to/configure-aws-secrets.md) -- step-by-step setup using the read-only policy.
- [Audit secrets access with CloudTrail](../how-to/audit-secrets-access.md) -- detect when a non-Ethos principal reads your secrets.
- [Decommission an Ethos deployment](../how-to/decommission-ethos-deployment.md) -- clean teardown including IAM policy removal.
- [Secrets resolver reference](secrets-resolver.md) -- resolver precedence, backend behavior, failure modes.
- [Secrets architecture](../explanation/secrets-architecture.md) -- design rationale for per-ref secrets and the threat model.
