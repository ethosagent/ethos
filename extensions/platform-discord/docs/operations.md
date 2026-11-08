# platform-discord behaviour and operations

## `/ethos` slash commands

Once registered, anyone can invoke `/ethos` from any channel the bot is in, or from a DM. All responses are ephemeral — only the invoker sees them — except `ask`, which posts the agent's reply publicly so the rest of the channel can see the conversation.

All subcommands live under a single `/ethos` root command, which appears as one entry in Discord's command picker.

| Command | Visibility | What it does |
|---|---|---|
| `/ethos ask <prompt>` | public agent reply | Submits the prompt to the bound personality. The agent's reply appears in the channel (or thread) as a normal message, visible to everyone. |
| `/ethos new` | ephemeral | Starts a fresh session, discarding the current conversation history for this channel. |
| `/ethos personality` | ephemeral | One-line view of the bot's binding (personality or team coordinator). With `action: list`, lists available personalities. With `action: switch`, switches the binding. Personality bindings only for list/switch. |
| `/ethos memory` | ephemeral | With `action: show`, displays recent entries from the bound personality's `MEMORY.md`. With `action: clear`, clears the memory store. Personality bindings only — team bots receive "Memory is unavailable for this bot." |
| `/ethos status` | ephemeral | Shows recent sessions and any pending clarification requests waiting for a response. |
| `/ethos kanban` | ephemeral | Shows a summary of open kanban tickets. **Team bots only.** Personality-bound bots receive a "this is a team feature" message. |
| `/ethos help` | ephemeral | Lists every subcommand with the bot's binding and active channel mode for context. |

Every command response uses Discord embeds (title + description + fields) with a plaintext `content` field as a screen-reader-friendly fallback.

> **No channel-mode slash command.** Unlike the Slack adapter, the Discord adapter has no `/ethos channel-mode` slash command. Channel mode is set via `discord.apps.<n>.defaultChannelMode` in `~/.ethos/config.yaml` or by writing to the `ChannelOverrideStore` directly.

---

## Channel reply modes

A bot in a guild channel is in one of three modes. Default is `mention_only`.

| Mode | The bot replies when… |
|---|---|
| `mention_only` *(default)* | DM, OR explicit `@bot` mention. Silent otherwise. |
| `thread_follow` | `mention_only` behaviours plus any message in a thread the bot has previously posted in. *Once invited, stay.* |
| `all` | Every message in the channel. Use for dedicated channels like `#ai-pair`. The bot will respond to noise too. |

**Precedence:** per-channel override (set via `ChannelOverrideStore`) > app-level default (`discord.apps.<n>.defaultChannelMode`) > built-in default (`mention_only`).

**DMs ignore the mode** — there's no useful semantic for "only @mention me in a DM," so the bot always replies in a direct message.

**Cost note for `all` mode.** A bot in `all` mode on a busy channel responds to every message, including ones that probably weren't meant for it. The adapter does not enforce rate limits. Choose this mode only for channels where all activity is directed at the bot.

---

## Running multiple bots in one server

You can install multiple Discord applications into the same server — one per personality (or team). Each is a separate user in Discord and a separate routing lane in Ethos:

- Each bot's lane key is `discord:<botKey>:<channelId>[:<threadId>]`. Conversations never cross bots.
- `botKey` defaults to a 24-char `sha256(token)` prefix, or you can set `discord.apps.<n>.id` explicitly for a stable, log-friendly identifier.
- A user can chat with multiple bots in the same channel; each sees only the messages addressed to it (per the channel mode).

---

## Thread isolation

The adapter routes threaded conversations to their own session lanes:

- Threaded replies set `InboundMessage.threadId` to the thread channel's ID. The gateway lane key becomes `discord:<botKey>:<parentChannelId>:<threadId>`, isolated from every other thread in the channel and from the channel root.
- Channel-root posts leave `threadId` undefined. The lane key stays `discord:<botKey>:<channelId>`.

Agent replies are sent to the correct target automatically: the gateway passes the inbound `threadId` through to `adapter.send()`, so a reply to a threaded message lands in the thread and a reply to a channel-root post lands at the channel root.

The threading concept stays inside the Discord adapter — `InboundMessage.threadId` is a generic, opaque routing segment in the platform contract. No Discord-specific encoding leaks into the gateway or other adapters.

---

## Approval gates

The Discord adapter implements `ApprovalCapableAdapter`. When a tool execution requires human approval, the adapter posts a native Discord embed with **Approve** and **Deny** buttons. Once a decision is made, the embed updates in place to reflect the outcome.

### Approval policy

Two policies control who may click the buttons:

| Policy | Behaviour |
|---|---|
| `role_gate` *(default)* | Only users with a role listed in `approvalRoleIds` may approve or deny. If `approvalRoleIds` is empty or unset, all clicks are rejected with an ephemeral error — this is intentional; you must explicitly configure which roles can approve. |
| `allow_any` | Any channel member may approve. Explicit opt-in to open approval. |

### Configuring approval roles

```yaml
discord.approvalRoleIds: 1234567890123456789,9876543210987654321   # role IDs, comma-separated
```

`buildAdapters` (apps/ethos/src/commands/gateway.ts) passes this key to `DiscordAdapterConfig.approvalRoleIds`. `approvalPolicy` has no config key: the gateway always runs the default `role_gate`, so `allow_any` is reachable only by constructing the adapter directly.

To find a role ID: open **Server Settings → Roles**, right-click the role, and select **Copy Role ID**. Developer Mode must be enabled in Discord settings (User Settings → Advanced → Developer Mode).

