---
title: "Keep memory out of group chats"
description: "How Ethos withholds private memory from group chats, how to trust a room with gateway.private_chats, and how to check that a group sees nothing private."
kind: how-to
audience: user
slug: group-chat-memory
time: "10 min"
updated: 2026-09-28
---

## Task

Put your agent in a Telegram, Slack, Discord or WhatsApp group without it repeating what it knows about you from your private chats — and, for the few rooms you trust, turn that memory back on.

## Result

- In any group, the agent answers without reading `MEMORY.md` or your `USER.md`, and nothing said in the group is written into them.
- In a direct message with you, nothing changes.
- The rooms you list under `gateway.private_chats` behave like a direct message again.

## Prereqs

- A channel bot running under `ethos gateway start` or `ethos boot`. See [Run multiple bots](./run-multiple-bots.md) if you have none yet.
- A [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) with something in its `~/.ethos/personalities/<personality-id>/MEMORY.md`, so you can see the difference.
- Shell access to the machine running the gateway, to edit `~/.ethos/config.yaml`.

## Steps

### 1. Know which chats are shared

The [gateway](../../getting-started/glossary.md#gateway) (the process that holds your channel adapters) decides each turn's room audience before the turn runs. A shared turn gets no private memory; a private turn gets it as before.

A direct message from you is private. A group, channel, supergroup, thread or topic is shared. Unauthenticated email, Discord group DMs, WhatsApp broadcasts, a direct message from someone other than the configured owner, and work that runs later — cron jobs, watchers, goals, kanban tasks, webhooks — each have their own rule. Look your chat up in [Which rooms are shared](../explanation/memory-model.md#which-rooms-are-shared) before you continue.

### 2. Upgrade and start fresh sessions in your groups

The new rules apply to every turn after the upgrade. What the agent already said in a group before it cannot be taken back, and a group's history may quote memory. Send `/new` in each group the bot is in:

```
/new
```

```
✓ New session started.
```

What a shared turn loses — memory, tools, file access, the turn-end flush, `/learn` — and what it keeps out of later learning is listed in [What a shared turn loses](../explanation/memory-model.md#what-a-shared-turn-loses).

### 3. Trust a room (optional)

A room you share only with people you trust — a two-person household group, a private team channel — can get memory back. Find its chat id: the negative number in a Telegram group's session key (`telegram:<bot>:-100…`), a Slack channel's `C…` id, a WhatsApp group's `…@g.us` JID. Add it to `~/.ethos/config.yaml`, one line per platform, ids separated by commas:

```yaml
gateway.private_chats.telegram: -1001234567890
gateway.private_chats.slack: C0123TEAM
```

Every bot on that platform honours the list. Listing a room changes nothing else: no allowlist, pairing or mention gating turns on. The field is documented in the [config.yaml reference](../reference/config-yaml.md#gateway-private-chats).

### 4. Restart the gateway

The list is read once, at startup. Restart whichever process owns your channels:

```bash
ethos gateway start
```

A healthy start prints one line per bot, then the listening line (excerpt; your bot key, personality and latency differ):

```
ethos gateway  starting...
✓ telegram:<bot-key> → personality:<personality-id> (312ms)
Listening for messages. Press Ctrl+C to stop.
```

If the gateway is still running when you save the file, it logs:

```
gateway.private_chats changed — restart required to apply (a room removed from the list stays private until then)
```

Then send `/new` in the room you listed. Its old session ran shared, and that mark does not come off.

### 5. Remove a room from the list

Delete its id from the line and restart the gateway. Until that restart the room stays private. Restart as soon as you unlist a room.

### 6. Trust your team's own channel (teams)

A task created in a team's channel is stamped shared, so every worker that runs it loses private memory and every tool listed under [What a shared turn loses](../explanation/memory-model.md#what-a-shared-turn-loses) — among them `terminal`, `run_code`, `run_tests`, `lint`, the `process_*` and `team_memory_*` tools, `route_to_agent`, `dispatch_team` and `broadcast_to_agents`. A team deployment with an empty `gateway.private_chats` prints this at startup, naming every tool:

```
⚠ team <team-name>: gateway.private_chats is empty, so every team channel is a shared room — tasks created there run on every worker without private memory and without these tools: memory_read, memory_write, session_list_by_date, … If the channel is only your team's, list it under gateway.private_chats.<platform> and restart.
```

If only your team reads the channel, list it as in step 3 and restart. A shared task's revision postmortem is not written to team memory.

## Verify

1. In a direct message, ask "what do you remember about me?". The answer draws on `MEMORY.md`.
2. In a group the bot is in, mention it and ask the same question. The answer contains nothing from `MEMORY.md`.
3. In the same group, send `/learn the deploy is on Fridays`. The bot replies:

   ```
   Memory learning works in a private chat with me — send /learn there.
   ```

4. Check that the group changed nothing on disk. The checksum is the same before and after a group conversation:

   ```bash
   shasum -a 256 ~/.ethos/personalities/<personality-id>/MEMORY.md
   ```

   ```
   3f1c…  /Users/<you>/.ethos/personalities/<personality-id>/MEMORY.md
   ```

5. If you listed a room, ask the question there after `/new`. The answer draws on `MEMORY.md` again.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| A listed room still gets no memory | The gateway has not restarted since you edited the file, or the room's session ran shared earlier | Restart the gateway, then send `/new` in the room |
| A listed room still gets no memory after a restart | The id does not match what the adapter reports (a Telegram supergroup id starts `-100`), or the platform prefix is misspelt | Copy the id from the room's session key and use the adapter's platform id: `telegram`, `slack`, `discord`, `whatsapp`, `email` |
| A room you unlisted still gets memory | The gateway has not restarted | Restart it |
| Someone else's direct message gets no memory | `channel_filter.<platform>.ownerUserId` names you, and they are not you | Nothing to fix: `MEMORY.md` is only ever read in the owner's direct messages. Listing their chat under `gateway.private_chats` does not change this (`Gateway.withholdsPersonalityMemory`) |
| Team workers lose `terminal` and team memory on some tasks | The task was created in a team channel, which is a shared room | If only your team reads it, list the channel under `gateway.private_chats.<platform>` (step 6) |
| An email conversation gets no memory | The receiving mail server did not authenticate the sender | Set [`emailTrustedAuthservId`](../reference/config-yaml.md#email-trusted-authserv-id) so authenticated mail is recognised |
| A scheduled job logs `predates room-audience stamps and runs without private memory` | It was created before this release and delivers to a chat that cannot be proven private — a group, or any Discord or email chat | List that chat under `gateway.private_chats.<platform>` and restart, or recreate the job from a Telegram, WhatsApp or Slack DM, the CLI or the web app |
| `/ethos ask` in a Slack DM is now refused or asks for pairing | The command used to be treated as a channel message; it is now a direct message, with the same admission rules as any DM | Allow the sender under `channel_filter.slack`, as for ordinary DMs |

Some paths do not withhold memory yet; they are listed in [Known limits](../explanation/memory-model.md#known-limits-of-shared-rooms).
