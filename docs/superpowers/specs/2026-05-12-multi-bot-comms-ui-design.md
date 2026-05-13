# Multi-Bot Communications UI — Design Spec

**Date:** 2026-05-12  
**Worktree:** multi-bot-routing  
**Status:** Approved

## Problem

The existing Communications page supports one Telegram bot and one Slack app via legacy scalar config keys (`telegramToken`, `slackBotToken`, etc.). The multi-bot-routing backend (Phases 0–4) added list-shape config (`telegram.bots[]`, `slack.apps[]`) with per-bot `bind: {type, name}` personality/team assignment. The web UI was never updated to match.

## Goal

Let operators add, view, and remove multiple Telegram bots and Slack apps through the web UI, each bound to a personality or team. Discord and Email remain single-bot (unchanged).

## Architecture

Three layers change. Everything else is untouched.

### 1. `packages/web-contracts/src/schemas.ts`

New Zod schemas:

```ts
BotBindingSchema = z.object({ type: z.enum(['personality', 'team']), name: z.string() })
TelegramBotEntrySchema = z.object({ botKey: z.string(), tokenConfigured: z.boolean(), bind: BotBindingSchema })
SlackAppEntrySchema = z.object({ botKey: z.string(), botTokenConfigured: z.boolean(), appTokenConfigured: z.boolean(), signingSecretConfigured: z.boolean(), bind: BotBindingSchema })
```

Tokens are never echoed; only `configured: boolean` flags cross the wire (same rule as today).

### 2. `apps/web-api/src/repositories/platforms.repository.ts`

New methods alongside the existing flat-key methods:

- `listTelegramBots()` — reads `telegram.bots[n].*` from config passthrough, returns `TelegramBotEntry[]`
- `addTelegramBot(token, bind)` — appends a new entry at index N, writes flat keys `telegram.bots.N.token`, `telegram.bots.N.bind.type`, `telegram.bots.N.bind.name`
- `removeTelegramBot(botKey)` — removes the entry matching `botKey`, rewrites indices
- Same three for Slack (`listSlackApps`, `addSlackApp`, `removeSlackApp`)

Config reads use the existing `ConfigRepository.read()`. Writes use `ConfigRepository.update({ passthrough })`.

### 3. `apps/web-api/src/rpc/platforms.ts`

Six new procedures under the existing `platformsRouter`:

```
bots.telegram.list   → TelegramBotEntry[]
bots.telegram.add    → TelegramBotEntry   (input: token, bind)
bots.telegram.remove → { ok: true }       (input: botKey)
bots.slack.list      → SlackAppEntry[]
bots.slack.add       → SlackAppEntry      (input: botToken, appToken, signingSecret, bind)
bots.slack.remove    → { ok: true }       (input: botKey)
```

Input/output types added to `web-contracts` and picked up by the oRPC schema registry in `context.ts`.

### 4. `apps/web/src/pages/Communications.tsx`

Telegram and Slack panels are rewritten. Discord and Email panels are untouched.

**Bot list table** (per platform): columns — `Bot ID`, `Binding` (personality or team badge), token status dot, Remove button.

**Add bot inline form** (expands below the table on "Add bot" click):
- Telegram: `Bot token` (password input)
- Slack: `Bot token`, `App token`, `Signing secret`
- `Bind to` segmented control: `Personality | Team`
- Dropdown populated from `rpc.personalities.list()` (personality mode) or `rpc.kanban.list()` (team mode)
- Save / Cancel

Both dropdowns load once when the form opens. Saving invalidates the bot list query and collapses the form.

## Data flow

```
UI Add form
  → rpc.platforms.bots.telegram.add({ token, bind })
  → PlatformsRepository.addTelegramBot()
  → ConfigRepository.update({ passthrough: { "telegram.bots.N.token": "...", ... } })
  → config.yaml updated on disk

UI list on load
  → rpc.platforms.bots.telegram.list()
  → PlatformsRepository.listTelegramBots()
  → ConfigRepository.read() → scan passthrough keys matching telegram.bots.*
  → returns [{ botKey, tokenConfigured: true, bind }]
```

## Out of scope

- Editing an existing bot's token or binding (remove + re-add)
- Discord multi-bot (Discord doesn't support `botKey` in multi-bot deployments per the existing CLAUDE.md)
- Email multi-account
