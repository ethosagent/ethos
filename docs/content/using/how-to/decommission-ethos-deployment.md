---
title: "Decommission an Ethos deployment"
description: "Safely tear down an AWS-hosted Ethos deployment: rotate secrets, revoke the role, delete the prefix, verify from CloudTrail."
kind: how-to
audience: user
slug: decommission-ethos-deployment
time: "10 min"
updated: 2026-05-16
---

## Task

Cleanly tear down an Ethos deployment on AWS so no secrets remain active and no credentials remain valid.

## Result

- The Ethos service is stopped.
- All secret values under `ethos/<deployment>/` are rotated to garbage, then deleted.
- The IAM policy is detached from the instance role.
- The EC2 instance and its EBS volume are terminated.
- CloudTrail confirms no access after the rotation timestamp.

## Prereqs

- SSH or SSM access to the Ethos instance.
- AWS CLI access from your laptop with the rotation-operator role (see [AWS IAM policies](../reference/aws-iam-policies.md)).
- The `<deployment>` prefix you used when provisioning secrets (e.g. `prod`, `staging`).

## Steps

### 1. Stop the Ethos service

On the instance:

```bash
sudo systemctl stop ethos
sudo systemctl disable ethos
```

This halts the gateway immediately. Bot messages stop being processed. Disabling prevents the service from restarting on reboot.

### 2. Rotate all secrets to invalidate current values

From your laptop, overwrite every secret under the deployment prefix with a garbage value. This ensures that even if cached credentials or snapshots survive, the secret material is useless.

```bash
aws secretsmanager list-secrets --filters Key=name,Values=ethos/<deployment>/ \
  --query 'SecretList[].Name' --output text | tr '\t' '\n' | while read name; do
  aws secretsmanager put-secret-value --secret-id "$name" \
    --secret-string "ROTATED-$(date +%s)"
done
```

Replace `<deployment>` with your prefix (e.g. `prod`). Every secret now holds `ROTATED-<timestamp>` instead of a real key or token.

Why rotate before deleting: if something goes wrong with the delete step, the secrets are already invalidated. Defense in depth.

### 3. Detach the IAM policy from the instance role

```bash
aws iam delete-role-policy \
  --role-name <your-ec2-instance-role> \
  --policy-name EthosSecretsRead
```

This revokes the instance's ability to fetch secrets. Even if the instance were somehow restarted, it could not authenticate against Secrets Manager.

### 4. Delete the secrets

```bash
aws secretsmanager list-secrets --filters Key=name,Values=ethos/<deployment>/ \
  --query 'SecretList[].Name' --output text | tr '\t' '\n' | while read name; do
  aws secretsmanager delete-secret --secret-id "$name" \
    --force-delete-without-recovery
done
```

`--force-delete-without-recovery` skips the default 7-day recovery window and deletes immediately. Use this only when you are certain -- there is no undo.

If you prefer a safety net, omit the flag. AWS will schedule deletion in 7 days, during which you can cancel with `aws secretsmanager restore-secret`.

### 5. Terminate the EC2 instance

In the EC2 console, select the instance and choose **Instance state -> Terminate instance**.

Or via CLI:

```bash
aws ec2 terminate-instances --instance-ids <instance-id>
```

Termination stops the instance and deletes its root volume (if `DeleteOnTermination` is set, which is the default).

### 6. Delete the EBS state volume

If you followed the [EC2 deploy guide](deploy-on-ec2.md), the state volume (`/var/lib/ethos`) is a separate EBS volume that is **not** deleted on termination. Delete it explicitly:

```bash
aws ec2 delete-volume --volume-id <volume-id>
```

Find the volume ID in the EC2 console under **Elastic Block Store -> Volumes**, filtered by the instance ID or the `ethos` tag.

Also delete any AWS Backup snapshots of this volume if you no longer need the data:

```bash
aws ec2 describe-snapshots --filters Name=volume-id,Values=<volume-id> \
  --query 'Snapshots[].SnapshotId' --output text | tr '\t' '\n' | while read snap; do
  aws ec2 delete-snapshot --snapshot-id "$snap"
done
```

## Verify {#verify}

Confirm the teardown is complete.

**No secrets remain:**

```bash
aws secretsmanager list-secrets --filters Key=name,Values=ethos/<deployment>/
```

Should return an empty `SecretList`.

**No access after rotation:**

Check CloudTrail for any `GetSecretValue` events against your prefix after the rotation timestamp:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
  --start-time <rotation-timestamp> \
  --max-results 20
```

Filter the results for `ethos/<deployment>/` in the secret ID. There should be zero events after the rotation -- only the rotation `PutSecretValue` events from step 2.

**Instance terminated:**

```bash
aws ec2 describe-instances --instance-ids <instance-id> \
  --query 'Reservations[].Instances[].State.Name'
```

Should return `terminated`.

**Volume deleted:**

```bash
aws ec2 describe-volumes --volume-ids <volume-id>
```

Should return an error (`InvalidVolume.NotFound`).

## Checklist

Use this as a runbook. Check each item as you go.

- [ ] Ethos service stopped and disabled
- [ ] All secrets rotated to garbage values
- [ ] IAM policy detached from instance role
- [ ] All secrets deleted from Secrets Manager
- [ ] EC2 instance terminated
- [ ] EBS state volume deleted
- [ ] EBS snapshots deleted (if applicable)
- [ ] CloudTrail confirms no post-rotation access
- [ ] CloudWatch alarm removed (if you set one up per [Audit secrets access](audit-secrets-access.md))

## See also {#see-also}

- [Configure AWS Secrets Manager](configure-aws-secrets.md) -- the setup this guide reverses.
- [AWS IAM policies for Ethos](../reference/aws-iam-policies.md) -- the policies you are detaching.
- [Audit secrets access with CloudTrail](audit-secrets-access.md) -- the alarm you should remove as part of teardown.
- [Secrets resolver reference](../reference/secrets-resolver.md) -- resolver precedence and backend behavior.
- [Secrets architecture](../explanation/secrets-architecture.md) -- design rationale and threat model.