### Behaviour when `approvalRoleIds` is empty

If `approvalPolicy` is `role_gate` and `approvalRoleIds` is empty or not configured, the adapter replies ephemerally with `"Approval roles not configured. No one can approve."` to any user who clicks a button. The pending approval stays open until it times out or is resolved by another path. Configure at least one role ID before using approval-gated tools.

---

## Adapter-owned state

The adapter persists two things under `~/.ethos/discord/<botKey>/`:

```
channel-overrides.jsonl    # one record per channel-mode override
thread-state.jsonl         # one record per (channel, thread) the bot has posted in
```

Both are JSONL, append-only — the latest record per key wins. Truncating either file is safe; the adapter rebuilds in-memory state from whatever lines remain. Inspect them to confirm a setting took effect; delete them to start fresh.

The `discordDir` config option (default `'discord'`) controls the subdirectory name under `~/.ethos/`. Override it when running multiple isolated adapter instances that should not share state.

---

## Troubleshooting

If something looks wrong after Step 5, work top-to-bottom — earlier rows block later ones.

| Symptom | Likely cause | Fix |
|---|---|---|
| `ethos gateway start` exits with `bind.name does not resolve` | A `discord.apps.<n>.bind.name` doesn't match any personality or team on disk | Run `ethos personality list` (and check `~/.ethos/teams/`); correct the `bind.name` |
| Bot never replies in a guild channel | channel mode is `mention_only` (the default) and you didn't @mention the bot | @mention the bot explicitly, or set a permissive channel mode |
| `message.content` is empty / bot seems to receive messages but can't read them | **Message Content Intent** not enabled in the Developer Portal | Go to Developer Portal → your app → Bot → Privileged Gateway Intents → enable **Message Content Intent**; save; restart the gateway |
| `/ethos` doesn't appear in the slash-command picker | `applicationId` or `registerCommandsTo` not set in config, or global commands haven't propagated yet | Set both config fields and restart; if using `registerCommandsTo: 'global'`, wait up to one hour for propagation |
| Bot can't receive DMs | `Channel`, `Message`, or `Reaction` Partials missing — this is a code-level issue in custom forks | The adapter always initialises all three Partials; ensure you haven't stripped them from a fork |
| Receipt reaction (👀) is not cleared after the bot replies | `GuildMessageReactions` intent not enabled, or the bot lacks **Add Reactions** permission in that channel | Verify intents in the Developer Portal; check channel permissions for the bot role |
| Approval buttons show "You do not have permission" | User lacks the required role | Add one of the user's role IDs to `discord.approvalRoleIds` |
| Approval buttons show "Approval roles not configured. No one can approve." | `approvalPolicy` is `role_gate` but `approvalRoleIds` is empty | Set at least one role ID in `discord.approvalRoleIds` |
| Long agent replies look chopped into multiple messages | Working as intended — Discord's 2000-character per-message ceiling; the adapter chunks automatically | Nothing to fix; chunks land sequentially in the same channel or thread |
| Bot replies but with garbled formatting | Markdown dialect mismatch — Discord uses its own flavour | The adapter's `toNativeMarkdown()` in `src/format.ts` converts from common markdown; open an issue if a specific pattern is broken |

---

## File Attachments

The adapter ingests file attachments from Discord messages. Attached files are downloaded from Discord's CDN and cached locally before being passed to the agent.

### How Discord attachments work

Discord exposes attachments on `message.attachments` as a collection of `Attachment` objects, each with a CDN URL, filename, size in bytes, and content type. The adapter downloads each attachment and writes it to the local cache before forwarding it to the agent as part of the `InboundMessage`.

### Supported types

| Category | Extensions |
|---|---|
| Images | jpg, jpeg, png, gif, webp, heic, bmp, svg, tiff |
| Documents | pdf, txt, csv, json, yaml, md, and other non-skipped extensions |

### Size cap

25 MB per file. Files exceeding this limit are silently skipped and not forwarded to the agent.

### Cache location

Downloaded files are written to `~/.ethos/cache/attachments/` via the `AttachmentCache`. The cache is keyed by session, so different channels and threads do not share cached files. Pass a custom `AttachmentCache` implementation via `DiscordAdapterConfig.cache` to override the storage strategy.

### Deferred

Audio (mp3, wav, ogg, flac, aac, m4a) and video (mp4, mov, webm, avi, mkv) files are intentionally skipped. These types are deferred until transcription and media analysis tools ship.

---

## Receipt reactions

On every inbound message the adapter sets a 👀 reaction so the user can see the agent has the message; the reaction is cleared once the reply lands. Matches Telegram's behaviour.

### Override

Pass the emoji character directly — not a name — via `receiptReaction`:

```yaml
discord.apps.0.receiptReaction: "🔍"
```

This differs from the Slack adapter, which accepts an emoji name like `'thinking_face'`. Discord requires the actual Unicode character (e.g. `'🔍'`) or a custom emoji string in the form `<:name:id>`.

### Required intent and permission

- **Intent**: `GuildMessageReactions` — enabled automatically by the adapter's `Client` constructor.
- **Permission**: the bot must have **Add Reactions** in the target channel.

Without the intent or permission, reaction calls fail silently and the rest of the bot continues to work — you just don't get the receipt cue.

The `pendingReactions` map is bounded at 256 entries (FIFO eviction). In high-throughput channels where the bot cannot clear reactions fast enough, the oldest pending reactions are evicted from the map; this is a safeguard against unbounded memory growth.

---

