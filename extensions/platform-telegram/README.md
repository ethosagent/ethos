# @ethosagent/platform-telegram

Telegram `PlatformAdapter` for Ethos — long-polls the Bot API via `grammy` so your agent works from your phone with no public URL.

This README walks an operator from zero to a working bot in about five minutes, then documents the slash commands, group behaviour, and troubleshooting paths. Contributors looking for the architectural picture jump to [Internals](#internals).

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

If you don't see a reply, jump to [Troubleshooting](#troubleshooting).

---

## `/` commands reference

These commands are registered in Telegram's slash menu (visible when you type `/` in the chat).

| Command | What it does |
|---|---|
| `/start` | Personality-aware greeting — introduces the bot and points to `/help`. |
| `/new` | Start a fresh session. Aborts any in-flight reply and clears session state. |
| `/help` | Lists available commands with the current personality binding. |
| `/personality` | Shows the current personality. |
| `/personality rich` | Full character sheet — identity, model, tools, and resolved skills. Personality bindings only; team bindings show the compact view. |
| `/personality list` | Available personalities (only when switching is enabled). |
| `/personality <id>` | Switch personality (only when switching is enabled). |
| `/usage` | Session token count and estimated cost. |
| `/stop` | Abort the current reply. |

---

## Group behaviour

### Privacy mode

By default, Telegram bots in groups only receive messages that:

- Start with `/` (commands)
- `@mention` the bot
- Reply to one of the bot's messages

To receive all group messages, disable **Group Privacy** in BotFather:

1. Message @BotFather.
2. Send `/mybots`, pick the bot, then **Bot Settings** > **Group Privacy** > **Turn off**.

### @mention and reply-tree

- `@mention` triggers the bot in any group mode. The `@bot` prefix is **not** stripped from the text — the agent sees the raw `@bot Hello`.
- Reply-tree: the adapter stamps `replyToId` and `replyToUserId` so the agent has context about which message was replied to.

### One session per chat

Each Telegram chat (private or group) maps to its own session lane: `telegram:<botKey>:<chatId>`. Groups share a single conversation history across all participants.

---

## Troubleshooting

If something looks wrong after Step 4, work top-to-bottom — earlier rows block later ones.

| Symptom | Likely cause | Fix |
|---|---|---|
| `ethos gateway start` exits with `bind.name does not resolve` | A `telegram.bots.<n>.bind.name` doesn't match any personality or team on disk | Run `ethos personality list` (and check `~/.ethos/teams/`); correct the `bind.name` |
| Boot succeeds but the bot health line shows `⚠ telegram:<key> health check failed` | Wrong bot token | Re-copy the token from BotFather |
| Bot never replies in a group | Group privacy mode is on (default) and you didn't `@mention` the bot | Either `@mention` the bot, reply to its message, or disable group privacy in BotFather |
| Long replies look chopped | Telegram's 4096-char limit; the adapter chunks automatically | Working as intended — chunks land as separate messages |
| Markdown formatting disappears | Markdown parse error; the adapter retries as plain text | Check the agent's output for unclosed formatting tokens |
| Eyes reaction never clears | The reply failed or was dropped by outbound dedup | Check gateway logs for send errors |
| `/start` returns a generic greeting | Personality config has no description or ETHOS.md | Add a `description:` to the personality's `config.yaml` or write an ETHOS.md |

---

## File Attachments

The adapter ingests photos and documents from Telegram messages automatically. No special configuration is needed.

### Supported types

| Telegram media | Attachment type | Notes |
|---|---|---|
| `photo` | `image` | Highest-resolution variant selected. Always `image/jpeg`. |
| `document` | `file` | PDFs, text files, images sent as documents. MIME from Telegram. |

### Cache location

Downloaded files are written to `~/.ethos/cache/attachments/` via the `AttachmentCache`. The cache is keyed by session, so different chats do not share cached files.

### Size cap

25 MB per file. Files exceeding this limit are skipped and the message text is appended with "(File too large -- 25 MB limit)". The Telegram Bot API caps `getFile` downloads at 20 MB, so files between 20-25 MB may fail at the API level.

### Deferred

Voice messages, audio files, video, animations (GIFs), and stickers are intentionally dropped. The inbound caption still reaches the agent, but no attachment is created. These types are deferred until transcription and media analysis tools ship.

---

## Internals

### Connection model

Long-polling via grammy's `bot.start()`. No webhook, no public URL. The polling loop runs non-blocking inside `start()` — if the token is invalid, the failure surfaces inside the loop and is logged, not thrown.

### Text chunking

Outbound text is split into 4096-char chunks and sent in order. The splitter prefers newline boundaries, then spaces, both above 60% of the limit. `editMessage()` re-flows chunks via a bounded chunk-id ledger (1024 entries, FIFO eviction).

### Reaction on receipt

On inbound message: set `receiptReaction` (default eyes). On `send()` success: clear it. Both are best-effort, non-blocking.

### Bot identity

At `start()`, personality-bound bots push their identity to BotFather:

- `setMyName` (64-char limit)
- `setMyShortDescription` (120-char limit)
- `setMyDescription` (512-char limit)

All best-effort; team bindings skip this.

### Commands menu

At `start()`, `setMyCommands` registers 6 commands visible in Telegram's slash picker.

---

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `TelegramAdapter`, `TelegramAdapterConfig`, `chunkText`, `truncateWithEllipsis`. |
| `src/blocks/personality.ts` | `personalityRichMessage` — Telegram character sheet renderer. |
| `src/clarify-surface.ts` | Telegram clarify surface (inline keyboards + force-reply). |
| `src/validate.ts` | Config validation helpers. |
| `src/__tests__/` | Unit tests for chunking, identity, commands, reactions, personality card. |
| `package.json` | Workspace package, depends on `grammy` ^1.26. |
