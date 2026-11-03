---
title: "Deploy your first Telegram agent"
description: "Zero to a Telegram bot replying in production: bot token, gateway setup, channel adapter config, daemon under launchd or systemd."
kind: tutorial
audience: user
slug: first-deploy-telegram
time: "30 min"
updated: 2026-11-03
---

Your [personality](../../getting-started/glossary.md#personality) runs locally in `ethos chat`. This tutorial puts it in front of real users on Telegram. The path is: create a bot, paste its token, foreground-test the gateway, then wrap it in a service manager that survives reboots.

## Goal

By the end, you have:

- A Telegram bot created through BotFather with a token in `~/.ethos/config.yaml`.
- The Ethos [gateway](../../getting-started/glossary.md#gateway) running in the foreground and replying to messages on Telegram.
- The same gateway running as a daemon under `launchd` (macOS) or `systemd` (Linux), restarting on crash and after reboot.
- An access list so only you (and people you name) can DM the bot — using the pairing-code flow.
- A short troubleshooting cheat sheet for the daemon-vs-foreground failures you will eventually hit.

The bot answers as whatever personality you set in [Create your first personality](./first-personality.md) — or as one of the built-ins if you skipped that tutorial.

## Prereqs

- [Build your first agent](./first-agent.md) finished — `ethos chat` reaches the provider locally and replies stream in real time.
- A Telegram account.
- A box that stays online: your laptop is fine while you test; a VPS or always-on home server is the production target.
- Network egress to `api.telegram.org` and to your LLM provider. Both use plain HTTPS.

## Parts

| Part | Covers |
|---|---|
| 1. Deploy your first Telegram agent (this page) | Steps 1-5: Create the bot, Configure the [channel adapter](../../getting-started/glossary.md#channel-adapter), Foreground-test before daemonising, Pick which personality the bot uses, Restrict who can DM the bot |
| [2. Wrap the bot in a daemon](first-deploy-telegram-2-daemon.md) | Step 6: Wrap it in a daemon |
| [3. Send the first message and operate it](first-deploy-telegram-3-operate.md) | Steps 7-9: Send the first production message, Operate it, Troubleshooting the common cases |

## 1. Create the bot

Telegram bots are created through a conversation with `@BotFather` inside Telegram itself.

1. Open Telegram and search for `@BotFather`. Start a chat.
2. Send `/newbot`.
3. Pick a human-readable name (`My Strategist Bot`).
4. Pick a unique username ending in `bot` (`my_strategist_bot`).
5. BotFather replies with the **HTTP API token** — a string like `123456789:ABCdefGhIJklmNopQRstuVwxYZ`. Copy it. Anyone with this token can speak as your bot, so treat it like a password.

While you are still in BotFather, two settings are worth confirming for a personal bot:

- `/setprivacy` for your bot, then **Enable**. Privacy mode means the bot only sees messages addressed to it directly or sent as a reply. This is what you want for a personal bot. If you later want the bot to read a group's ordinary chatter, disabling it here is not enough on its own — Telegram fixes the setting per group when the bot joins, so you also remove and re-add the bot to that group. [Platform prerequisites for group messages](../../platforms/telegram.md#3b-platform-prerequisites-for-group-messages) has the full sequence and the `getMe` check that confirms it took.
- `/setdescription` and `/setabouttext` are cosmetic but appear in Telegram's bot card — set them to something honest.

You can regenerate the token any time with `/token` in BotFather; the old token is invalidated immediately, so do this if you ever leak the value.

## 2. Configure the [channel adapter](../../getting-started/glossary.md#channel-adapter)

Ethos ships a Telegram adapter inside `@ethosagent/cli` — no extra install. The `ethos gateway setup` command writes the token into `~/.ethos/config.yaml` for you and validates the token against Telegram's `getMe` endpoint.

:::tip Fast path — validate and launch in one pass
If you are setting up from scratch, run `ethos setup` instead. Its messaging step validates the token the same way (`✓ Connected · @my_strategist_bot`), and when a channel validates the closing prompt offers three choices — **Start the Telegram bot now** / **Open chat instead** / **Done**. Pick the first and the wizard brings the bot up immediately:

```
Starting the Telegram bot…
✓ @my_strategist_bot is live — message it: t.me/my_strategist_bot
Ctrl+C stops the bot. Run 'ethos gateway start' to restart it.
```

That gets you a replying bot in one command. This tutorial continues past that first reply to wire the bot for production — a durable access list and a daemon that survives reboots.
:::

```bash
ethos gateway setup
```

Paste the token at the prompt. Expected output:

```
Validating token...
✓ Bot validated: @my_strategist_bot
✓ Token saved to ~/.ethos/config.yaml
```

If validation fails, the token is wrong — re-run `/newbot` or `/token` in BotFather and try again.

Open `~/.ethos/config.yaml` and verify the line landed:

```bash
grep telegramToken ~/.ethos/config.yaml
```

You should see `telegramToken: 123456789:ABC...`.

If you prefer to hand-edit, the same effect is one line:

```yaml
telegramToken: "123456789:ABCdefGhIJklmNopQRstuVwxYZ"
```

The gateway reads exactly that field on startup. Anything before `:` is the numeric bot id (informational); everything after is the secret. Do not commit this file to a public repo — `~/.ethos/config.yaml` belongs in `.gitignore` for any directory you share.

## 3. Foreground-test before daemonising

Daemons fail silently. Before wrapping the gateway in a service manager, run it in the foreground from a normal shell and prove the bot replies. This is the most important step in the tutorial — fix every error here, not after.

```bash
ethos gateway start
```

Expected boot sequence:

```
ethos gateway  starting...
Runs in the foreground. For always-on production, see https://ethosagent.ai/docs/using/how-to/run-as-daemon ...
Cron scheduler running (checks every 60s)
✓ Telegram online (412ms)
Listening for messages. Press Ctrl+C to stop.
```

Now message your bot from Telegram. Search for its username, send `Hello`. The bot should reply within a few seconds with the active personality's voice.

If it does not:

- **No `✓ Telegram online`** — the token is wrong, or the box cannot reach `api.telegram.org`. Test with `curl https://api.telegram.org/bot$YOUR_TOKEN/getMe` — a working token returns JSON with `"ok":true` and the bot's username.
- **Boot but no reply** — your provider API key is wrong. Foreground errors print to stderr; scroll up. Run `ethos chat` separately to confirm the CLI side still works.
- **`No platform configured`** — the token did not land in the config file. Re-run `ethos gateway setup`.
- **Bot replies once, then nothing** — you have two gateways running against the same token. Kill the duplicate; Telegram drops long-poll requests beyond the first.
- **Bot replies with an error tool result** — your personality's `toolset.yaml` allows a tool whose backing service is misconfigured. Switch to `researcher` (default toolset works out of the box) to confirm it is configuration and not infrastructure.

Stop the foreground process with `Ctrl+C` when the bot is replying. Telegram queues incoming messages for several hours, so a brief downtime during the daemon switch does not drop messages.

## 4. Pick which personality the bot uses

The gateway runs one personality per bot. It uses the `personality` field in `~/.ethos/config.yaml` by default — whatever you picked during `ethos setup`. To change it, either edit the file:

```yaml
personality: strategist
```

…or use the CLI:

```bash
ethos personality set strategist
```

The bot you ship is the personality you picked. If you want a different personality on Telegram than in the CLI, the cleanest path is `ethos personality duplicate strategist strategist-tg` and then set `personality: strategist-tg`. They share an id space but are otherwise independent files — you can tighten Telegram's [toolset](../../getting-started/glossary.md#tool) (no `terminal`, no `write_file`) without affecting the CLI version.

Two other places personality routing comes up:

- The personality config's `platform: telegram` field binds the personality to the Telegram ingress. The gateway uses this hint to pick the right personality when multiple are configured; for a single-bot deployment, it is informational.
- The pairing-code flow in step 5 carries the personality id on approval, so future messages from that sender route correctly.

## 5. Restrict who can DM the bot

By default, the bot replies to anyone who messages it. For a personal bot this is wrong. The gateway implements a **pairing-code** flow: a remote user sends a DM, the gateway generates a one-time code, and you accept the pairing from your CLI before that user's future messages are processed.

Start the gateway in the foreground again (`ethos gateway start`) and DM the bot from a Telegram account other than yours (or from the same account — both work). Open a separate terminal and run `ethos chat`. Inside chat:

```
/communications
```

You see a pending pairing code, something like:

```
Pending (1):
  telegram 1234567 7H3K-9XQ2  "Hello"
```

Approve the sender:

```
/allow 7H3K-9XQ2
```

The gateway emits a confirmation. The remote user's next message lands as expected.

Revoke later:

```
/deny telegram 1234567
```

The pairing list lives in `~/.ethos/communications.json`. Hand-editing is supported but discouraged — the `/allow` and `/deny` slash commands keep it consistent with the in-memory cache.

If you want to skip the pairing flow entirely (single-user bot for yourself), DM the bot from your own account and `/allow` your own pairing code once. Subsequent runs of the gateway remember the approval — the JSON file is the source of truth.

For a group chat, add the bot to a Telegram group and approve the group's chat id rather than individual senders. Group chat ids are negative numbers; you can read them out of `/communications` or by tailing the gateway log when the bot is added.

## What you learned

- Steps 1-5 done: Create the bot; Configure the [channel adapter](../../getting-started/glossary.md#channel-adapter); Foreground-test before daemonising; Pick which personality the bot uses; Restrict who can DM the bot.

## Next step

Continue with [part 2 of 3: wrap the bot in a daemon](first-deploy-telegram-2-daemon.md).
