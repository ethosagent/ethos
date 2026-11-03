# platform-slack internals

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

**Outbound dedup is gateway-only.** Per [ARCHITECTURE.md](../../../ARCHITECTURE.md) §V S3, all outbound dedup is centralized in `extensions/gateway/src/dedup.ts`. The Slack adapter does **not** implement adapter-local dedup. If you find any in this tree, it's a bug.

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
