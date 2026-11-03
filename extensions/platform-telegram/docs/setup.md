# platform-telegram setup

Telegram `PlatformAdapter` for Ethos — long-polls the Bot API via `grammy` so your agent works from your phone with no public URL.

This README walks an operator from zero to a working bot in about five minutes, then documents the slash commands, group behaviour, and troubleshooting paths. Contributors looking for the architectural picture jump to [Internals](internals.md).

---

## What you can do

- **Chat with your Ethos personality from Telegram** — DM the bot, @mention it in a group, or reply in a thread; the personality answers with its configured prompt, tools, and memory.
- **Run multiple bots on one gateway** — one Telegram bot per personality (or per team coordinator). Each bot's conversations stay on its own lane.
- **See the bot acknowledge your message** — inbound messages get an eyes reaction; the reaction clears when the reply lands.
- **Get a personality-aware greeting** — `/start` introduces the bot in its personality's voice.
- **Inspect the bot's character sheet** — `/personality rich` renders the full identity, model, tools, and skills as a formatted message.

---

## Quickstart — five minutes to your first reply

You'll create a Telegram bot, copy the token into Ethos, start the gateway, and DM the bot.

### Prereqs

- `@ethosagent/cli` installed and `ethos setup` has been run (so you have a `~/.ethos/config.yaml` and at least one personality).
- A Telegram account.
- About five minutes.

### Step 1 - Create the bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, follow the prompts to pick a name and username.
3. BotFather replies with a token like `123456789:ABCdefGHI...`. Copy it.

### Step 2 - Add the bot to `~/.ethos/config.yaml`

Each Telegram bot gets one entry under `telegram.bots.<n>`. Pick any non-negative integer for `<n>`:

```yaml
telegram.bots.0.token: 123456789:ABCdefGHI...
telegram.bots.0.bind.type: personality       # or 'team'
telegram.bots.0.bind.name: researcher        # personality id or team manifest name
# Optional: stable identifier surfaced in logs + gateway lane keys.
# Defaults to a 24-char sha256(token) prefix when omitted.
telegram.bots.0.id: researcher-bot
```

Declare as many bots as you want; each binds to exactly one personality or team coordinator.

### Step 3 - Start the gateway

```bash
ethos gateway start
```

Boot validates that every `bind.name` resolves to a known personality or team and refuses to start otherwise. On success you'll see one health line per bot — including the bound personality — and `Listening for messages.`

The bot's BotFather profile (name, description, commands menu) is updated automatically from the bound personality's config.

### Step 4 - DM the bot and say hello

1. Open Telegram and search for your bot's username.
2. Tap **Start** (or type `/start`) to see the personality-aware greeting.
3. Send a message. You should see an eyes reaction appear, then a reply within a few seconds.

If you don't see a reply, jump to [Troubleshooting](operations.md#troubleshooting).

---

