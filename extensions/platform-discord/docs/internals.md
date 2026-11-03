# platform-discord internals

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

**Outbound dedup is gateway-only.** Per [ARCHITECTURE.md](../../../ARCHITECTURE.md) §V S3, all outbound dedup is centralized in `extensions/gateway/src/dedup.ts`. The Discord adapter does **not** implement adapter-local dedup. If you find any in this tree, it is a bug.

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
