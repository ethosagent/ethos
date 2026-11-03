# platform-discord setup

Discord `PlatformAdapter` for Ethos — connects over Discord's persistent Gateway WebSocket so your bot serves one or more Discord servers with no public URL and no webhook plumbing.

This README walks an operator from zero to a working bot in about ten minutes, then documents the slash commands, channel-reply behaviour, approval gating, and troubleshooting paths. Contributors looking for the architectural picture jump to [Internals](internals.md).

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

If you don't see a reply, jump to [Troubleshooting](operations.md#troubleshooting).

---

