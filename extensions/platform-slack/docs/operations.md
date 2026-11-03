# platform-slack behaviour and operations

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

When in doubt, the live manifest is the source of truth — open the app's **App Manifest** tab in the Slack dashboard and compare to [Step 1](setup.md#step-1--create-the-slack-app).

---

## File Attachments

The adapter ingests files from Slack `file_share` messages. Files are downloaded using the bot token and cached locally.

### Required scope

`files:read` -- the bot token must have this scope to download files from `url_private_download`. The manifest in [Step 1](setup.md#step-1--create-the-slack-app) includes it. If you installed your app from an older manifest that omits it, add the scope under **OAuth & Permissions > Bot Token Scopes** and reinstall to the workspace. Without `files:read`, Slack serves an HTML login page in place of the file bytes; the adapter caches the HTML and the agent reports the attachment as not a valid image/PDF.

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

`reactions:write` -- the bot token must have this scope to set or clear the reaction. The manifest in [Step 1](setup.md#step-1--create-the-slack-app) includes it. If you installed your app from an older manifest that omits it, add the scope under **OAuth & Permissions > Bot Token Scopes** and reinstall to the workspace. Without the scope the reaction calls fail silently and the rest of the bot continues to work — you just don't get the receipt cue.

---

