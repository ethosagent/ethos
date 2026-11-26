---
title: "config.yaml: per-room prompts and policy"
description: "config.yaml channels.* keys: per-room prompt, skills, model, tier, identity, metadata, inherit, silent and mode, with selectors, caps and platform knobs."
kind: reference
audience: user
updated: 2026-11-25
---

## Synopsis {#synopsis}

`channels.*` keys give a chat room its own operator prompt and policy. Part of the [config.yaml reference](../config-yaml.md). Read once at gateway start: a change needs a restart. Hot reload compares only `config.yaml` keys, so editing a prompt file under `~/.ethos/channels/` logs nothing; restart the gateway after either kind of edit.

```yaml
channels.<platform>.<selector>.<field>: <value>
channels.<platform>.allow_name_matching: true | false
channels.<platform>.fetch_metadata: true | false
```

`<platform>` matches `[a-z0-9_-]+` and may be any adapter id, plugin platforms included. Parsed by `parseChannelsLine` and `buildChannels` in [`packages/config/src/builders/channels.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/builders/channels.ts). A bad value is a warning and is dropped; it never stops boot.

## Fields {#fields}

| Field | Type | Default | Meaning |
|---|---|---|---|
| `prompt` | one-line string | unset | Operator text added to the system prompt under `## This room`. Longer text goes in a [prompt file](#prompt-files). |
| `skills` | comma list | unset | Skills pinned in full for the room. Skipped when the personality cannot see the skill. |
| `model` | string | unset | Model-registry alias or role. A raw model id is accepted when no registry is configured. |
| `tier` | `trivial` \| `default` \| `deep` \| `dreaming` | unset | Model tier for the room. With `model` also set, `model` wins and a warning is logged. |
| `identity` | boolean | `true` | Add the line naming the bot's own handle. Rooms only; never in a DM. |
| `metadata` | boolean | `false` | Allow untrusted room metadata (topic, purpose, name) on the user message. Also needs the platform's `fetch_metadata`. |
| `inherit` | boolean | `true` | `false` stops the entry from falling back to its parent room or to `*`. |
| `silent` | boolean | `false` | A reply that is exactly `NO_REPLY` or `[SILENT]` sends nothing, and the room's side messages are suppressed too: see [Silent rooms](#silent). |
| `mode` | token `[a-z_]+` | unset | Default reply mode for the room. Checked against the platform's own list; an unsupported mode is dropped with a warning. |

Not on the entry, on purpose: who may talk to the bot, `requireMention`, and the shared or private audience. Those stay with the access settings and `gateway.private_chats`.

## Web UI {#web-ui}

**Communications → platform tab → Rooms** edits these keys. The mapping:

| Web UI | Writes |
|---|---|
| Room prompt | `~/.ethos/channels/<platform>/<file>.md` (always a file; an inline `prompt` for the selector is removed) |
| Skills, Mode, Model or tier, Silent, Identity, Metadata, Inherit | `channels.<platform>.<selector>.<field>` |
| Fetch room metadata (Slack, Discord) | `channels.<platform>.fetch_metadata` |
| Name matching | Read-only. `allow_name_matching` is never written by the UI. |

The editor refuses what the loader would drop (a mode outside the platform's list, Telegram `regex_match`, a model with a tier, an unknown model alias when a registry exists, a prompt over 4,000 characters). A web save keeps every other `channels.*` line byte for byte, including wildcard, `@g.us` and `name:` selectors. Saves are cookie-session only; an API key gets 403. Restart the gateway to apply. Walkthrough: [From the web UI](../../how-to/give-each-room-its-own-prompt.md#from-the-web-ui).

## Selectors {#selectors}

| Selector | Matches |
|---|---|
| `<roomId>` | One room. Ids match exactly and case-sensitively. Dots and `@` are allowed (`120363000000000000@g.us`). |
| `<roomId>.topics.<subId>` | A sub-room under its room: a Telegram topic, a Discord thread, or any plugin `threadId`. |
| `*` | Any room that is not a DM on that platform. |
| `*dm` | Any DM on that platform, shared-hint DMs included. |
| `name:<slug>` | A room whose name slugs to `<slug>`. Used only when `allow_name_matching: true`. |

Resolution order, most specific first: a direct thread key (Discord, where a thread id is a channel id), then `<roomId>.topics.<subId>`, then the room, then `*` or `*dm`. Prompts concatenate from least to most specific. Every other field comes from the most specific layer that sets it. A wildcard prompt applies only when no other layer has one.

## Prompt files {#prompt-files}

`~/.ethos/channels/<platform>/<file>.md`, read through Storage at startup. The body is the prompt.

| Selector | File |
|---|---|
| `<roomId>` | `<roomId>.md` |
| `<roomId>.topics.<subId>` | `<roomId>.topics.<subId>.md` |
| `*` | `_rooms.md` |
| `*dm` | `_dms.md` |
| `name:<slug>` | `name_<slug>.md` |

An inline `prompt` in `config.yaml` wins over a file for the same selector, with a boot warning. The loader is [`apps/ethos/src/room-policy-load.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/room-policy-load.ts); the table builder is `buildRoomPolicyTable` in [`extensions/gateway/src/room-policy.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/gateway/src/room-policy.ts).

## Caps {#caps}

| Limit | Value | When exceeded |
|---|---|---|
| Prompt file size | 16 KiB | The file is skipped with a warning. |
| One prompt layer | 4,000 characters | The layer is dropped, not truncated, with a warning. |
| Whole rendered block | 8,000 characters | The most specific layer is dropped until it fits. The gateway records `gateway.room_prompt_trimmed` once per session. |
| Metadata fields | name 400, topic 800, purpose 800 characters | Cut and marked `…[truncated]`. |

## Platform knobs {#knobs}

| Key | Default | Meaning |
|---|---|---|
| `channels.<platform>.allow_name_matching` | `false` | Let `name:<slug>` selectors match. Anyone who can rename a room can move it onto another entry, so leave it off unless you trust the room's editors. |
| `channels.<platform>.fetch_metadata` | `false` | Let the adapter fetch the room's topic, purpose or description. Used only for entries with `metadata: true`. On Slack, messages in a channel are delivered in order, so the first message in a channel may wait briefly (bounded) while the topic and purpose are fetched. |

## Reply modes per platform {#modes}

| Platform | Values accepted for `mode` |
|---|---|
| Slack, Discord | `mention_only`, `thread_follow`, `all`, `observe` |
| Telegram | `mention_only`, `thread_follow`, `all`, `regex_match`, `observe` (`regex_match` is rejected as a room `mode`: a room entry has no pattern field) |
| WhatsApp | `all`, `mention_only`, `observe` |

On Telegram, a room `mode: regex_match` is rejected at load with the warning `'regex_match' needs a pattern — set it at runtime with the channel-mode command`, and the field is dropped. Set the pattern at runtime with `/channel-mode`. Validation: `validateMode` in `loadRoomPolicies`, [`apps/ethos/src/commands/gateway.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/gateway.ts).

Precedence: runtime `/channel-mode` override, then the room's `mode`, then the platform default, then the built-in default.

## Silent rooms {#silent}

In a room with `silent: true`, a reply that is exactly `NO_REPLY` or `[SILENT]` sends nothing. The gateway also suppresses the messages that would reveal the turn happened:

| Suppressed in a silent room | Notes |
|---|---|
| Steer acknowledgement (`↩ noted …`) | A message that steers a running turn is accepted without a reply. |
| Queued-message acknowledgement | A message queued behind a running turn is accepted without a reply. |
| Tool-progress lines | Tool progress is not posted to the room. |
| Slow-turn notice | No "still working" message. |
| Discord "Thinking…" placeholder | Cleared once the turn ends in silence. |

If a halt or output-cap notice follows a `NO_REPLY` answer, only the notice is sent. The answer itself is still dropped.

## Examples {#examples}

```yaml
channels.slack.C0DEPLOY.prompt: "This channel coordinates production deploys. Confirm service and environment first."
channels.slack.C0DEPLOY.skills: deploy-runbook, change-freeze
channels.slack.C0DEPLOY.model: sonnet-fast
channels.slack.*.prompt: "You are in a shared team channel. Keep answers short; link, don't paste."
channels.slack.*dm.prompt: "This is a private DM with the operator."
channels.telegram.-1001234567890.topics.99.tier: trivial
channels.telegram.*.identity: true
channels.slack.C0ALERTS.silent: true
```

## Observability events {#events}

| Event | Raised when |
|---|---|
| `gateway.room_policy_changed` | A session's room prompt digest differs from its last turn (after an edit and restart). |
| `gateway.room_prompt_trimmed` | The rendered block was cut to fit the 8,000-character cap. |
| `gateway.silent_reply` | A silent room's reply was a silence marker and nothing was sent. |
| `gateway.room_metadata_blocked` | Room metadata looked like instructions and was not sent to the model. |

## Coming from Hermes {#from-hermes}

| Hermes | Ethos |
|---|---|
| `channel_prompts` | `channels.<platform>.<id>.prompt`, or a prompt file |
| `channel_skill_bindings` | `channels.<platform>.<id>.skills` |
| `channel_overrides.model` | `channels.<platform>.<id>.model` (or `tier`) |
| `channel_overrides.allow_silence` | `channels.<platform>.<id>.silent` |
| `free_response_channels` | `channels.<platform>.<id>.mode: all` |
| `thread_require_mention: true` | `channels.<platform>.<id>.mode: mention_only` |
| `group_allowed_chats` | [`channel_filter`](../../../platforms/telegram/access.md). Admission is a separate setting from room policy. |

## See also {#see-also}

- [Give each room its own prompt](../../how-to/give-each-room-its-own-prompt.md) — the task-shaped walkthrough
- [Slash commands reference](../slash-commands.md#slash-channel) — `/channel` and `/channel show`
- [Why does private memory stay out of shared rooms?](../../explanation/memory-model/shared-rooms.md) — room prompt versus audience
- [CLI: gateway commands](../cli/gateway-and-serve.md#ethos-channels) — `ethos channels resolve` and `list`
