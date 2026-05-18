---
title: Bot-token rotation playbook
description: Step-by-step runbook for rotating Slack, Telegram, and Discord bot tokens — from generating a new token to verifying the deployment.
kind: how-to
audience: shared
slug: bot-token-rotation
time: "10 min"
updated: 2026-05-18
---

## Task

Rotate a bot token after a credential leak or as part of scheduled maintenance. The procedure applies to Slack, Telegram, Discord, and email (IMAP/SMTP) channel adapters, including multi-bot deployments.

## Result

The old token is revoked and unreachable. The new token is stored in the secrets backend, the gateway process is running with the new credential, and a test message confirms end-to-end connectivity on every rotated channel.

## Prereqs

- Operator access to the platform's admin console (Slack API dashboard, Telegram BotFather, Discord Developer Portal, or email account settings).
- The `ethos` CLI installed and configured with access to the secrets backend (local secrets store, env vars, or AWS Secrets Manager).
- Permission to restart the gateway process (or the specific pod in Kubernetes).
- A test channel or DM thread on each platform for post-rotation verification.

## General pattern

Every platform follows the same five-step sequence. The platform-specific sections below fill in the details for each step.

1. Generate a new token on the platform's admin console.
2. Store the new token: `ethos secrets set <ref> <new-value>`.
3. Restart the gateway process (or the specific pod in Kubernetes).
4. Verify the bot responds to a test message.
5. Revoke the old token on the platform's admin console.

Order matters. Store the new token _before_ restarting, and verify _before_ revoking the old token. If the new token is bad, the old one still works as a rollback path until step 5.

## Steps

### 1. Rotate Slack tokens

Slack uses three credentials: a bot token (`xoxb-`), an app-level token (`xapp-`), and a signing secret. Rotate all three during a single rotation window.

