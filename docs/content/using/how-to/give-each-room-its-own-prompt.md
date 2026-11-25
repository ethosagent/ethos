---
title: "Give each room its own prompt"
description: "Set a per-room prompt, skills, model, reply mode and silence for Slack, Discord, Telegram, WhatsApp and email rooms with channels.* keys and prompt files."
kind: how-to
audience: user
slug: room-prompts
time: "10 min"
updated: 2026-11-25
---

## Task

Tell the agent how to behave in one specific room: a deploy channel that wants short answers, a support channel that asks for an order id first, a family group that replies in Hindi.

## Result

Each room you configure gets its own operator prompt, and optionally its own [skills](../../getting-started/glossary.md#skill), model tier, reply mode and silence rule. `ethos channels resolve` shows the exact text a room receives before you start the gateway.

## Prereqs

- A running [gateway](../../getting-started/glossary.md#gateway) with at least one platform connected (see [Platforms](../../platforms/slack.md)).
- The room id. Each platform page shows where to find it: [Slack](../../platforms/slack/routing-and-access.md#4b-per-room-prompts), [Discord](../../platforms/discord/routing.md#4b-per-room-prompts), [Telegram](../../platforms/telegram/routing.md#3c-per-room-prompts). A WhatsApp group id ends in `@g.us`. The examples use synthetic ids.

## Steps

### 1. Add a prompt to `config.yaml`

Keys are flat and dotted: `channels.<platform>.<selector>.<field>`. The selector is a room id, `*` (any room), or `*dm` (any direct message).

```yaml
# ~/.ethos/config.yaml
channels.slack.C0DEPLOY.prompt: "This channel coordinates production deploys. Confirm service and environment first."
channels.discord.1180000000000000000.prompt: "Support channel. Ask for the order id first."
channels.telegram.-1001234567890.prompt: "Engineering group for the Atlas team."
channels.whatsapp.120363000000000000@g.us.prompt: "Family logistics group. Reply in Hindi when asked in Hindi."
channels.email.*dm.prompt: "You are answering email. Write complete sentences and sign off as the assistant."
```

Email has no addressable room id, so `*dm` is the only selector that reaches it.

### 2. Move a long prompt into a file

A `prompt` is one line. For anything longer, write the prompt as Markdown at `~/.ethos/channels/<platform>/<selector>.md`. The file body is the prompt; front matter is not parsed.

| Selector | File name |
|---|---|
| a room id | `C0DEPLOY.md` |
| `*` (any room) | `_rooms.md` |
| `*dm` (any DM) | `_dms.md` |
| `<room>.topics.<sub>` | `-1001234567890.topics.99.md` |
| `name:<slug>` | `name_<slug>.md` |

```
~/.ethos/channels/slack/C0DEPLOY.md
~/.ethos/channels/slack/_rooms.md
~/.ethos/channels/telegram/-1001234567890.topics.99.md
```

If a room has both an inline `prompt` and a file, the inline value wins and the gateway logs a boot warning naming both. A file over 16 KiB is skipped with a warning.

### 3. Layer a thread or topic on top of its room

A Slack thread inherits its channel's prompt. A Discord thread and a Telegram forum topic can add their own text, which the gateway appends after the room's.

```yaml
channels.telegram.-1001234567890.prompt: "Engineering group for the Atlas team."
channels.telegram.-1001234567890.topics.99.prompt: "Incidents topic: lead with impact and status."
channels.discord.1180000000000000000.topics.1190000000000000000.tier: trivial
```

Set `inherit: false` on an entry to stop it from falling back to its parent or to `*`.

### 4. Bind skills, a model or a tier

```yaml
channels.slack.C0DEPLOY.skills: deploy-runbook, change-freeze
channels.slack.C0DEPLOY.model: sonnet-fast
channels.discord.1180000000000000000.tier: trivial
```

`skills` pins each listed [skill](../../getting-started/glossary.md#skill) in full for that room, but only if the personality can already see it. A room cannot grant a skill the personality lacks. `model` takes a [model-registry](../reference/config-yaml/model-registry.md#model-registry) alias or role (a raw model id when you have no registry). `tier` is one of `trivial`, `default`, `deep`, `dreaming`. Set one of `model` or `tier`, not both: with both, `model` wins and the gateway warns.

### 5. Set a default reply mode for a room

```yaml
channels.slack.C0DEPLOY.mode: mention_only
channels.discord.1180000000000000000.mode: all
```

The mode applies when nothing overrides it. The order is: a runtime `/channel-mode` override, then the room's `mode`, then the platform default, then the built-in default. A mode the platform does not support is dropped with a warning. On Telegram, `mode: regex_match` is rejected at load with the warning `'regex_match' needs a pattern — set it at runtime with the channel-mode command`, and the field is dropped, because a room entry cannot carry the pattern.

### 6. Make a room silent

```yaml
channels.slack.C0ALERTS.silent: true
```

The room's prompt gains the line "To send nothing in this room, reply with exactly NO_REPLY." When the agent's whole reply is `NO_REPLY` or `[SILENT]`, the gateway sends nothing and records a `gateway.silent_reply` event. Any other text, including `NO_REPLY.` or a sentence that contains it, is delivered. A room that did not set `silent: true` ignores both markers.

A silent room also suppresses the steer acknowledgement (`↩ noted …`), the queued-message acknowledgement, tool-progress lines and the slow-turn notice, and Discord's "Thinking…" placeholder is cleared. If a halt or output-cap notice follows a `NO_REPLY` answer, only the notice is sent.

### 7. Restart the gateway

`channels.*` and the prompt files are read at startup; hot reload does not apply them, and it watches only `config.yaml` keys, so a prompt-file edit logs nothing. Restart the gateway after either edit.

```bash
ethos gateway start
```

## From the web UI

Edit the same rules without opening `config.yaml`. The editor writes exactly what the steps above describe.

1. Run `ethos serve` (or open the desktop app) and sign in. Open **Communications**, pick the platform tab (Slack, Discord, Telegram or WhatsApp), and scroll to **Rooms**. A link such as `/communications?tab=slack#rooms` opens that tab and jumps to the section. When you re-run the Messaging step after setup, it shows a link to it after a Slack, Discord or Telegram token check.
2. Start from the pinned rows. **All channels** (`*`) and **All DMs** (`*dm`) are always listed. Click **Set** to give every room, or every DM, a default. Click **Add room** for one room. A room that has no rule uses the personality as-is.
3. Fill in the drawer. **Channel ID** (Slack, Discord) or **Group ID** (Telegram, WhatsApp) is the room id, with a "How to find" hint. Telegram adds an optional **Topic ID** and Discord an optional **Thread ID**, each saved as its own rule. The other fields:

   | Field | Meaning |
   |---|---|
   | Room prompt | The operator text. A counter shows the 4,000-character cap; **Save** is disabled while over it. |
   | Skills | Up to 8 skill ids. An id that is not installed is saved with a warning. |
   | Mode | The default reply mode. Telegram does not offer `regex_match`, because a room entry has no pattern field. |
   | Model | A model-registry alias, a tier, or (with no registry) a raw model id. One of model or tier, not both. |
   | Silent, Identity, Metadata, Inherit | The same switches as `silent`, `identity`, `metadata` and `inherit` in [Fields](../reference/config-yaml/room-prompts.md#fields). |

4. Read the live preview. It shows the rendered room block, the same text and digest that `ethos channels resolve` prints for that room (the identity line is omitted in both). It updates about 400 ms after you stop typing, and it writes nothing.
5. Click **Save**. The editor writes the prompt to `~/.ethos/channels/<platform>/<selector>.md` first, then the other fields to `config.yaml`. A prompt is always saved as a file, never as an inline `prompt` line, and saving removes an old inline `prompt` for the same selector.
6. Restart the gateway. A "Restart the gateway to apply" notice appears after every save, and there is no restart button. The notice is not stored: it disappears when you reload the page, so restart before you reload.

**Fetch room metadata** (Slack and Discord only) is a switch above the table. It sets `channels.<platform>.fetch_metadata`, and it also needs a gateway restart. A room's **Metadata** switch has no effect until it is on. **Name matching** is shown read-only. `allow_name_matching` and `name:` selectors are edited in `config.yaml` only.

**Recently active rooms** lists room ids from recent sessions, newest first, with **Add** or **Edit**. It shows ids only: no titles and no message text. It stays empty until the gateway has answered in a room. Threads and incognito sessions are not listed.

If a save fails:

| What you see | Meaning | Do this |
|---|---|---|
| "Changed elsewhere — reloaded" | Another tab or an edit to `config.yaml` changed this entry first (HTTP 409, `CONFIG_CONFLICT`). | Your edit is still in the form. Click **Save** again to replace what changed. |
| "Saved in part" with **Retry** | The prompt file and `config.yaml` are two writes, and one landed. The message says which. | Click **Retry**. It resends the same request and converges. |
| Prompt too large | The prompt is over 4,000 characters after cleaning (HTTP 413). | Shorten it. The API refuses it even if the form allowed it. |
| Room id warning | The id does not look like this platform's ids, for example `c0deploy` in lowercase. | The entry is saved anyway. Check the id if the room never matches. |

The six room procedures accept a signed-in browser session only. An API key (`sk-ethos-...`) gets 403 on all of them, so scripts keep using `config.yaml`.

## Verify

Preview what a room will receive without starting the gateway. The web UI preview shows the same text.

```bash
ethos channels resolve slack C0DEPLOY
```

```
Room: slack C0DEPLOY

match: C0DEPLOY (direct)
layers: C0DEPLOY

skills: deploy-runbook, change-freeze
model: sonnet-fast
tier: (unset)
identity: true
metadata: false
silent: false
mode: mention_only (from C0DEPLOY)
prompt layers: C0DEPLOY (83 chars)

digest: 3f9a1c2e
Rendered room block (the identity line is omitted: the bot handle is unknown offline, so a live digest differs when identity is on):
-----
This channel coordinates production deploys. Confirm service and environment first.
-----
```

List every configured entry and where it came from:

```bash
ethos channels list
```

```
slack
  C0DEPLOY  prompt, skills, model, mode  config
```

Inside the room, send `/channel` (Slack: `/ethos channel`). It prints the matched keys, the prompt's size and digest, skills, model, identity, silence and the mode with its source, but never the prompt text. The owner can send `/channel show` in a private direct message to see the full rendered prompt. In a group, or in a shared DM (a Discord group DM, a WhatsApp broadcast or newsletter), `/channel show` refuses and points to `ethos channels resolve`. The live block includes the identity line when identity is on, so its size and digest differ from `ethos channels resolve`, which omits that line.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `No room entries for platform 'slack'` | No `channels.slack.*` key and no files under `~/.ethos/channels/slack/` | Add an entry, then re-run `ethos channels list`. |
| Edit has no effect | The gateway is still running the old table | Restart the gateway. |
| `prompt rejected: … > 4000 chars — dropped, not truncated` | One layer is over 4,000 characters | Shorten it. An over-cap layer is dropped whole, never cut. |
| `gateway.room_prompt_trimmed` event | The rendered block is over 8,000 characters | Shorten the prompts. The gateway drops the most specific layer first. |
| `/channel` says "No room policy for this room" | The room id does not match any selector | Copy the id again; ids match exactly, including case. |

Coming from Hermes? The [key mapping](../reference/config-yaml/room-prompts.md#from-hermes) is in the reference. Room policy never changes who may talk to the bot or whether a room is [shared](../explanation/memory-model/shared-rooms.md). Those stay with the access settings and `gateway.private_chats`.
