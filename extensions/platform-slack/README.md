# @ethosagent/platform-slack

Slack `PlatformAdapter` for Ethos — runs in Socket Mode so your bot serves a Slack workspace with no public URL and no webhook plumbing.

This README walks an operator from zero to a working bot in about ten minutes, then documents the slash commands, channel-reply behaviour, and troubleshooting paths. Contributors looking for the architectural picture jump to [Internals](#internals).

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

If you don't see a reply, jump to [Troubleshooting](#troubleshooting).

---

## `/ethos` slash commands

Once `/ethos` is registered in the manifest, anyone can invoke it from any channel the bot is in, or from a DM. Most responses are ephemeral — only the invoker sees them.

| Command | Visibility | What it does |
|---|---|---|
| `/ethos ask <prompt>` | public ack + agent reply | Submits the prompt to the bound personality. The slash command posts a short public acknowledgement so the channel sees who asked; the agent's reply arrives through the normal outbound path and threads the same way a regular reply would. |
| `/ethos personality` | ephemeral | One-line view of the bot's binding (personality or team coordinator). |
| `/ethos personality rich` | ephemeral | Full character sheet for the bound personality — identity, model, tools, and resolved skills, in Block Kit. Personality bindings only; team bindings fall back to the compact view. Filesystem reach, MCP servers, and plugins are deliberately omitted — they're recon for an attacker on a command anyone in a channel can run; the operator-facing CLI sheet still shows them. |
| `/ethos memory show` | ephemeral | Last five entries from the bound personality's `MEMORY.md`. Personality bindings only — team bots get "Memory is unavailable for this bot." |
| `/ethos memory add <text>` | ephemeral | Appends an entry to the bound personality's `MEMORY.md`. Personality bindings only. |
| `/ethos channel-mode show` | ephemeral | Reports the active mode for the current channel and whether it's an override or the app default. |
| `/ethos channel-mode <mode>` | ephemeral | Sets the mode. Valid values: `mention_only`, `thread_follow`, `all`. Persisted under `~/.ethos/slack/<botKey>/channel-overrides.jsonl`; survives restart. |
| `/ethos kanban list` | ephemeral | Block Kit list of open kanban tickets. **Team bots only.** Personality-bound bots get a "this is a team feature" message. The team-kanban reader isn't wired into the gateway yet; the command returns "Kanban is unavailable" until it is. |
| `/ethos help` | ephemeral | Lists every subcommand with the bot's binding and active channel mode for context. |

Every subcommand returns Block Kit (header + sections + context) plus a plaintext fallback in the message `text` field for notifications and screen-readers.

---

## Channel reply modes

A bot in a channel is in one of three modes. Default is `mention_only`.

| Mode | The bot replies when… |
|---|---|
| `mention_only` *(default)* | DM, OR explicit `@bot` mention. Silent otherwise. |
| `thread_follow` | `mention_only` behaviours plus any message in a thread the bot has previously posted in. *Once invited, stay.* |
| `all` | Every message in the channel. Use for dedicated channels like `#ai-pair`. The bot will respond to noise too. |

**Precedence:** per-channel override (set via `/ethos channel-mode`) > app-level default (currently always `mention_only`) > built-in default (`mention_only`).

**DMs ignore the mode** — there's no useful semantic for "only `@mention` me in a DM," so the bot always replies in a direct message.

**Cost note for `all` mode.** A bot in `all` mode on a busy channel responds to every message, including ones that probably weren't meant for it. The adapter doesn't enforce limits. The member-join greeting tells anyone joining the channel what mode they're walking into.

---

## Running multiple bots in one workspace

You can install one Slack app per personality (or team) into the same workspace. Each app is a separate user in Slack and a separate routing lane in Ethos:

- Each bot's lane key is `slack:<botKey>:<channel>[:<thread_ts>]`. Conversations never cross bots.
- `botKey` defaults to a 24-char `sha256(botToken)` prefix, or you can set `slack.apps.<n>.id` explicitly for a stable, log-friendly identifier.
- A user can chat with multiple bots in the same channel; each sees only the messages addressed to it (per the channel mode).

---

## Thread isolation

The adapter routes threaded conversations to their own session lanes:

- Threaded replies set `InboundMessage.threadId = thread_ts`. The gateway lane key becomes `slack:<botKey>:<channel>:<thread_ts>`, isolated from every other thread in the channel and from the channel root.
- Channel-root posts leave `threadId` undefined. The lane key stays `slack:<botKey>:<channel>`.

Agent replies thread automatically: the gateway passes the inbound `threadId` through to `chat.postMessage`, so a reply to a threaded message stays in the thread and a reply to a channel-root post lands at the channel root.

The threading concept stays inside the Slack adapter — `InboundMessage.threadId` is a generic, opaque routing segment in the platform contract. No Slack-specific encoding leaks into the gateway or other adapters.

---

## App Home tab

Click the bot's name in Slack to open its **Home** tab — a read-only dashboard that the adapter publishes on `app_home_opened`. The header (binding, status) and "This bot is in" channel list are populated from day one. A **Refresh** button (`action_id: home:refresh`) re-publishes the tab on demand.

The tab is designed to also show recent sessions, active kanban tickets (team bots), and recent memory updates. Memory is wired today; sessions and kanban readers are not yet plumbed through gateway boot — those sections render empty until they are. Nothing else on the tab is affected.

---

## Adapter-owned state

The adapter persists two things under `~/.ethos/slack/<botKey>/`:

```
channel-overrides.jsonl    # one record per `/ethos channel-mode` change
thread-state.jsonl         # one record per (channel, thread) the bot has posted in
```

Both are JSONL, append-only — the latest record per key wins. Truncating either file is safe; the adapter rebuilds in-memory state from whatever lines remain. Inspect them to confirm a setting took effect; delete them to start fresh.

---

## Troubleshooting

If something looks wrong after Step 5, work top-to-bottom — earlier rows block later ones.

| Symptom | Likely cause | Fix |
|---|---|---|
| `ethos gateway start` exits with `bind.name does not resolve` | A `slack.apps.<n>.bind.name` doesn't match any personality or team on disk | Run `ethos personality list` (and check `~/.ethos/teams/`); correct the `bind.name` |
| Boot succeeds but the bot health line shows `⚠ slack:<key> health check failed` | Wrong `botToken` / `appToken` / `signingSecret`, or Socket Mode disabled | Re-copy the three secrets; confirm `socket_mode_enabled: true` and the `connections:write` + `authorizations:read` scopes on the app token |
| Bot never replies in a channel | The channel-mode is `mention_only` (default) and you didn't `@mention` the bot | Either `@mention` the bot, DM it, or run `/ethos channel-mode all` from inside the channel |
| `/ethos` doesn't appear in the slash-command picker | The `slash_commands` block in the manifest didn't get applied, or the app needs reinstall | Re-paste the manifest, then **Reinstall to Workspace** under OAuth & Permissions |
| Channel messages don't reach the bot at all | `message.channels` (or `message.groups`) missing from `event_subscriptions.bot_events` | Add the missing event(s); reinstall |
| No greeting when the bot joins a channel | `member_joined_channel` not subscribed, or the bot lacks `chat:write` in that channel | Subscribe the event in the manifest; re-invite the bot |
| App Home tab is blank or says "Sending messages to this app has been turned off" | `home_tab_enabled` missing, or `app_home_opened` not subscribed | Add both to the manifest; reinstall; re-open the tab |
| Long agent replies look chopped | Slack's 3000-char limit; the adapter chunks and reflows automatically | Working as intended — the chunks land in the same thread |
| The plaintext fallback shows raw `*mrkdwn*` | Slack strips formatting in notifications + screen-readers; the in-channel Block Kit is unaffected | Working as intended |

When in doubt, the live manifest is the source of truth — open the app's **App Manifest** tab in the Slack dashboard and compare to [Step 1](#step-1--create-the-slack-app).

---

## File Attachments

The adapter ingests files from Slack `file_share` messages. Files are downloaded using the bot token and cached locally.

### Required scope

`files:read` -- the bot token must have this scope to download files from `url_private_download`. The manifest in [Step 1](#step-1--create-the-slack-app) includes it. If you installed your app from an older manifest that omits it, add the scope under **OAuth & Permissions > Bot Token Scopes** and reinstall to the workspace. Without `files:read`, Slack serves an HTML login page in place of the file bytes; the adapter caches the HTML and the agent reports the attachment as not a valid image/PDF.

### Supported types

| Category | Attachment type | Extensions |
|---|---|---|
| Images | `image` | jpg, jpeg, png, gif, webp, heic, bmp, svg, tiff |
| Documents | `file` | pdf, txt, csv, json, yaml, md, and all other non-skipped extensions |

### Size cap

25 MB per file. Files exceeding this limit are silently skipped.

### Cache location

Downloaded files are written to `~/.ethos/cache/attachments/` via the `AttachmentCache`. The cache is keyed by session, so different channels and threads do not share cached files.

### Deferred

Audio (mp3, wav, ogg, flac, aac, m4a) and video (mp4, mov, webm, avi, mkv) files are intentionally skipped. These types are deferred until transcription and media analysis tools ship.

---

## Receipt reactions

On every inbound message the adapter sets a 👀 (`eyes`) reaction so the user can see the agent has the message; the reaction is cleared once the reply lands. Matches Telegram's behaviour. Override via the `receiptReaction` config option (Slack emoji name, no colons — e.g. `'thinking_face'`).

### Required scope

`reactions:write` -- the bot token must have this scope to set or clear the reaction. The manifest in [Step 1](#step-1--create-the-slack-app) includes it. If you installed your app from an older manifest that omits it, add the scope under **OAuth & Permissions > Bot Token Scopes** and reinstall to the workspace. Without the scope the reaction calls fail silently and the rest of the bot continues to work — you just don't get the receipt cue.

---

## Internals

### Directory layout

```
src/
├── index.ts                 # public barrel
├── adapter.ts               # SlackAdapter — Bolt wiring + lifecycle
├── chunking.ts              # 3000-char text splitter + reflow helper
├── config.ts                # zod schemas: ChannelMode, Binding, ChannelOverride
│
├── events/
│   ├── messages.ts          # message + app_mention → triage → onEnvelope
│   ├── members.ts           # member_joined_channel → greeting
│   └── links.ts             # link_shared → URL unfurls
│
├── routing/
│   ├── triage.ts            # raw event → InboundMessage envelope; channel-mode + threadId
│   └── channel-mode.ts      # pure shouldRespond(inputs) decision
│
├── commands/                # slash command handlers (pure dispatch)
│   ├── index.ts             # parser + dispatcher
│   ├── ask.ts
│   ├── personality.ts       # compact + rich
│   ├── memory.ts
│   ├── kanban.ts
│   ├── channel-mode.ts
│   └── help.ts
│
├── blocks/                  # pure Block Kit builders — (data) => Block[]
│   ├── shared.ts            # divider, section, sectionFields, header, context, escapeMrkdwn, plaintextFallback
│   ├── help.ts
│   ├── personality.ts       # compact + rich character-sheet card
│   ├── memory.ts
│   ├── kanban.ts
│   ├── session.ts
│   ├── approval.ts
│   ├── unfurl.ts
│   └── channel-mode.ts
│
├── home/                    # App Home tab — pure view builder + Bolt registrar
│   ├── view.ts              # buildHomeView(data) => SlackHomeView
│   └── handlers.ts          # registerHomeEvents — app_home_opened + home:refresh
│
├── interactions/
│   └── actions.ts           # block_actions → approval decision routing
│
├── store/                   # JSONL-backed adapter-owned persistence
│   ├── channel-overrides.ts
│   └── thread-state.ts
│
└── __tests__/
```

### Key contracts

| Field | Where | Purpose |
|---|---|---|
| `InboundMessage.botKey` | `@ethosagent/types` | Multi-bot routing — gateway picks the right `AgentLoop` per bot. |
| `InboundMessage.threadId` | `@ethosagent/types` | Thread isolation — gateway lane key includes it when present. |
| `OutboundMessage.threadId` | `@ethosagent/types` | Lets the gateway thread agent replies back into the originating Slack thread. |
| `SlackAdapterConfig.binding` | `./adapter` | Drives `/ethos personality`, `/ethos help`, member-join greeting. |
| `SlackAdapterConfig.storage` | `./adapter` | Required for channel-mode persistence and thread-follow state. |
| `SlackAdapterConfig.memory` | `./adapter` | Wires `/ethos memory show|add` and the App Home memory section. |
| `SlackAdapterConfig.personalityCard` | `./adapter` | Wires `/ethos personality rich`. |
| `SlackAdapterConfig.kanban` | `./adapter` | Wires `/ethos kanban list` + App Home kanban section (team bots only). |
| `SlackAdapterConfig.session` | `./adapter` | Wires the App Home "Recent sessions" section. |
| `SlackAdapterConfig.webUiBaseUrl` | `./adapter` | When set, App Home session rows deep-link to `<base>/sessions/<id>`. |

### Design notes

**Pure Block Kit builders.** Every `blocks/<name>.ts` is `(data) => SlackBlock[]` — no I/O, no Slack-client dependency, no side effects. Trivially unit-testable (`__tests__/blocks.test.ts`) and replaceable for theming. The Slack web client validates block shape at runtime, so the structural `SlackBlock` type in `blocks/shared.ts` is sufficient — no direct `@slack/types` dep.

**Pure slash dispatcher.** `commands/index.ts` exports `dispatch(payload, ctx) => SlashResponse` — a pure function over a structured payload. Bolt registration in `adapter.ts:start()` is the only place that touches Slack; tests exercise `dispatch` directly without a real Slack app.

**Outbound dedup is gateway-only.** Per [ARCHITECTURE.md](../../ARCHITECTURE.md) §V S3, all outbound dedup is centralized in `extensions/gateway/src/dedup.ts`. The Slack adapter does **not** implement adapter-local dedup. If you find any in this tree, it's a bug.

**`auth.test` at startup.** The adapter calls `client.auth.test()` once during `start()` to resolve the bot's own user id (to filter `member_joined_channel` to self-join) and display name (used as the App Home header). Failure is tolerated — the greeting just won't fire and the Home tab falls back to the generic "Slack" label.

**App Home is a pure view builder + a thin registrar.** `home/view.ts` exports `buildHomeView(data) => SlackHomeView`. `home/handlers.ts` exports `registerHomeEvents(app, deps)` mirroring `events/messages.ts`. Reader and publish failures are swallowed so a bad Slack event never crashes Bolt's event loop.

---

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Public barrel — `SlackAdapter`, types, helpers. |
| `src/adapter.ts` | The `PlatformAdapter` implementation. |
| `src/chunking.ts` | `chunkText` + `reflowChunks` (3000-char Slack message limit). |
| `src/config.ts` | Zod schemas for adapter-internal shapes. |
| `src/events/` | Bolt event handlers — message, app_mention, member_joined_channel, link_shared. |
| `src/routing/` | Triage + channel-mode pure decisions. |
| `src/commands/` | Slash subcommands + dispatcher. |
| `src/blocks/` | Block Kit builders. |
| `src/home/` | App Home tab — `buildHomeView` + the `app_home_opened` / `home:refresh` registrar. |
| `src/interactions/` | `block_actions` interaction handlers (approval-card buttons). |
| `src/store/` | JSONL-backed channel overrides + thread state. |
| `src/__tests__/` | Unit tests for all of the above. |
| `package.json` | Workspace package; deps `@slack/bolt` ^3.21, `zod` ^4.3, `@ethosagent/types`. |