1. Open the [Slack API dashboard](https://api.slack.com/apps) and select the app.
2. Navigate to **OAuth & Permissions**. Click **Reinstall to Workspace**. Copy the new bot token (`xoxb-...`).
3. Navigate to **Basic Information > App-Level Tokens**. Generate a new app token (`xapp-...`). Delete the old one.
4. On the same **Basic Information** page, note the **Signing Secret**. Regenerate it if compromised.
5. Store all three credentials:

```bash
ethos secrets set channels/slack/default/botToken xoxb-new-token
ethos secrets set channels/slack/default/appToken xapp-new-token
ethos secrets set channels/slack/default/signingSecret new-signing-secret
```

6. Restart the gateway:

```bash
# Systemd
sudo systemctl restart ethos-gateway

# Kubernetes
kubectl rollout restart deployment/ethos-gateway -n ethos
```

7. Send a test message in a Slack channel where the bot is present. Confirm the bot responds.
8. Return to the Slack API dashboard and revoke any old app-level tokens you replaced in step 3.

### 2. Rotate a Telegram token

Telegram tokens are atomic: generating a new one immediately invalidates the old one. There is no grace period.

1. Open a chat with [@BotFather](https://t.me/BotFather) on Telegram.
2. Send `/revoke`. Select the bot when prompted. BotFather replies with a new token. Copy it.
3. Store the new token:

```bash
ethos secrets set channels/telegram/default/botToken <new-token>
```

4. Restart the gateway immediately --- the old token is already dead:

```bash
sudo systemctl restart ethos-gateway
```

5. Send a test message to the bot on Telegram. Confirm the bot responds.

Because `/revoke` kills the old token instantly, plan for a brief window of downtime between step 2 and step 4. Keep the restart command ready before you issue `/revoke`.

### 3. Rotate a Discord token

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and select the application.
2. Navigate to **Bot**. Click **Reset Token**. Copy the new token. Discord does not show it again.
3. Store the new token:

```bash
ethos secrets set channels/discord/default/botToken <new-token>
```

4. Restart the gateway:

```bash
sudo systemctl restart ethos-gateway
```

5. Send a test message in a Discord channel where the bot is present. Confirm the bot responds.
6. The old token was automatically invalidated when you clicked **Reset Token** in step 2. No separate revocation step is needed.

### 4. Rotate email credentials (IMAP/SMTP)

1. Change the email account password through the provider's account settings (Gmail, Outlook, self-hosted).
2. If the account uses an app-specific password (e.g., Gmail with 2FA), generate a new app password and delete the old one.
3. Store both the IMAP and SMTP passwords:

```bash
ethos secrets set channels/email/default/imap/password <new-password>
ethos secrets set channels/email/default/smtp/password <new-password>
```

4. Restart the gateway.
5. Send a test email to the monitored inbox. Confirm the bot processes the inbound message and replies.

### 5. Handle multi-bot deployments

In multi-bot deployments, each bot is identified by a unique bot key. The secret ref includes this key instead of `default`.

1. List current secret refs to find the bot keys:

```bash
ethos secrets list
```

Example output:

```
channels/telegram/support-bot/botToken
channels/telegram/alerts-bot/botToken
channels/slack/eng-app/botToken
channels/slack/ops-app/botToken
```

2. Rotate each bot individually using the platform-specific steps above, substituting the bot key for `default`:

```bash
# Indexed Telegram bots
ethos secrets set channels/telegram/support-bot/botToken <new-token>
ethos secrets set channels/telegram/alerts-bot/botToken <new-token>

# Indexed Slack apps
ethos secrets set channels/slack/eng-app/botToken <new-token>
ethos secrets set channels/slack/eng-app/appToken <new-token>
ethos secrets set channels/slack/eng-app/signingSecret <new-secret>
```

3. Restart the gateway once after storing all new tokens. Each bot reconnects with its updated credential.
4. Verify every bot individually --- send a test message on each platform and bot.

## Verify

After completing the rotation:

1. Send a test message on each rotated platform. Confirm the bot replies within its normal latency.
2. Check gateway logs for successful connection events:

```bash
journalctl -u ethos-gateway --since "5 minutes ago" | grep -i "connected\|authenticated\|ready"
```

3. Confirm the secrets backend has the new refs stored:

```bash
ethos secrets list
```

4. For Slack specifically, confirm the bot appears online in the workspace. A stale token sometimes allows a connection that silently fails on message delivery.
5. Run a second test message 5 minutes after restart to rule out transient connection success from cached sessions.

## Troubleshoot

**Bot does not respond after restart.**
The gateway is still using the old token cached in process memory. Confirm the restart actually completed (`systemctl status ethos-gateway` or `kubectl get pods`). If the process did not restart, force-kill and start again.

**`ethos secrets set` succeeds but the bot still fails.**
The secret ref path is wrong. Run `ethos secrets list` and compare the ref you set against the ref the gateway reads. Common mistake: using `default` when the deployment uses named bot keys, or vice versa.

**Telegram bot goes offline immediately after `/revoke`.**
This is expected. Telegram revocation is instant. Minimize downtime by having the `ethos secrets set` and restart commands ready in a separate terminal before issuing `/revoke`.

**Slack bot shows as online but does not respond to messages.**
The bot token was rotated but the app-level token or signing secret was not. Slack requires all three credentials to be valid. Rotate all three during the same window.

**Discord bot connects but throws 4004 (Authentication failed).**
The token was copied incorrectly. Discord tokens are long and easy to truncate. Reset the token again in the Developer Portal, copy carefully, and re-store.

**Email adapter fails with IMAP authentication error.**
The provider requires an app-specific password (common with Gmail and Outlook when 2FA is enabled). A regular account password will not work. Generate an app password in the provider's security settings.

**Multi-bot deployment: one bot reconnects, another does not.**
Each bot key maps to a separate token. Verify that every bot key listed in `ethos secrets list` was rotated. A partial rotation leaves some bots on revoked credentials.

## See also

- [Production hardening checklist](./production-hardening-checklist.md) --- includes scheduled rotation as a checklist item.
- [Least-privilege tokens](./least-privilege-tokens.md) --- scoping token permissions to the minimum required by the channel adapter.
- [Security controls](./controls.md) --- the full catalogue of shipped security controls.
