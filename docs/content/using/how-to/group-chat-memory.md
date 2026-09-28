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

| Chat | Room audience |
|---|---|
| A direct message to the bot from you | private |
| A group, channel or supergroup | shared |
| A thread or topic | the same as its parent chat |
| An email whose sender the mail server did not authenticate | shared (still answered) |
| A Discord group DM | shared |
| A WhatsApp status broadcast, `@broadcast` list or `@newsletter` channel | shared |
| A group listed under `gateway.private_chats.<platform>` | private |

Work that runs later inherits the room it came from. It runs shared when the chat that created it was shared, or when it posts into a shared chat:

| Runs later | Room audience |
|---|---|
| A cron job | shared if it was created in a shared chat, delivers to one, or reads a shared job's output through `contextFrom` |
| A watcher wake | shared if a shared chat created the watcher, it delivers to one, or nothing records who created it |
| A goal | the room audience of the chat it was set in (`web` and CLI goals are private) |
| A kanban task a shared turn created | shared, including on a team member it is dispatched to |
| An inbound webhook | shared, unless the hook sets `webhooks.<hook-id>.private: true` and every `deliver` target is private |
| An A2A request, a phone caller, an MCP client (unless `expose_memory` is set) | shared |

A job created before this release carries no stamp and is judged by where it delivers: a group, a Discord channel or an email address runs shared, and a job with no delivery target runs private. The cron runner logs one line for each such job it runs shared.

A direct message from someone else, on a platform with `channel_filter.<platform>.ownerUserId` set, is a middle case. `MEMORY.md` is yours, so it is withheld, and so is everything else a shared turn loses. The sender's own profile, `~/.ethos/users/<their-user-id>/USER.md`, is still read. With no owner configured there is nobody to compare against, and a direct message is private.

### 2. Upgrade and start fresh sessions in your groups

The new rules apply to every turn after the upgrade. What the agent already said in a group before it cannot be taken back, and a group's history may quote memory. Send `/new` in each group the bot is in:

```
/new
```

```
✓ New session started.
```

On a shared turn:

- `MEMORY.md`, `USER.md` and the per-user `USER.md` are not read into the prompt.
- These tools are not offered and are refused if called: `memory_read`, `memory_write`, `session_list_by_date`, `get_session_events`, `get_observability`, the `team_memory_*` tools, `meet_join`, `terminal`, `run_code`, the `process_*` tools, `dashboard_add_panel`, `dashboard_update_panel`, `route_to_agent` and the `skills_pending_*` tools. `session_search` stays: it reads the current chat only.
- The turn-end memory flush does not run.
- File tools refuse the private memory files — `MEMORY.md`, `USER.md` and the `memory-*.jsonl` files under any personality directory, everything under `~/.ethos/users/`, and `memory.db`. The personality's `files/` and `ui/` folders stay readable.
- `/learn` answers with a pointer to a private chat instead of running.
- A `/background` job, a delegated sub-agent and a background job's review turn launched from the group run shared too.

A session that has run one shared turn stays shared for good, whichever surface opens it next.

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

If the gateway is still running when you save the file, it logs:

```
gateway.private_chats changed — restart required to apply (a room removed from the list stays private until then)
```

Then send `/new` in the room you listed. Its old session ran shared, and that mark does not come off.

### 5. Remove a room from the list

Delete its id from the line and restart the gateway. Until that restart the room stays private. Restart as soon as you unlist a room.

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
| Someone else's direct message gets no memory | `channel_filter.<platform>.ownerUserId` names you, and they are not you | Nothing to fix. List their chat under `gateway.private_chats` only if you want them to read your `MEMORY.md` |
| An email conversation gets no memory | The receiving mail server did not authenticate the sender | Set [`emailTrustedAuthservId`](../reference/config-yaml.md#email-trusted-authserv-id) so authenticated mail is recognised |
| A scheduled job logs `predates room-audience stamps and runs without private memory` | It was created before this release and delivers to a chat that cannot be proven private — a group, or any Discord or email chat | List that chat under `gateway.private_chats.<platform>` and restart, or recreate the job from a Telegram, WhatsApp or Slack DM, the CLI or the web app |
| `/ethos ask` in a Slack DM is now refused or asks for pairing | The command used to be treated as a channel message; it is now a direct message, with the same admission rules as any DM | Allow the sender under `channel_filter.slack`, as for ordinary DMs |

The rules are enforced in the agent core, not the channel: `resolveTurnAudience` in [`packages/core/src/agent-loop/audience.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/agent-loop/audience.ts) and `Gateway.audienceFor` in [`extensions/gateway/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/gateway/src/index.ts), pinned end to end by `extensions/gateway/src/__tests__/memory-boundary-e2e.test.ts`. The [memory model](../explanation/memory-model.md) explains what `MEMORY.md` and `USER.md` hold.
