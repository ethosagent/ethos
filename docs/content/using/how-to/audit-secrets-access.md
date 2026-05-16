---
title: "Audit secrets access with CloudTrail"
description: "Set up a CloudWatch alarm that fires when a non-Ethos principal reads your secrets. Copy-paste Terraform included."
kind: how-to
audience: user
slug: audit-secrets-access
time: "10 min"
updated: 2026-05-16
---

## Task

Detect when a non-Ethos IAM principal reads your Ethos secrets.

## Result

A CloudWatch alarm fires within minutes if any principal other than the Ethos instance role fetches a secret under `ethos/<deployment>/`. You get an SNS notification (email, Slack, PagerDuty -- whatever your SNS topic routes to).

## Prereqs

- An AWS account with CloudTrail enabled (management events are on by default).
- Ethos secrets provisioned in AWS Secrets Manager per the [Configure AWS Secrets Manager](configure-aws-secrets.md) guide.
- An SNS topic for alarm notifications. If you don't have one, create it:
  ```bash
  aws sns create-topic --name ethos-security-alerts
  aws sns subscribe --topic-arn <topic-arn> --protocol email --notification-endpoint you@example.com
  ```

## Steps

### 1. Enable CloudTrail data events for Secrets Manager

Management events (IAM changes, instance launches) are logged by default. **Data events** -- the actual `GetSecretValue` calls -- are not. You need to opt in.

In the CloudTrail console:

1. Open your trail (or create one if you only have the default event history).
2. **Data events** tab -> **Add data event type** -> **AWS Secrets Manager**.
3. Log **Read** events. Write events (create/delete) are already covered by management events.

Or via CLI:

```bash
aws cloudtrail put-event-selectors --trail-name <your-trail> \
  --advanced-event-selectors '[{
    "Name": "SecretsManagerReads",
    "FieldSelectors": [
      {"Field": "eventCategory", "Equals": ["Data"]},
      {"Field": "resources.type", "Equals": ["AWS::SecretsManager::Secret"]},
      {"Field": "readOnly", "Equals": ["true"]}
    ]
  }]'
```

### 2. Create a CloudWatch metric filter

CloudTrail delivers logs to a CloudWatch log group. The metric filter watches that log group for `GetSecretValue` calls against `ethos/*` secrets by non-Ethos principals.

```bash
aws logs put-metric-filter \
  --log-group-name <your-cloudtrail-log-group> \
  --filter-name ethos-secrets-unauthorized-access \
  --filter-pattern '{ ($.eventName = "GetSecretValue") && ($.requestParameters.secretId = "ethos/*") && ($.userIdentity.arn != "*EthosInstanceRole*") }' \
  --metric-transformations \
    metricName=EthosSecretsUnauthorizedAccess,metricNamespace=Ethos/Security,metricValue=1
```

Replace `EthosInstanceRole` with the name of your Ethos instance's IAM role. The filter matches any `GetSecretValue` against an `ethos/*` secret where the caller is **not** the instance role.

### 3. Create the CloudWatch alarm

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name ethos-secrets-unauthorized-read \
  --metric-name EthosSecretsUnauthorizedAccess \
  --namespace "Ethos/Security" \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 \
  --period 300 \
  --statistic Sum \
  --threshold 0 \
  --alarm-description "Non-Ethos principal read an ethos/* secret" \
  --alarm-actions <your-sns-topic-arn>
```

Any non-zero count in a 5-minute window triggers the alarm.

### Terraform module (copy-paste)

If you manage infrastructure as code, drop this into your Terraform config:

```hcl
resource "aws_cloudwatch_log_metric_filter" "ethos_secrets_unauthorized" {
  name           = "ethos-secrets-unauthorized-access"
  log_group_name = var.cloudtrail_log_group
  pattern        = <<PATTERN
{ ($.eventName = "GetSecretValue") && ($.requestParameters.secretId = "ethos/*") && ($.userIdentity.arn != "*EthosInstanceRole*") }
PATTERN

  metric_transformation {
    name      = "EthosSecretsUnauthorizedAccess"
    namespace = "Ethos/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "ethos_secrets_alarm" {
  alarm_name          = "ethos-secrets-unauthorized-read"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "EthosSecretsUnauthorizedAccess"
  namespace           = "Ethos/Security"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Non-Ethos principal read an ethos/* secret"
  alarm_actions       = [var.sns_topic_arn]
}
```

Variables you need to define:

| Variable | Description |
|---|---|
| `var.cloudtrail_log_group` | The CloudWatch log group name where CloudTrail delivers logs |
| `var.sns_topic_arn` | The SNS topic ARN for alarm notifications |

Replace `*EthosInstanceRole*` in the filter pattern with your actual instance role name.

## Verify

**Trigger a test alarm.** From your laptop (not the instance), fetch a secret:

```bash
aws secretsmanager get-secret-value \
  --secret-id ethos/prod/providers/anthropic/apiKey
```

Your laptop's IAM identity is not the Ethos instance role, so this should increment the metric. Within 5 minutes, the alarm should fire and you should receive a notification.

**Confirm the alarm state:**

```bash
aws cloudwatch describe-alarms \
  --alarm-names ethos-secrets-unauthorized-read
```

The state should be `ALARM` after your test fetch.

**Reset the alarm** after testing:

```bash
aws cloudwatch set-alarm-state \
  --alarm-name ethos-secrets-unauthorized-read \
  --state-value OK \
  --state-reason "Test complete"
```

## CloudTrail Lake queries {#cloudtrail-lake-queries}

If you use CloudTrail Lake for long-term log analysis, these queries are useful for ad-hoc investigation.

**Did Ethos fetch the Telegram token in the last 24 hours?**

```sql
SELECT eventTime, userIdentity.arn, requestParameters.secretId
FROM <event-data-store-id>
WHERE eventName = 'GetSecretValue'
  AND requestParameters.secretId = 'ethos/prod/channels/telegram/default/botToken'
  AND eventTime > DATE_ADD('hour', -24, now())
ORDER BY eventTime DESC
```

**Did a non-Ethos principal read any Ethos secret?**

```sql
SELECT eventTime, userIdentity.arn, requestParameters.secretId, sourceIPAddress
FROM <event-data-store-id>
WHERE eventName = 'GetSecretValue'
  AND requestParameters.secretId LIKE 'ethos/%'
  AND userIdentity.arn NOT LIKE '%EthosInstanceRole%'
  AND eventTime > DATE_ADD('day', -7, now())
ORDER BY eventTime DESC
```

Replace `<event-data-store-id>` with your CloudTrail Lake event data store ID. Replace `EthosInstanceRole` with your actual role name.

## See also {#see-also}

- [Configure AWS Secrets Manager](configure-aws-secrets.md) -- step-by-step secrets setup.
- [AWS IAM policies for Ethos](../reference/aws-iam-policies.md) -- copy-paste IAM policy templates.
- [Decommission an Ethos deployment](decommission-ethos-deployment.md) -- clean teardown with CloudTrail verification.
- [Secrets resolver reference](../reference/secrets-resolver.md) -- resolver precedence, backend behavior, failure modes.
- [Secrets architecture](../explanation/secrets-architecture.md) -- design rationale for per-ref secrets and audit model.
