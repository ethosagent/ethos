---
title: "Run multiple Telegram bots from one process"
description: "Configure two or more Telegram bots in one Ethos gateway, each bound to a different personality with isolated sessions and memory."
kind: how-to
audience: user
time: "10 min"
updated: 2026-05-22
---

## Task

Configure two or more Telegram bots in a single Ethos gateway process, with each bot bound to a distinct [personality](../../getting-started/glossary.md#personality).

For the cross-platform overview (Telegram + Slack in one process), see [Run multiple bots from one Ethos process](run-multiple-bots.md). This page is the Telegram-specific deep dive — BotFather setup, group routing, the `/personality` rejection message, and the legacy scalar migration.

## Result

- Each bot has its own token, its own identity, and its own [session](../../getting-started/glossary.md#session) lane.
- Messages sent to bot A never reach bot B's agent loop, and their memory scopes are separate.
- The gateway startup log lists every configured bot; both answer messages independently.

## Prereqs

- `ethos chat` works locally with a configured LLM provider.
- Two (or more) bot tokens, one per bot — get each from `@BotFather` using `/newbot`.
- The personalities you want to bind already exist. Built-ins (`researcher`, `engineer`, `reviewer`) are available without any setup. Custom personalities live under `~/.ethos/personalities/<id>/`.

## Steps

### 1. Get a token for each bot from BotFather

Open a Telegram chat with `@BotFather`. For each bot:

```
/newbot
```

Follow the prompts — choose a display name, then a username ending in `bot`. BotFather replies with a token in the form `<numeric-id>:<secret>`. Copy each token; you cannot retrieve the secret portion again without `/token`.

Treat the secret portion like a password. Store it in `~/.ethos/config.yaml`, which is user-readable only by default. Do not commit it to source control.

### 2. Write the list-shape config

Replace the single `telegramToken` scalar with a `telegram.bots` list. Each entry in the list is one bot.

```yaml
# ~/.ethos/config.yaml

telegram.bots.0.token: "123456:ABCdefGhIJklmNopQRstuVwxYZ"
telegram.bots.0.id: researcher-bot
telegram.bots.0.bind.type: personality
telegram.bots.0.bind.name: researcher

telegram.bots.1.token: "654321:XYZabcDeFgHijKlMnOpqRsTuV"
telegram.bots.1.id: coder-bot
telegram.bots.1.bind.type: personality
telegram.bots.1.bind.name: engineer
```

Field notes:

- `token` — the BotFather token. Required.
- `id` — a stable, human-readable key used in log output, session lane names, and the `Map<botKey, AgentLoop>` the gateway maintains internally. Defaults to the first 24 characters of `sha256(token)` when omitted. Once set, do not change it — changing the `id` orphans existing session history.
- `bind.type` — `personality` routes every message to the named personality. `team` routes to a team coordinator (see [Connect a Telegram bot to a team](connect-telegram-to-team.md)).
- `bind.name` — the personality id (for `bind.type: personality`) or team name (for `bind.type: team`).

### 3. Understand session lane isolation

With two bots configured, the gateway maintains two `AgentLoop` instances — one per bot. The [session](../../getting-started/glossary.md#session) key format changes from the single-bot layout:

| Config | Session key format |
|---|---|
| Single bot (`telegramToken`) | `telegram:<chatId>` |
| Multi-bot (`telegram.bots`) | `telegram:<botKey>:<chatId>` |

`botKey` is the `id` field from config (or the sha256-derived default). This means each bot gets its own conversation history even when two users with the same Telegram user id talk to both bots — the histories never merge.

### 4. Understand what `/personality` does on identity-bound bots

`/personality` is **disabled** for bots bound with `bind.type: personality` or `bind.type: team`. Sending `/personality researcher` to a bound bot returns a rejection message:

```
This bot's identity is fixed. The /personality command is not available here.
```

To allow per-chat personality switching on a specific bot, add `bind.allowSlashSwitch: true`:

```yaml
telegram.bots.0.bind.type: personality
telegram.bots.0.bind.name: researcher
telegram.bots.0.bind.allowSlashSwitch: true
```

With `allowSlashSwitch: true`, users can switch the active personality mid-conversation via `/personality <id>`, and `/new` resets both the session and the personality back to the configured default.

`allowSlashSwitch` defaults to `false` for identity-bound bots. Do not enable it on bots intended to have a stable, consistent persona.

### 5. Use the legacy scalar shape (optional)

If you have an existing config with the scalar `telegramToken` field, it continues to work without any changes:

```yaml
# Legacy — still functional, creates one bot bound to the default personality
telegramToken: "123456:ABCdefGhIJklmNopQRstuVwxYZ"
```

The gateway wraps this in a single-element `telegram.bots` entry automatically, binding it to whatever personality is set in the top-level `personality` field. The session key uses the scalar-mode format: `telegram:<chatId>`.

When both `telegramToken` and `telegram.bots` are set, `telegram.bots` takes precedence and the scalar is ignored. The gateway logs a deprecation warning at startup.

`telegramToken` is deprecated but will not be removed in the current major version. Migrate to `telegram.bots` when you add a second bot.

### 6. Start the gateway

```bash
ethos gateway start
```

## Verify

**Startup log lists both bots.**

Expected output:

```
ethos gateway  starting...
✓ Telegram online — researcher-bot (312ms)
✓ Telegram online — coder-bot (340ms)
Listening for messages. Press Ctrl+C to stop.
```

Each line shows the `id` from config. If only one line appears, check the next bot's token for typos.

**Each bot replies independently.**

DM each bot with `ping`. Each should reply within a few seconds. Verify that the reply from `researcher-bot` reflects the researcher personality and the reply from `coder-bot` reflects the engineer personality.

**Sessions are isolated.**

Ask `researcher-bot` a question. Then ask `coder-bot` the same question. Neither bot has context from the other's conversation — they cannot see each other's history.

## Troubleshoot

**Only one bot gets messages; the other is silent.**

One possible cause is a lane key collision: two bots with the same derived `botKey`. This happens when two tokens produce the same sha256 prefix (extremely unlikely) or when you set `id` to the same value for both entries. Check the startup log — each bot's entry shows its resolved `botKey`. If they are identical, set distinct `id` values.

**Startup logs a binding error for one bot.**

```
[telegram] binding error: personality "engineer" not found
```

The `bind.name` references a personality id that is not installed. Confirm the personality exists with `ethos personalities list`. For custom personalities, verify the directory exists at `~/.ethos/personalities/engineer/` with a valid `config.yaml`.

**Both bots reply to the same user.**

If both bots are added to the same Telegram group and the group allowlist includes the group id, both will process messages. This is expected — each bot has a separate allow list scope. To silence one bot in a group, remove the group id from that bot's `channelFilter.telegram.recipientAllowlist`.

**The gateway warns about `telegramToken` being ignored.**

You have both `telegramToken` and `telegram.bots` set. Remove `telegramToken` — `telegram.bots` takes precedence. Keep the token if you still need it by adding it as a `telegram.bots` entry.

## See also

- [Run multiple bots from one Ethos process](run-multiple-bots.md) — cross-platform overview covering Telegram and Slack together.
- [Telegram adapter](../../platforms/telegram.md) — full routing, allowlist, dedup, and error catalog.
- [Connect a Telegram bot to a team](connect-telegram-to-team.md) — bind a bot to a team coordinator instead of a single personality.
- [config.yaml reference](../reference/config-yaml.md#telegram-bots) — `telegram.bots.*` field definitions.
- [Glossary: personality](../../getting-started/glossary.md#personality), [session](../../getting-started/glossary.md#session).
