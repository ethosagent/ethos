---
title: "Deploy your first Telegram agent, part 3: send the first message and operate it"
description: "Send the first production message, operate the bot and troubleshoot."
kind: tutorial
audience: user
updated: 2026-11-03
---

## Goal

Finish steps 7-9 of [Deploy your first Telegram agent](first-deploy-telegram.md): Send the first production message; Operate it; Troubleshooting the common cases.

## Prereqs

- Complete [part 2 of 3](first-deploy-telegram-2-daemon.md).

## 7. Send the first production message

From Telegram, DM your bot. You should see a reply within a few seconds. Three things are happening:

1. The Telegram adapter polls Telegram for new updates (long-polling, no webhook required).
2. The gateway routes the inbound `InboundMessage` to `AgentLoop.run()` with `sessionKey: telegram:<chatId>` and `personalityId: <your-personality>`.
3. The streamed `AgentEvent` output is reflowed into Telegram messages (one per 4,096-character chunk; later edits update the same message id rather than appending new ones).

The bot's [session](../../getting-started/glossary.md#session) is independent from your CLI session — each Telegram chat has its own session key. Your CLI conversation history is untouched, and vice versa. They do share the personality's `MEMORY.md`: memory is scoped to the personality (`personality:<id>`, set in `setupTurn`), not to the session or the platform, and there is no setting that changes that. `USER.md` is the exception — a Telegram turn carries the sender's user id, so the bot reads and writes that person's `USER.md` under `~/.ethos/users/<userId>/` instead of the personality's own.

The outbound deduplication cache is keyed by `(sessionId, sha256(content))` with a 30-second TTL, and a reply's key also carries the inbound message it answers. If the agent emits the same reply twice in quick succession (a streaming retry, for example), Telegram only sees the first. This is automatic; adapters do not roll their own deduplication. Two different messages that get the same answer ("Done.") both get it.

## 8. Operate it

A few commands worth knowing once the bot is running.

**Is it actually running?**

```bash
launchctl list | grep ai.ethosagent           # macOS
systemctl --user is-active ethos-gateway      # Linux — exits 0 if active
```

**Where are the logs?**

```bash
tail -f ~/.ethos/logs/gateway.out.log
```

Ethos writes structured logs to `~/.ethos/logs/` on top of stdout. The service manager's logs are a superset — `launchd` writes the file directly per the plist; `systemd` writes to `journalctl` and also to the file because of the `StandardOutput=append:` directive.

**Reading recent errors:**

```bash
ethos errors                    # last 50 errors with cause and action
```

The `errors` command reads `~/.ethos/logs/errors.jsonl` — every `EthosError` envelope produced by the CLI or the gateway lands there.

**Updating the bot:**

```bash
ethos upgrade
launchctl stop ai.ethosagent.gateway && launchctl start ai.ethosagent.gateway   # macOS
systemctl --user restart ethos-gateway                                          # Linux
```

Always restart after upgrade — the running daemon keeps the old binary in memory until restarted.

**Reading the bot's session history:**

Inside `ethos chat`, the bot's per-chat sessions are visible through SQLite. The TUI's `/sessions` modal lists them; from outside, the database file is `~/.ethos/sessions.db` (WAL + FTS5).

## 9. Troubleshooting the common cases

**Daemon starts but bot does not reply.** Foreground-test the same config: `ethos gateway start`. If foreground works and daemon does not, it is almost always `PATH` or `HOME`. Use absolute paths in the unit file and set `HOME` explicitly.

**`ethos: command not found` in daemon logs.** Service managers do not source your shell rc. If you installed via `nvm`, `ethos` lives under `~/.nvm/versions/node/...`. Use that absolute path in `ProgramArguments` / `ExecStart`. `which ethos` from a shell where chat works prints exactly the path you want.

**Daemon log says `Run ethos setup first`.** The daemon's `HOME` does not point at your user. `systemd` user units inherit this; `launchd` sometimes does not — set `HOME` in the plist's `EnvironmentVariables`.

**Telegram returns 429 (rate limit).** Two gateways are running against the same bot token. Check for a duplicate plist, a forgotten `tmux` session, or a still-running foreground process. One gateway per token. Telegram's rate limit is 30 messages per second per bot; you only hit this with a real conversation flood, so 429 in normal operation almost always means duplication.

**Bot replies are slow.** The first turn loads memory and starts the LLM stream — expect 1–2 seconds before the first chunk arrives. Steady-state should be sub-second per chunk. If every reply takes 10+ seconds, the model picked is slow (Opus is heavier than Sonnet) or the provider is throttling.

**Memory grows unbounded.** Long-running daemons accumulate per-session state. The session store evicts on its own retention TTLs (see `retention.messages` in [config.yaml](../reference/config-yaml.md#retention)); if RSS climbs steadily, file an issue with a heap snapshot.

**Bot crashes and `KeepAlive` / `Restart=on-failure` flaps.** Look at the error log first. Repeated boot failures usually mean a misconfiguration the service manager keeps retrying through. Disable the service, fix the config, re-enable. Hot-looping a broken config wastes CPU and floods Telegram with reconnects.

**I want webhooks instead of long-polling.** Long-polling needs no public URL and works behind any NAT. Webhooks need a domain with TLS. The current adapter only supports long-polling; this is on the roadmap.

**Two bots, one box.** Run two gateways with two `~/.ethos/` directories. Set `HOME` to a different path in each unit file. The two configs, two SQLite databases, and two log directories stay separate.

## What you learned

- A Telegram bot is two artifacts: a token from BotFather, and the gateway running with that token configured.
- The gateway is a separate process from `ethos chat` — both can run in parallel against the same SQLite store.
- The Telegram adapter polls Telegram's long-poll endpoint; no domain or TLS is required.
- The pairing-code flow (`/communications`, `/allow`, `/deny`) is the access list — one approval per sender, kept in `~/.ethos/communications.json`.
- Wrapping the gateway in `launchd` or `systemd` is what turns "running in a shell" into "running in production." Use absolute paths; set `HOME` explicitly.
- `ethos upgrade` plus a service restart is the deploy loop.
- Outbound dedup is in the gateway, not the adapter; the same reply to the same message does not get sent twice within 30 seconds.

## Next step

You have one Telegram personality replying to messages. Two natural next steps:

- [Run Ethos as a daemon](../how-to/run-as-daemon.md) — the full reference for `launchd`, `systemd`, `pm2`, plus tmux and screen for short-lived tests.
- [Deploy on Telegram](../../platforms/telegram.md) — bot mentions, group chats, rate limits, multi-workspace.
- [Configure providers](../how-to/configure-providers.md) — set up fallback chains so a single rate-limited provider does not take the bot offline.
- [Glossary](../../getting-started/glossary.md) — `channel adapter`, `gateway`, `session`, every term used here.
