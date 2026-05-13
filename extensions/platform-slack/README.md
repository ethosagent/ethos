# @ethosagent/platform-slack

Slack `PlatformAdapter` — runs in Socket Mode so Ethos can serve Slack workspaces with no public URL.

This README covers everything an operator needs to install the Slack app, configure Ethos, and use the per-channel reply modes and `/ethos` slash commands. If you only want the architectural picture, jump to [Internals](#internals).

---

## At a glance

| Surface | Status |
|---|---|
| Socket Mode (`@slack/bolt` v3.21) | shipped |
| Direct messages, channel mentions, threaded replies | shipped |
| Multi-bot identity (one Slack app per personality / team) | shipped |
| **Thread-isolated session lanes** | shipped (Phase 0) |
| **Per-channel reply mode** (`mention_only` / `thread_follow` / `all`) | shipped (Phase 1) |
| **`/ethos` slash command** with `ask`, `personality`, `memory`, `kanban`, `channel-mode`, `help` subcommands | shipped (Phase 1) |
| **Member-join greeting** announcing the bot's binding + active channel mode | shipped (Phase 1) |
| Block Kit responses for slash commands | shipped (Phase 1) |
| Tool-call approval cards (interactive buttons) | upcoming (Phase 2) |
| **App Home tab** (sessions / kanban / memory / channel-mode dashboard) | shipped (Phase 3) |
| **URL unfurling** for Ethos web UI deep links | shipped (Phase 4) |
| Inbound file handling (images, text, PDFs) | upcoming |

---

## 1 · Slack app setup

You need one Slack app per Ethos bot. The same workspace can host many apps; each app maps 1:1 to a personality or a team coordinator.

### 1.1 Create the app

1. Open the [Slack API dashboard](https://api.slack.com/apps) → **Create New App** → **From an app manifest**.
2. Pick the workspace.
3. Paste the manifest below. Replace `<DISPLAY-NAME>` with what you want users to see (e.g. `Researcher`, `Eng Coordinator`), and `<WEB-UI-DOMAIN>` with the host of your configured `webUiBaseUrl` (see [§9](#9-url-unfurling)) — e.g. `ethos.example.com`.

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
  unfurl_domains:
    - "<WEB-UI-DOMAIN>"
  slash_commands:
    - command: /ethos
      description: "Ethos commands (ask, personality, memory, kanban, channel-mode, help)"
      usage_hint: "ask <prompt>  ·  channel-mode all  ·  help"
      should_escape: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - commands
      - groups:history
      - im:history
      - im:read
      - im:write
      - links:read
      - links:write
      - mpim:history
      - mpim:read
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_home_opened
      - app_mention
      - link_shared
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

> The `commands` block is what makes `/ethos` show up in Slack's command picker. The Socket Mode bit makes the bot dial out to Slack so you don't need a public webhook. The `app_home` block enables the **App Home** tab (see [§8](#8-app-home-tab)); the `app_home_opened` bot event is what lets the adapter publish the tab when a user opens it. The `links:read` / `links:write` scopes plus the `link_shared` bot event power **URL unfurling** (see [§9](#9-url-unfurling)) — and `features.unfurl_domains` is what tells Slack *which* domains to emit `link_shared` for. Without the domain registered, Slack never dispatches the event and unfurling is a silent no-op, so `<WEB-UI-DOMAIN>` must be the bare host of your `webUiBaseUrl` (no scheme, no path; Slack allows at most 5 domains). It's operator-specific, so unlike the rest of the manifest it can't be a shared constant. If you have no web UI deployment yet, drop the `unfurl_domains` block — you can add it on the next manifest edit + reinstall.

> Editing `unfurl_domains` (like any scope or event change) requires re-installing the app to the workspace before it takes effect — see [§7.4](#74-required-scopes--quick-check).

### 1.2 Generate tokens

In the app settings, you need three secrets:

| Token | Where to get it |
|---|---|
| `botToken` (`xoxb-…`) | OAuth & Permissions → **Install to Workspace**, then copy the *Bot User OAuth Token*. |
| `appToken` (`xapp-…`) | Basic Information → **App-Level Tokens** → **Generate Token and Scopes** → add `connections:write` and `authorizations:read`. |
| `signingSecret` | Basic Information → **App Credentials → Signing Secret**. |

### 1.3 Future scopes

These will be required once the corresponding phases land — request them now if you want a single install pass:

| Scope | Phase | Why |
|---|---|---|
| `files:read` | future | Read files Ethos receives (inbound file handling). |
| `reactions:read`, `reactions:write` | future | Reaction-driven actions (👀 / ✅ / 📋). |

`links:read` / `links:write` are already in the manifest in [§1.1](#11-create-the-app) — they power [URL unfurling](#9-url-unfurling).

---

## 2 · Ethos configuration

The Slack adapter is wired through the multi-app config at `~/.ethos/config.yaml`. Each entry is one Slack app:

```yaml
slack.apps.0.botToken: xoxb-…
slack.apps.0.appToken: xapp-…
slack.apps.0.signingSecret: …
slack.apps.0.bind.type: personality       # or 'team'
slack.apps.0.bind.name: researcher        # personality id or team manifest name
# Optional, surfaced in logs and used for the gateway lane key.
# Defaults to a 24-char sha256(botToken) prefix when omitted.
slack.apps.0.id: researcher-app
```

You can declare any number of apps; each binds to exactly one personality or one team coordinator.

### 2.1 Legacy single-bot config

The old scalar form keeps working through a deprecation shim:

```yaml
slackBotToken: xoxb-…
slackAppToken: xapp-…
slackSigningSecret: …
```

Boot synthesizes a one-entry `slack.apps[]` list bound to the active personality. A deprecation warning fires once at startup. Migrate when convenient.

### 2.2 Adapter-owned state

When `storage` is wired (production wiring does this automatically), the adapter persists per-channel mode overrides and "bot has posted in this thread" state under:

```
~/.ethos/slack/<botKey>/
├── channel-overrides.jsonl
└── thread-state.jsonl
```

JSONL append-only — the latest record per `(channel, mode)` wins. Truncating either file is safe; the adapter rebuilds in-memory state from the lines that remain.

---

## 3 · Slash commands

Once `/ethos` is registered in the Slack app manifest, users can invoke it from any channel the bot is in (and from DMs). All responses are ephemeral by default — only the invoker sees them.

| Command | Audience | What it does |
|---|---|---|
| `/ethos ask <prompt>` | in-channel | Submits the prompt to the bot's bound agent loop. The agent's reply arrives via the gateway's normal outbound path (so it follows the channel's thread context and dedup rules). The slash command itself posts a public acknowledgement so other channel members see who asked. |
| `/ethos personality` | ephemeral | Shows the bot's binding (personality or team coordinator). |
| `/ethos memory show` | ephemeral | Last 5 entries from the bound personality's `MEMORY.md`. *(Memory wiring lands in a follow-up; today the command degrades gracefully with "Memory is unavailable for this bot.")* |
| `/ethos memory add <text>` | ephemeral | Appends a memory entry. *(Same wiring caveat as above.)* |
| `/ethos kanban list` | ephemeral | Block Kit list of open kanban tickets. **Team bots only** — personality bots get a clear "this is a team feature" message. *(Kanban wiring lands in a follow-up.)* |
| `/ethos channel-mode show` | ephemeral | Reports the active mode for the current channel and whether it's an override or the app default. |
| `/ethos channel-mode <mode>` | ephemeral | Sets the mode. Valid values: `mention_only`, `thread_follow`, `all`. Persisted to `channel-overrides.jsonl`; survives restart. |
| `/ethos help` | ephemeral | Lists all subcommands with the bot's binding and active channel mode for context. |

Each subcommand returns Block Kit (header + sections + context). The plaintext fallback in the message `text` field carries the same content for notifications and screen-readers.

---

## 4 · Channel modes

A bot in a channel can be in one of three modes. Default is `mention_only`.

| Mode | Bot replies when… |
|---|---|
| `mention_only` *(default)* | DM, OR explicit `@bot` mention. Silent otherwise. |
| `thread_follow` | `mention_only` behaviors PLUS any message in a thread the bot has previously posted in. *Once invited, stay.* |
| `all` | Every message in the channel. For dedicated channels like `#ai-pair`. Use sparingly — the bot will respond to noise too. |

### 4.1 Precedence

Per-channel override (set via `/ethos channel-mode`) > app-level default (currently always `mention_only`) > built-in default (`mention_only`).

DMs always behave as if the channel mode were `all` — there's no useful semantic for "only @mention me in a DM."

### 4.2 Cost note for `all` mode

A bot in `all` mode on a busy channel will respond to every message, costing LLM tokens for messages that probably weren't meant for it. The adapter does **not** enforce limits. Operators get a member-join greeting that announces the active mode; that's the discoverability hook.

---

## 5 · Thread isolation

The Slack adapter routes threaded conversations to their own session lanes:

- Threaded replies set `InboundMessage.threadId = thread_ts` (the parent thread's `ts`). The gateway lane key becomes `slack:<botKey>:<channel>:<thread_ts>`, isolated from every other thread in the channel and from the channel root.
- Channel-root posts leave `threadId` undefined. The lane key stays `slack:<botKey>:<channel>` (the same shape as before this change).

Agent replies are routed back into the same thread automatically: the gateway passes the inbound `threadId` through to the outbound `chat.postMessage`. Top-level posts have no `threadId`, so the agent's reply lands at the channel root.

The threading concept stays inside the Slack adapter — `InboundMessage.threadId` is a generic, opaque routing segment in the platform contract. No sentinel values, no Slack-specific encoding leaks into the gateway or other adapters.

### 5.1 Migration note

Threaded conversations that existed before this change shared the parent channel's session. After upgrade, each thread routes to its own lane on the next message. **This is a one-time history reset for ongoing threaded conversations.** Channel-root conversations are unaffected — their lane key shape is unchanged.

If the reset surprises a user, drop a `/new` to confirm and re-prime — there is no automatic session-key migration.

---

## 6 · The bot joining a channel

When someone adds the bot to a channel, it posts a one-line greeting:

```
👋 I'm bound to the personality `researcher`. This channel is in `mention_only` mode.
Run `/ethos channel-mode` to change it.
```

The greeting fires only when the *bot itself* joins (not for any other user). It uses the `member_joined_channel` event and the `users.profile:read`-equivalent identity from `auth.test`.

If the bot lacks `chat:write` in the new channel context (e.g. private channel without explicit invite), the greeting is silently skipped — the rest of the adapter still works.

---

## 7 · Operator runbook

### 7.1 Add a new bot

1. Create the Slack app per [§1.1](#11-create-the-app); copy tokens per [§1.2](#12-generate-tokens).
2. Add an entry to `~/.ethos/config.yaml`:
   ```yaml
   slack.apps.<n>.botToken: xoxb-…
   slack.apps.<n>.appToken: xapp-…
   slack.apps.<n>.signingSecret: …
   slack.apps.<n>.bind.type: personality
   slack.apps.<n>.bind.name: <personality-id>
   ```
   `<n>` is a unique non-negative integer. Existing entries keep their indices.
3. Restart the gateway (`ethos gateway start`). Boot validates that `bind.name` resolves to a known personality or team and refuses to start otherwise.
4. Install the Slack app to the workspace, invite the bot to the channels you want it in. Each invite triggers the greeting in [§6](#6-the-bot-joining-a-channel).

### 7.2 Change a channel's reply mode

Any user can run `/ethos channel-mode <mode>` from inside the channel. Mode persists to `~/.ethos/slack/<botKey>/channel-overrides.jsonl`. There is **no** UI gate — anyone in the channel can change it. If you need an admin-gate, that's a future-phase concern.

### 7.3 Inspect / clear adapter state

Files live under `~/.ethos/slack/<botKey>/`:

- `channel-overrides.jsonl` — `{ channel, mode, updatedAt }` lines. Latest wins.
- `thread-state.jsonl` — `{ channel, threadTs, firstPostedAt }` lines. One per (channel, thread) the bot has posted in.

Truncate either file to start fresh; the adapter is tolerant of empty/missing files.

### 7.4 Required scopes — quick check

If the bot misbehaves silently, check that the manifest in [§1.1](#11-create-the-app) is the live manifest and re-install. Common symptoms:

| Symptom | Likely missing scope / setting |
|---|---|
| `/ethos` doesn't appear in the slash command picker | `slash_commands.commands.[/ethos]` block missing from manifest, or app needs reinstall after manifest edit |
| Channel messages don't reach the bot | `message.channels` (or `message.groups`) not in `event_subscriptions.bot_events` |
| `member_joined_channel` greeting never fires | event not subscribed, or bot lacks `chat:write` for that channel |
| App Home tab is blank or shows "Sending messages to this app has been turned off" | `app_home.home_tab_enabled` missing from the manifest, or `app_home_opened` not in `event_subscriptions.bot_events` |
| Pasting an Ethos web UI link never unfurls (no error anywhere) | `features.unfurl_domains` missing the host of `webUiBaseUrl`, or `link_shared` not in `event_subscriptions.bot_events`, or `webUiBaseUrl` unset in Ethos config — see [§9](#9-url-unfurling) |
| Block Kit renders but plaintext fallback shows mrkdwn | this is intentional — Slack strips client-side for notifications |

---

## 8 · App Home tab

Clicking the bot's name in Slack opens its **Home** tab — a read-only dashboard rendered by the adapter. It has four sections plus a **Refresh** button:

| Section | Source | Notes |
|---|---|---|
| **Header** | `binding` + `auth.test` | Bot display name, bound personality/team, status. |
| **Recent sessions** | `session` reader | Last few sessions for this bot. Rows deep-link to the Ethos web UI when `webUiBaseUrl` is configured; otherwise they render as plain text. |
| **Active kanban** | `kanban` reader | Recently active tickets. **Team bots only** — hidden entirely for personality-bound bots. |
| **Recent memory updates** | `memory` reader | Last 5 `MEMORY.md` entries for the bound personality. |
| **This bot is in** | `ChannelOverrideStore` | Channels the bot is in with their current channel mode. The **Refresh** button (`action_id: home:refresh`) re-publishes the tab with fresh data. |

The Home tab **degrades gracefully**: the header and "This bot is in" sections are populated from day one (binding + channel state are always wired), while the session / kanban / memory sections show a tasteful empty state until their readers are wired. *(Reader wiring lands in a follow-up, the same as the `/ethos memory` and `/ethos kanban` commands.)*

To enable it, the Slack app manifest needs the `app_home.home_tab_enabled` feature and the `app_home_opened` bot event — both are in the manifest in [§1.1](#11-create-the-app).

---

## 9 · URL unfurling

When someone pastes an Ethos web UI URL into Slack, the adapter unfurls it into a rich Block Kit card — title plus a short summary — instead of leaving a bare link.

| URL pattern | Unfurl shows |
|---|---|
| `/sessions/<id>` | Session id, the personality it ran under, last activity. |
| `/kanban/<ticket>` | Ticket title, status, assignee, parent goal. |
| `/personalities/<id>` | Personality name, description, memory scope. |
| `/memory` | A snippet of recent `MEMORY.md` entries for the bound scope. |

It uses the `link_shared` event and `chat.unfurl`; the manifest in [§1.1](#11-create-the-app) carries the `links:read` / `links:write` scopes and the `link_shared` bot event.

**Slack only emits `link_shared` for domains the app explicitly registers.** The `features.unfurl_domains` entry in the manifest ([§1.1](#11-create-the-app)) must list the host of your `webUiBaseUrl` — if it doesn't, Slack never dispatches the event and the handler never fires, with no error to tell you why. That's why `<WEB-UI-DOMAIN>` is operator-specific and can't be hardcoded in the shared manifest: it has to match wherever *your* Ethos web UI lives.

Registration is by **domain** only — Slack can't filter by path. The adapter is stricter: a URL is only recognized when its origin *and* path prefix match the adapter's configured `webUiBaseUrl` (the `matchEthosUrl` matcher checks both). So for a path-prefixed deployment (e.g. `https://example.com/ethos`), you register the bare domain `example.com` with Slack, and the adapter still rejects any URL under `example.com` that isn't beneath the `/ethos` prefix.

Unfurling is **scoped to the bot's own workspace**. A URL is only recognized when its origin *and* path prefix match the adapter's configured `webUiBaseUrl` — a link to another deployment's web UI is ignored entirely, so one workspace's bot can never unfurl another's session or ticket.

It **degrades gracefully**, the same way the `/ethos` commands and the App Home tab do:

- No `webUiBaseUrl` configured → the adapter can't recognize Ethos URLs, so the `link_shared` handler isn't registered at all.
- A URL type whose lookup reader isn't wired (or whose id doesn't resolve) → that URL is skipped. An unfurl is all-or-nothing per URL: a blank card is worse than no card, so nothing is posted unless there's real data to show. *(Reader wiring lands in a follow-up, the same as the `/ethos memory` and `/ethos kanban` commands.)*

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
│   └── links.ts             # link_shared → matchEthosUrl → chat.unfurl
│
├── routing/
│   ├── triage.ts            # raw event → InboundMessage envelope; channel-mode + threadId
│   └── channel-mode.ts      # pure shouldRespond(inputs) decision
│
├── commands/                # slash command handlers (pure dispatch)
│   ├── index.ts             # parser + dispatcher
│   ├── ask.ts
│   ├── personality.ts
│   ├── memory.ts
│   ├── kanban.ts
│   ├── channel-mode.ts
│   └── help.ts
│
├── blocks/                  # pure Block Kit builders — (data) => Block[]
│   ├── shared.ts            # divider, section, header, context, escapeMrkdwn, plaintextFallback
│   ├── help.ts
│   ├── personality.ts
│   ├── memory.ts
│   ├── kanban.ts
│   ├── session.ts
│   ├── approval.ts
│   ├── unfurl.ts            # link_shared URL unfurl cards
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
| `SlackAdapterConfig.memory` | `./adapter` | Optional — wires `/ethos memory show|add` and the App Home memory section when supplied. |
| `SlackAdapterConfig.kanban` | `./adapter` | Optional — wires `/ethos kanban list` and the App Home kanban section for team bots. |
| `SlackAdapterConfig.session` | `./adapter` | Optional — wires the App Home "Recent sessions" section. |
| `SlackAdapterConfig.webUiBaseUrl` | `./adapter` | Optional — Ethos web UI origin; when set, App Home session rows deep-link to `<base>/sessions/<id>` and `link_shared` URL unfurling is enabled. |
| `SlackAdapterConfig.sessionUnfurl` / `kanbanUnfurl` / `personalityUnfurl` | `./adapter` | Optional lookup-by-id readers — wire the session / kanban / personality URL unfurls. The memory URL unfurl reuses `SlackAdapterConfig.memory`. |

### Why pure Block Kit builders

Every `blocks/<name>.ts` is `(data) => SlackBlock[]`. No I/O, no Slack-client dependency, no side effects. This makes them trivially unit-testable (see `__tests__/blocks.test.ts`) and replaceable for theming later. The Slack web client validates block shape at runtime, so the structural `SlackBlock` type in `blocks/shared.ts` is sufficient — we don't need a direct dep on `@slack/types`.

### Why pure slash dispatcher

`commands/index.ts` exports a pure `dispatch(payload, ctx) => SlashResponse` that takes a structured slash command payload and returns the response shape. The Bolt registration in `adapter.ts:start()` is the only place that touches Slack. Tests exercise the dispatcher directly without standing up a real Slack app.

### Outbound dedup is gateway-only

Per [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §V S3, all outbound dedup is centralized in `extensions/gateway/src/dedup.ts`. The Slack adapter does not implement adapter-local dedup. If you find any in this directory tree, it's a bug.

### `auth.test` at startup

The adapter calls `client.auth.test()` once during `start()` to resolve the bot's own user id (used to filter `member_joined_channel` events for self-join only) and display name (used as the App Home header). Failure is tolerated: the greeting just won't fire, and the Home tab falls back to the generic "Slack" label.

### App Home is a pure view builder + a thin registrar

`home/view.ts` exports a pure `buildHomeView(data) => SlackHomeView` — same `(data) => …` discipline as `blocks/`. `home/handlers.ts` exports `registerHomeEvents(app, deps)`, mirroring `events/messages.ts`: it registers `app_home_opened` and the `home:refresh` action, gathers data from the injected readers, and publishes via `client.views.publish`. Reader failures and publish failures are swallowed so a bad Slack event never crashes Bolt's event loop.

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

---

## Future phases

This README documents Phases 0–4. Still upcoming:

- **Inbound file handling** — accepting images, text, and PDFs that users send the bot. Deferred until the codebase has a multimodal LLM pipeline to feed them into.

When it lands, the manifest in [§1.1](#11-create-the-app) needs the `files:read` scope listed in [§1.3](#13-future-scopes) and the `file_shared` event.
