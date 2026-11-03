# platform-slack setup

Slack `PlatformAdapter` for Ethos — runs in Socket Mode so your bot serves a Slack workspace with no public URL and no webhook plumbing.

This README walks an operator from zero to a working bot in about ten minutes, then documents the slash commands, channel-reply behaviour, and troubleshooting paths. Contributors looking for the architectural picture jump to [Internals](internals.md).

---

## What you can do

- **Chat with your Ethos personality from Slack** — DM the bot, @mention it in a channel, or open a thread; the personality answers with its configured prompt, tools, and memory.
- **Run multiple bots in one workspace** — one Slack app per personality (or per team coordinator). Each bot's conversations stay on its own lane.
- **Drive the agent without typing `@bot`** — the `/ethos` slash command exposes `ask`, `personality`, `memory`, `channel-mode`, and `help` from anywhere the bot is installed.
- **Tune per-channel chattiness** — set a channel to `mention_only`, `thread_follow`, or `all` and the bot honours it across restarts.
- **Get one conversation per thread** — every Slack thread routes to its own session lane; threaded contexts never collide.
- **See the bot's state at a glance** — open the bot's **Home** tab in Slack for its binding, recent memory, and the channels it lives in.

---

## Quickstart — ten minutes to your first reply

You'll create a Slack app, copy three secrets into Ethos, start the gateway, and DM the bot.

### Prereqs

- `@ethosagent/cli` installed and `ethos setup` has been run (so you have a `~/.ethos/config.yaml` and at least one personality).
- A Slack workspace where you can install a custom app.
- About ten minutes.

### Step 1 · Create the Slack app

1. Open the [Slack API dashboard](https://api.slack.com/apps) → **Create New App** → **From an app manifest**.
2. Pick the workspace.
3. Paste the manifest below. Replace `<DISPLAY-NAME>` with what you want users to see in Slack (e.g. `Researcher`, `Eng Coordinator`).

```yaml
display_information:
  name: "<DISPLAY-NAME>"
  description: "Ethos agent — bound to one personality or team coordinator."
features:
  app_home:
    home_tab_enabled: true
    messages_tab_enabled: false
  bot_user:
    display_name: "<DISPLAY-NAME>"
    always_online: true
  slash_commands:
    - command: /ethos
      description: "Ethos commands (ask, personality, memory, channel-mode, help)"
      usage_hint: "ask <prompt>  ·  channel-mode all  ·  help"
      should_escape: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - commands
      - files:read
      - groups:history
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_home_opened
      - app_mention
      - member_joined_channel
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

The `commands` block is what makes `/ethos` show up in Slack's command picker. `socket_mode_enabled: true` is what lets the bot dial out to Slack so you don't need a public webhook. The `app_home` block enables the **Home** tab and `app_home_opened` is the event that triggers it.

### Step 2 · Generate three secrets

| Token | Where to find it |
|---|---|
| `botToken` (`xoxb-…`) | **OAuth & Permissions → Install to Workspace**, then copy the *Bot User OAuth Token*. |
| `appToken` (`xapp-…`) | **Basic Information → App-Level Tokens → Generate Token and Scopes** — add `connections:write` and `authorizations:read`. |
| `signingSecret` | **Basic Information → App Credentials → Signing Secret**. |

### Step 3 · Add the bot to `~/.ethos/config.yaml`

Each Slack app gets one entry under `slack.apps.<n>`. Pick any non-negative integer for `<n>`:

```yaml
slack.apps.0.botToken: xoxb-…
slack.apps.0.appToken: xapp-…
slack.apps.0.signingSecret: …
slack.apps.0.bind.type: personality       # or 'team'
slack.apps.0.bind.name: researcher        # personality id or team manifest name
# Optional: stable identifier surfaced in logs + gateway lane keys.
# Defaults to a 24-char sha256(botToken) prefix when omitted.
slack.apps.0.id: researcher-app
```

Declare as many apps as you want; each binds to exactly one personality or team coordinator.

### Step 4 · Start the gateway

```bash
ethos gateway start
```

Boot validates that every `bind.name` resolves to a known personality or team and refuses to start otherwise. On success you'll see one health line per bot — including the bound personality — and `Listening for messages.`

### Step 5 · Invite the bot and say hello

1. In Slack, invite the bot to a channel (or DM it directly).
2. When the bot joins a channel, it posts a one-line introduction with its binding and the channel's current reply mode.
3. DM the bot. You should see a reply within a few seconds, in the personality's voice.

If you don't see a reply, jump to [Troubleshooting](operations.md#troubleshooting).

---

