---
title: "Create a plugin: local entry point"
description: "Write the my-notes entry point with a tool, slash command, data source and health check."
kind: how-to
audience: developer
time: "10 min"
updated: 2026-11-03
---

## Task

Write `src/index.ts` for the local `my-notes` plugin.

## Result

An entry point that registers a search tool, a `/notes` slash command, a data source and a health check.

## Prereqs

- Complete [part 3](./test-and-install.md): the `~/.ethos/plugins/my-notes` directory and `package.json` exist.

## Steps

### Write the plugin entry point

Create `src/index.ts`. This plugin stores project notes in a local SQLite database, exposes slash commands for quick capture, a tool so the agent can search notes during conversation, a data source for dashboard queries, and a health check.

```ts title="src/index.ts"
import Database from '@ethosagent/sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { defineTool, ok, err } from '@ethosagent/plugin-sdk/tool-helpers';

const DB_PATH = join(homedir(), '.ethos', 'plugins', 'my-notes', 'notes.db');

let db: ReturnType<typeof Database> | null = null;

function getDb(): ReturnType<typeof Database> {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  return db;
}

const searchNotesTool = defineTool<{ query: string; limit?: number }>({
  name: 'search_notes',
  description: 'Search project notes by keyword. Returns matching notes with timestamps.',
  toolset: 'notes',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search term to match against note text.' },
      limit: { type: 'number', description: 'Max results (default 10).' },
    },
    required: ['query'],
  },
  async execute({ query, limit }) {
    const d = getDb();
    const cap = Math.min(limit ?? 10, 50);
    const rows = d
      .prepare('SELECT id, text, created_at FROM notes WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?')
      .all(`%${query}%`, cap) as Array<{ id: number; text: string; created_at: string }>;
    if (rows.length === 0) return ok('No notes match that query.');
    const formatted = rows
      .map((r) => `[${r.created_at}] (id:${r.id}) ${r.text}`)
      .join('\n');
    return ok(formatted);
  },
});

export function activate(api: EthosPluginApi): void {
  api.diagnostics.info('my-notes plugin activating', { dbPath: DB_PATH });

  // -- Tool: search_notes (available to the agent during conversation) --
  api.registerTool(searchNotesTool);

  // -- Slash command: /notes add <text> | /notes list --
  api.registerSlashCommand({
    name: 'notes',
    description: 'Manage project notes. Usage: /notes add <text> | /notes list',
    async execute(args) {
      const trimmed = (args ?? '').trim();
      const addMatch = trimmed.match(/^add\s+(.+)$/s);

      if (addMatch) {
        const text = addMatch[1].trim();
        if (!text) return { text: 'Provide text after "add".' };
        const d = getDb();
        const info = d.prepare('INSERT INTO notes (text) VALUES (?)').run(text);
        return { text: `Saved note #${info.lastInsertRowid}.` };
      }

      if (trimmed === 'list' || trimmed === '') {
        const d = getDb();
        const rows = d
          .prepare('SELECT id, text, created_at FROM notes ORDER BY created_at DESC LIMIT 20')
          .all() as Array<{ id: number; text: string; created_at: string }>;
        if (rows.length === 0) return { text: 'No notes yet. Add one with /notes add <text>.' };
        const formatted = rows
          .map((r) => `[${r.created_at}] #${r.id}: ${r.text}`)
          .join('\n');
        return { text: formatted };
      }

      return { text: 'Usage: /notes add <text> | /notes list' };
    },
  });

  // -- Data source: expose the SQLite DB for dashboard queries --
  api.registerDataSource('my-notes', DB_PATH);

  // -- Health check: verify the database is readable --
  api.registerHealthCheck({
    name: 'notes-db',
    description: 'Verify the notes database is accessible and has the expected schema.',
    async run() {
      try {
        const d = getDb();
        const row = d.prepare("SELECT count(*) AS cnt FROM notes").get() as { cnt: number };
        return { status: 'ok', message: `Database OK. ${row.cnt} note(s) stored.` };
      } catch (e) {
        return { status: 'error', message: `Database error: ${(e as Error).message}` };
      }
    },
  });

  api.diagnostics.info('my-notes plugin activated', { tools: ['search_notes'] });
}

export function deactivate(): void {
  if (db) {
    db.close();
    db = null;
  }
}

const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
```

## Verify

If the plugin has a `tsconfig.json` and `typescript` installed, type-check the entry point. Expect no output.

```bash
cd ~/.ethos/plugins/my-notes && pnpm exec tsc --noEmit
```

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module` on import | Dev dependencies not installed. | Run `pnpm add -D typescript @ethosagent/plugin-sdk @ethosagent/types`. |
