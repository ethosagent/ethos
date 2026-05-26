# @ethosagent/platform-discord

Discord `PlatformAdapter` for Ethos — connects over Discord's persistent Gateway WebSocket so your bot serves one or more Discord servers with no public URL and no webhook plumbing.

This README walks an operator from zero to a working bot in about ten minutes, then documents the slash commands, channel-reply behaviour, approval gating, and troubleshooting paths. Contributors looking for the architectural picture jump to [Internals](#internals).

---

## What you can do

- **Chat with your Ethos personality from Discord** — DM the bot, @mention it in a channel, or post in a thread the bot has already joined; the personality answers with its configured prompt, tools, and memory.
- **Run multiple bots in one server** — one Discord application per personality (or per team coordinator). Each bot's conversations stay on its own routing lane.
- **Drive the agent without typing `@bot`** — the `/ethos` Application Command exposes `ask`, `new`, `personality`, `memory`, `status`, `kanban`, and `help` from anywhere the bot is installed.
- **Tune per-channel chattiness** — configure a channel's default reply mode (`mention_only`, `thread_follow`, or `all`) and the bot honours it across restarts.
- **Get one conversation per thread** — every Discord thread routes to its own session lane; threaded contexts never collide.
- **Gate tool execution on Discord roles** — approval cards appear as native Discord embeds with Approve / Deny buttons; who can click them is controlled by server role IDs.

---

## Quickstart — ten minutes to your first reply

You'll create a Discord application, invite the bot to your server, copy its token into Ethos, start the gateway, and @mention the bot.

### Prereqs

- `@ethosagent/cli` installed and `ethos setup` has been run (so you have a `~/.ethos/config.yaml` and at least one personality).
- A Discord server where you have Manage Server permissions (needed to install a bot).
- About ten minutes.

### Step 1 · Create a Discord application and bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Give it a name (e.g. `Researcher`, `Eng Coordinator`). This becomes the bot's display name by default.
3. Open the **Bot** tab in the left sidebar.
4. Click **Reset Token** to generate a bot token. Copy it immediately — you cannot retrieve it again.
5. Still on the **Bot** tab, scroll down to **Privileged Gateway Intents** and enable **both** of the following:
   - **Message Content Intent** — **required**. Without this, `message.content` is empty for all guild messages; the bot sees the message was sent but cannot read its text.
   - **Server Members Intent** — needed for member role resolution in approval gating.
6. Save changes.
7. Note the **Application ID** from the **General Information** tab — you will need it for slash command registration.

### Step 2 · Create an invite URL and add the bot to your server

1. Open the **OAuth2** → **URL Generator** tab.
2. Under **Scopes**, select: `bot` and `applications.commands`.
3. Under **Bot Permissions**, select:
   - Send Messages
   - Read Messages / View Channels
   - Read Message History
   - Add Reactions
   - Use Application Commands
   - Manage Messages *(optional — needed for message edits; the adapter degrades gracefully without it)*
4. Copy the generated URL at the bottom of the page, open it in a new tab, and select the server you want to invite the bot to.

### Step 3 · Add the bot to `~/.ethos/config.yaml`

Each Discord application gets one entry under `discord.apps.<n>`. Pick any non-negative integer for `<n>`:

```yaml
discord.apps.0.token: Bot_…
discord.apps.0.applicationId: 123456789012345678
discord.apps.0.bind.type: personality       # or 'team'
discord.apps.0.bind.name: researcher        # personality id or team manifest name
# Optional: stable identifier surfaced in logs + gateway lane keys.
# Defaults to a 24-char sha256(token) prefix when omitted.
discord.apps.0.id: researcher-discord
# Register commands to a specific guild for instant dev iteration:
discord.apps.0.registerCommandsTo: "YOUR_GUILD_ID"
```

Declare as many apps as you want; each binds to exactly one personality or team coordinator.

> **Slash command registration** requires both `applicationId` and `registerCommandsTo` to be set. Use a guild ID for development (instant propagation); use `'global'` only when you explicitly want to push to all servers the bot is in (propagation takes up to one hour). Omit `registerCommandsTo` to skip auto-registration entirely and manage commands via a separate provisioning step.

### Step 4 · Start the gateway

```bash
ethos gateway start
```

Boot validates that every `bind.name` resolves to a known personality or team and refuses to start otherwise. On success you'll see one health line per bot — including the bound personality — and `Listening for messages.`

### Step 5 · Mention the bot and say hello

@mention the bot in any channel it has access to, or send it a DM. You should see a reply within a few seconds, in the personality's voice.

If you don't see a reply, jump to [Troubleshooting](#troubleshooting).

---

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

**`mentionOnly` adapter flag.** When `DiscordAdapterConfig.mentionOnly` is `true` (the default), inbound messages without a direct @mention of the bot are dropped before reaching the gateway, regardless of channel mode. Set it to `false` to let channel mode be the sole gating mechanism. This flag is a performance optimisation — it avoids waking the agent loop for messages that would be dropped anyway.

---

## Running multiple bots in one server

You can install multiple Discord applications into the same server — one per personality (or team). Each is a separate user in Discord and a separate routing lane in Ethos:

- Each bot's lane key is `discord:<botKey>:<channelId>[:<threadId>]`. Conversations never cross bots.
- `botKey` defaults to a 24-char `sha256(token)` prefix, or you can set `discord.apps.<n>.id` explicitly for a stable, log-friendly identifier.
- A user can chat with multiple bots in the same channel; each sees only the messages addressed to it (per the channel mode and `mentionOnly` setting).

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
discord.apps.0.approvalPolicy: role_gate       # default — omit to keep role_gate
discord.apps.0.approvalRoleIds:
  - "1234567890123456789"                       # role ID from Server Settings → Roles
  - "9876543210987654321"
```

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
| Bot never replies in a guild channel | `mentionOnly: true` (default) and you didn't @mention the bot, or channel mode is `mention_only` | @mention the bot explicitly, or set `discord.apps.<n>.mentionOnly: false` and configure a permissive channel mode |
| `message.content` is empty / bot seems to receive messages but can't read them | **Message Content Intent** not enabled in the Developer Portal | Go to Developer Portal → your app → Bot → Privileged Gateway Intents → enable **Message Content Intent**; save; restart the gateway |
| `/ethos` doesn't appear in the slash-command picker | `applicationId` or `registerCommandsTo` not set in config, or global commands haven't propagated yet | Set both config fields and restart; if using `registerCommandsTo: 'global'`, wait up to one hour for propagation |
| Bot can't receive DMs | `Channel`, `Message`, or `Reaction` Partials missing — this is a code-level issue in custom forks | The adapter always initialises all three Partials; ensure you haven't stripped them from a fork |
| Receipt reaction (👀) is not cleared after the bot replies | `GuildMessageReactions` intent not enabled, or the bot lacks **Add Reactions** permission in that channel | Verify intents in the Developer Portal; check channel permissions for the bot role |
| Approval buttons show "You do not have permission" | User lacks the required role | Add the user's role ID to `discord.apps.<n>.approvalRoleIds`; or switch to `approvalPolicy: allow_any` |
| Approval buttons show "Approval roles not configured. No one can approve." | `approvalPolicy` is `role_gate` but `approvalRoleIds` is empty | Set at least one role ID in `discord.apps.<n>.approvalRoleIds` |
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

## Internals

### Directory layout

```
src/
├── index.ts                  # public barrel — DiscordAdapter, DiscordAdapterConfig
├── config.ts                 # zod schemas: ChannelMode, Binding; DEFAULT_CHANNEL_MODE
├── chunking.ts               # 2000-char text splitter + reflowChunks helper
├── format.ts                 # toNativeMarkdown — converts common markdown to Discord flavour
├── types.ts                  # DiscordClarifyInteraction and shared internal types
├── validate.ts               # input validation helpers
├── clarify-blocks.ts         # clarifyModalPayload builder
├── clarify-interactions.ts   # clarify interaction handler wiring
├── clarify-surface.ts        # exported clarify surface helpers
│
├── events/
│   ├── messages.ts           # messageCreate → mentionOnly triage → channel-mode gate → onMessage
│   └── interactions.ts       # interactionCreate → command dispatch + approval routing + clarify modals
│
├── commands/                 # slash command handlers (pure dispatch)
│   ├── index.ts              # COMMAND_DEFINITIONS + dispatch(payload, ctx)
│   ├── ask.ts
│   ├── help.ts
│   ├── new.ts
│   ├── personality.ts
│   ├── memory.ts
│   ├── status.ts
│   └── kanban.ts
│
├── blocks/                   # pure embed builders — (data) => DiscordEmbed
│   ├── shared.ts             # embed(), field(), button(), actionRow(), escapeMarkdown(), truncate()
│   ├── approval.ts           # approvalPendingEmbed, approvalResolvedEmbed, approvalPendingButtons
│   ├── help.ts
│   ├── kanban.ts
│   ├── memory.ts
│   ├── personality.ts
│   └── session.ts
│
├── store/                    # JSONL-backed adapter-owned persistence
│   ├── channel-overrides.ts  # ChannelOverrideStore
│   └── thread-state.ts       # ThreadStateStore
│
└── __tests__/
```

### Key contracts

| Field | Where | Purpose |
|---|---|---|
| `InboundMessage.botKey` | `@ethosagent/types` | Multi-bot routing — gateway picks the right `AgentLoop` per bot. |
| `InboundMessage.threadId` | `@ethosagent/types` | Thread isolation — gateway lane key includes it when present. |
| `OutboundMessage.threadId` | `@ethosagent/types` | Lets the gateway direct agent replies to the originating thread channel. |
| `DiscordAdapterConfig.binding` | `./index` | Drives `/ethos personality`, `/ethos help`, and approval-card routing. |
| `DiscordAdapterConfig.storage` | `./index` | Required for channel-mode persistence and thread-follow state. |
| `DiscordAdapterConfig.approvalRoleIds` | `./index` | Role IDs permitted to click Approve / Deny. Required for `role_gate` policy. |
| `DiscordAdapterConfig.approvalPolicy` | `./index` | `'role_gate'` (default) or `'allow_any'`. Controls approval button authorization. |
| `DiscordAdapterConfig.applicationId` | `./index` | Discord Application ID — required for slash command registration. |
| `DiscordAdapterConfig.registerCommandsTo` | `./index` | Guild ID (instant) or `'global'` (up to 1 hour). Omit to skip auto-registration. |

### Design notes

**Pure embed builders.** Every `blocks/<name>.ts` is `(data) => DiscordEmbed` (or returns embed-shaped objects) — no I/O, no discord.js client dependency, no side effects. Trivially unit-testable and replaceable for theming. The structural `DiscordEmbed` type in `blocks/shared.ts` matches the Discord API shape directly; no discord.js embed builder classes are used in the block layer.

**Pure slash dispatcher.** `commands/index.ts` exports `dispatch(payload, ctx) => Promise<CommandResponse>` — a pure async function over a structured payload and context. The discord.js interaction wiring in `events/interactions.ts` is the only place that touches the real Discord API; tests exercise `dispatch` directly without a real bot.

**Outbound dedup is gateway-only.** Per [ARCHITECTURE.md](../../ARCHITECTURE.md) §V S3, all outbound dedup is centralized in `extensions/gateway/src/dedup.ts`. The Discord adapter does **not** implement adapter-local dedup. If you find any in this tree, it is a bug.

**Guild-scoped vs global command registration.** `registerSlashCommands()` uses `Routes.applicationGuildCommands(appId, guildId)` for a guild target (instant, takes effect in seconds) or `Routes.applicationCommands(appId)` for global (overwrites the entire application command set, takes up to one hour to propagate). Registration failures are non-fatal — the bot continues to work; slash commands just won't appear until registration succeeds. Prefer guild-scoped during development.

**`mentionOnly` triage.** The message handler checks `mentionOnly` and the channel mode before emitting to `onMessage`. Messages that fail both checks are discarded at the adapter layer, before reaching the gateway or agent loop. This keeps the gateway clean of events it would drop anyway.

**Chunk map and reflow.** `editMessage()` uses `reflowChunks` to keep edits coherent when the agent streams a growing response: it edits existing Discord messages in place when the chunk count is unchanged, appends new messages when the text grows beyond 2000 characters, and deletes trailing messages when the text shrinks. The chunk map (capped at 1024 entries, FIFO eviction) tracks which Discord message IDs belong to which logical response.

**No App Home tab.** Discord has no equivalent to Slack's App Home tab. Per-bot status is surfaced through `/ethos status` and `/ethos personality` slash commands instead.

**No link unfurling.** Discord handles link previews natively in the client; there is no API for bots to provide custom unfurls.

**Health check.** `health()` returns `ok: true` when `client.ws.status === 0` (the discord.js `WebSocketStatus.Ready` constant) and `latencyMs` from `client.ws.ping` (the heartbeat round-trip as measured by the discord.js WebSocket manager).

---

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Public barrel — `DiscordAdapter`, `DiscordAdapterConfig`, re-exports. |
| `src/config.ts` | Zod schemas for `ChannelMode` and `Binding`; `DEFAULT_CHANNEL_MODE`. |
| `src/chunking.ts` | `chunkText` + `reflowChunks` (2000-char Discord message ceiling). |
| `src/format.ts` | `toNativeMarkdown` — converts common markdown to Discord's flavour. |
| `src/types.ts` | `DiscordClarifyInteraction` and shared internal types. |
| `src/validate.ts` | Input validation helpers used across command handlers. |
| `src/clarify-blocks.ts` | `clarifyModalPayload` builder for clarification modal cards. |
| `src/clarify-interactions.ts` | Wiring for clarify interaction events. |
| `src/clarify-surface.ts` | Exported helpers for the clarify surface contract. |
| `src/events/messages.ts` | `messageCreate` handler — `mentionOnly` triage, channel-mode gate, receipt reaction, attachment ingestion. |
| `src/events/interactions.ts` | `interactionCreate` handler — slash command dispatch, approval button routing, clarify modal routing. |
| `src/commands/` | Slash subcommand handlers (`ask`, `help`, `new`, `personality`, `memory`, `status`, `kanban`) + `dispatch`. |
| `src/blocks/` | Pure Discord embed builders — no I/O, no discord.js client dependency. |
| `src/store/` | JSONL-backed channel-override and thread-state persistence. |
| `src/__tests__/` | Unit tests for all of the above. |
| `package.json` | Workspace package; deps `discord.js` ^14.16, `@ethosagent/types`, `@ethosagent/core`. |
