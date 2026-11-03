# platform-telegram behaviour and operations

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
| `/start` returns a generic greeting | Personality config has no description or SOUL.md | Add a `description:` to the personality's `config.yaml` or write an SOUL.md |

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

