# Mission Control — Ethos Dashboard Template

This is a starting point. Fork it.

A minimal Next.js 15 app that demonstrates the `@ethosagent/sdk` against a
running Ethos server. Three panels — sessions, chat, and side tools — wired
to the Ethos RPC and SSE APIs.

## Prerequisites

- Node 24+
- A running Ethos server (`pnpm dev` from the monorepo root, or `ethos serve`)
- A minted API key (see the Ethos docs for `ethos apikey create`)

## Quick start

```bash
cp .env.example .env.local
# Edit .env.local — fill in your API key
pnpm dev
```

Opens on [http://localhost:3001](http://localhost:3001).

## Panels

| Panel | What it does |
|-------|-------------|
| **Sessions** (left) | List, create, and delete sessions. Click to activate. |
| **Chat** (center) | Send messages and stream responses via SSE. Shows tool events inline. |
| **Side** (right) | Pick a personality from a dropdown. View MEMORY.md and USER.md content. |

## Structure

```
src/
  app/layout.tsx       Root layout with global styles
  app/page.tsx         Three-panel grid
  lib/ethos.ts         EthosClient singleton
  components/
    SessionList.tsx    Left panel
    ChatPanel.tsx      Center panel
    SidePanel.tsx      Right panel
```

## License

Same as the parent monorepo.
