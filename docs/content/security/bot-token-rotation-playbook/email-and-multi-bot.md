---
title: "Bot-token rotation: email credentials and multi-bot deployments"
description: "Rotate IMAP/SMTP credentials and tokens across multi-bot deployments."
kind: how-to
audience: shared
time: "5 min"
updated: 2026-11-03
---

## Task

Rotate email (IMAP/SMTP) credentials and rotate tokens in a multi-bot deployment.

## Result

Every step on this page is applied and the checks in [Verify](../bot-token-rotation-playbook.md#verify) on the main page pass.

## Prereqs

Complete the [Prereqs](../bot-token-rotation-playbook.md#prereqs) listed on the main page, [Bot-token rotation playbook](../bot-token-rotation-playbook.md).

## Steps

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

Run the [Verify](../bot-token-rotation-playbook.md#verify) steps on the main page once all parts are done.

## Troubleshoot

See [Troubleshoot](../bot-token-rotation-playbook.md#troubleshoot) on the main page.
