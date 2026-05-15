---
title: "Add a new panel to Mission Control"
description: "Create a React component that calls Ethos RPCs, then wire it into the Mission Control grid layout."
kind: how-to
audience: developer
slug: add-a-panel
time: "10 min"
updated: 2026-05-13
---

## Task

Add a new panel to the Mission Control dashboard — a React component that fetches data from Ethos via the SDK's typed RPC client and renders it in the existing grid layout.

## Result

A fourth column (or replacement panel) appears in the dashboard, populated with live data from Ethos.

## Prereqs

- The example Mission Control running locally (see [Build your first Mission Control](../tutorials/first-mission-control.md)).
- Familiarity with React and Next.js.

## Steps

### 1. Create the component

Create a new file in `src/components/`. This example builds a `ToolsPanel` that lists recent tool executions from session history:

```typescript
// src/components/ToolsPanel.tsx
'use client';

import { useEffect, useState } from 'react';
import { ethos } from '@/lib/ethos';

interface ToolEvent {
  name: string;
  ok: boolean;
  timestamp: string;
}

export function ToolsPanel({ sessionId }: { sessionId: string | null }) {
  const [tools, setTools] = useState<ToolEvent[]>([]);

  useEffect(() => {
    if (!sessionId) return;

    const load = async () => {
      const res = await ethos.rpc.sessions.get({ id: sessionId });
      const toolMessages = res.messages
        .filter((m) => m.role === 'tool_result')
        .map((m) => ({
          name: m.toolName ?? 'unknown',
          ok: !m.content.startsWith('Error'),
          timestamp: m.timestamp,
        }));
      setTools(toolMessages);
    };

    void load();
  }, [sessionId]);

  return (
    <div className="flex flex-col border-l border-gray-200 p-3 dark:border-gray-800">
      <h2 className="mb-2 text-sm font-semibold">Tool History</h2>
      {tools.length === 0 && (
        <p className="text-xs text-gray-500">No tool calls yet.</p>
      )}
      {tools.map((t, i) => (
        <div key={i} className="mb-1 rounded bg-gray-50 px-2 py-1 text-xs dark:bg-gray-900">
          <span className={t.ok ? 'text-green-600' : 'text-red-500'}>{t.ok ? 'OK' : 'ERR'}</span>
          {' '}{t.name}
        </div>
      ))}
    </div>
  );
}
```

Key points:

- Import `ethos` from `@/lib/ethos` — the singleton `EthosClient`.
- Call any RPC method on `ethos.rpc`. TypeScript autocomplete covers every namespace and input shape.
- Mark the file `'use client'` — the SDK uses browser `fetch` and React hooks.

### 2. Wire RPC calls

Every RPC namespace is available on `ethos.rpc`:

```typescript
// Sessions
const sessions = await ethos.rpc.sessions.list({ limit: 50 });

// Personalities
const { personalities } = await ethos.rpc.personalities.list();

// Memory
const { files } = await ethos.rpc.memory.list();

// Config
const config = await ethos.rpc.config.get();
```

All methods are fully typed. Passing invalid input fails at compile time.

### 3. Add to the grid layout

Open `src/app/page.tsx`. The layout is a CSS Grid:

```typescript
<div className="grid h-full grid-cols-[250px_1fr_300px]">
  <SessionList ... />
  <ChatPanel ... />
  <SidePanel ... />
</div>
```

Add the new panel and adjust the grid template:

```typescript
import { ToolsPanel } from '@/components/ToolsPanel';

// ...

<div className="grid h-full grid-cols-[250px_1fr_300px_250px]">
  <SessionList activeSessionId={activeSessionId} onSelectSession={setActiveSessionId} />
  <ChatPanel
    sessionId={activeSessionId}
    personalityId={activePersonalityId}
    onSessionCreated={setActiveSessionId}
  />
  <SidePanel personalityId={activePersonalityId} onPersonalityChange={setActivePersonalityId} />
  <ToolsPanel sessionId={activeSessionId} />
</div>
```

The `grid-cols` value gains a fourth track (`250px`). Adjust widths to fit your screen.

### 4. Pass shared state

The panels share state through React `useState` in `page.tsx`. If your new panel needs data from another panel (like the active session or personality), add it as a prop:

```typescript
const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
const [activePersonalityId, setActivePersonalityId] = useState<string | null>(null);
```

For more complex state sharing — multiple panels updating the same data — lift the state to `page.tsx` or introduce a context provider.

## Verify

Save the file and reload the dashboard. The new panel appears in the grid; the RPC call's data renders inside it. Select a different session — the panel updates, confirming the prop is wired. The browser Network tab shows one `POST /rpc/...` per load.

## Alternatives

- **Replace an existing panel** — swap `SidePanel` for your component instead of adding a fourth column.
- **Tabbed layout** — render multiple components in the same grid cell with a tab bar, switching between them.
- **Modal overlay** — keep the three-panel layout and open your component in a dialog triggered by a button.
