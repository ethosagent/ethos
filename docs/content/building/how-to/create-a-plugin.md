---
title: "Create a plugin"
description: "Build an Ethos plugin from scratch — tools, skills, personalities, monitors, credentials, OAuth, UI, hooks, filters, evaluators, and diagnostics."
kind: how-to
audience: developer
slug: create-a-plugin
time: "30 min"
updated: 2026-06-09
---

## Task

Build an Ethos [plugin](../../getting-started/glossary.md#plugin) from scratch that registers tools, skills, a personality, monitors, credentials, and a plugin page.

## Result

A working plugin at `~/.ethos/plugins/` with tools in `ethos plugin list`, credentials via `ethos plugin credentials`, and a [personality](../../getting-started/glossary.md#personality) via `ethos personality show`.

## Prereqs

- Node 24+ and pnpm.
- Ethos installed (`~/.ethos/config.yaml` exists).
- TypeScript familiarity.

## Steps

### 1. Clone the scaffold

```bash
git clone https://github.com/ethosagent/ethos-tools-scaffold my-plugin
cd my-plugin && pnpm install
```

The scaffold provides `src/index.ts`, `src/tools/`, `src/filters/`, `src/monitors/`, `src/skills/`, and `src/__tests__/`.

### 2. Configure package.json

The loader rejects plugins whose `pluginContractMajor` does not match the host (currently `2`).

```json
{
  "name": "@yourscope/ethos-plugin-myplugin",
  "type": "module",
  "main": "./dist/index.js",
  "ethos": {
    "type": "plugin", "id": "my-plugin", "pluginContractMajor": 2,
    "skills_dir": "src/skills", "credentials": ["MY_API_KEY"], "permissions": ["network"]
  }
}
```

| Field | Req | Description |
|---|---|---|
| `type` | yes | `"plugin"` |
| `id` | yes | Unique id — namespaces tools, hooks, credentials. |
| `pluginContractMajor` | yes | Must match host (`2`). |
| `skills_dir` | no | Path to [skill](../../getting-started/glossary.md#skill) files. |
| `credentials` | no | Secret keys the plugin needs. |
| `permissions` | no | `network`, `filesystem`, `shell`. |

### 3. Write a tool

Use `defineTool` from `@ethosagent/plugin-sdk/tool-helpers`. Return `ok()` on success, `err()` on failure.

```ts title="src/tools/lookup.ts"
import { defineTool, ok, err } from '@ethosagent/plugin-sdk/tool-helpers';

export const lookupTool = defineTool<{ ticker: string }>({
  name: 'stock_lookup',
  description: 'Look up a stock price by ticker symbol.',
  toolset: 'finance',
  schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  async execute({ ticker }, ctx) {
    if (!ticker) return err('Ticker is required', 'input_invalid');
    const res = await ctx.scopedFetch?.(`https://api.example.com/quote/${ticker}`);
    if (!res?.ok) return err('API request failed');
    return ok(`${ticker}: $${(await res.json()).price}`);
  },
});
```

Optional [tool](../../getting-started/glossary.md#tool) flags: `requiresApproval`, `returnDirect`, `cache`, `outputSchema`, `strict`, `outputIsUntrusted`, `alwaysInclude`. See [Tool interface](../reference/tool-interface.md).

### 4. Use ToolContext

Key `ctx` fields: `scopedFetch` (HTTP through network policy), `emit` (progress; set `audience: 'user'` for user-visible), `setContext`/`getContext` (per-turn state), `kvStore` (persistent KV), `storage` (scoped FS), `abortSignal`, `llm`.

### 5. Add credentials

Close over `api` so `isAvailable` and `execute` can access secrets.

```ts title="src/tools/authed-tool.ts"
export function createAuthedTool(api: EthosPluginApi) {
  return defineTool<{ query: string }>({
    name: 'authed_search', description: 'Search with an API key.', toolset: 'search',
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    isAvailable: () => api.hasSecret('MY_API_KEY'),
    async execute({ query }) {
      const key = await api.getSecret('MY_API_KEY');
      if (!key) return err('API key not configured', 'not_available');
      return ok(`Results for: ${query}`);
    },
  });
}
```

Credential methods: `hasSecret(key)` (sync), `getSecret(key)`, `setSecret(key, value)` (atomic), `onCredentialUpdate(handler)`.

### 6. Add OAuth (optional)

```ts
api.registerOAuth({
  provider: 'github', buttonLabel: 'Connect GitHub',
  buildAuthUrl: ({ redirectUri, state }) =>
    `https://github.com/login/oauth/authorize?client_id=XXX&redirect_uri=${redirectUri}&state=${state}`,
  async onCallback({ code, redirectUri }) {
    await api.setSecret('GITHUB_TOKEN', await exchangeCode(code, redirectUri));
  },
});
```

The host drives the redirect. `onCallback` fires after authorization.

### 7. Write activate() and deactivate()

```ts title="src/index.ts"
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { lookupTool } from './tools/lookup';
import { createAuthedTool } from './tools/authed-tool';

const unsubs: Array<() => void> = [];

export function activate(api: EthosPluginApi): void {
  api.registerTool(lookupTool);
  api.registerTool(createAuthedTool(api));
  // registerMonitor, registerVoidHook, registerToolFilter, registerSlashCommand, registerDataSource, etc. — shown in later steps
  unsubs.push(api.on('price_alert', () => {}));
}

export function deactivate(): void {
  for (const fn of unsubs) fn();
}

const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
```

`PluginApiImpl.cleanup()` removes tools, [hooks](../../getting-started/glossary.md#hook), filters, evaluators, routes, and monitors automatically. Use `deactivate` for external resources and event-bus subscriptions only.

### 8. Write a skill

Drop a `SKILL.md` in a subdirectory of `skills_dir`. The `required_tools` field gates visibility per personality.

```markdown title="src/skills/analyze-portfolio/SKILL.md"
---
name: analyze-portfolio
description: Analyze a stock portfolio using the finance toolset.
tags: [finance, analysis]
required_tools: [stock_lookup]
---

1. Ask the user for their ticker list.
2. Call `stock_lookup` for each ticker.
3. Summarize total value and top/bottom performers.
```

### 9. Register a personality

Write `SOUL.md` to disk first, then register the config.

```ts
api.registerPersonality({
  id: 'finance-analyst', name: 'Finance Analyst',
  description: 'Financial analysis personality.', model: 'claude-sonnet-4-20250514',
  toolset: ['stock_lookup', 'authed_search', 'memory_read', 'memory_write'],
  soulPath: '~/.ethos/personalities/finance-analyst/SOUL.md',
});
```

### 10. Add a monitor

Guard the loop with `ctx.signal.aborted`. The monitor runs in the background until stopped.

```ts title="src/monitors/price.ts"
import type { PluginMonitorDef } from '@ethosagent/plugin-sdk';

export const priceMonitor: PluginMonitorDef = {
  name: 'price_watch',
  async run(params, ctx) {
    while (!ctx.signal.aborted) {
      const price = await fetchPrice(params.ticker as string);
      if (price > Number(params.threshold ?? 0))
        await ctx.notify({ sessionKey: params.sessionKey as string,
          message: `${params.ticker} hit $${price}` });
      await new Promise((r) => setTimeout(r, 60_000));
    }
  },
};
```

Start/stop: `api.startMonitor('price_watch', { ticker, threshold, sessionKey })`, `api.stopMonitor('price_watch')`.

### 11. Add plugin UI

```ts
api.registerPluginPage({
  title: 'Finance Dashboard', icon: 'chart-line', showInSidebar: true,
  sections: [
    { type: 'metric', toolName: 'stock_lookup', label: 'Price', valueField: 'price', unit: 'USD' },
    { type: 'notification-feed', label: 'Alerts', maxItems: 20 },
  ],
});
api.registerRenderer({ type: 'stock-card', template: 'card' });
```

Section types: `tool-output`, `data-table`, `chart` (line/bar/candlestick), `metric`, `notification-feed`, `custom` (via `bundleExport`).

### 12. Add hooks, filters, evaluators

```ts
api.registerVoidHook('turn_end', async (p) => { api.diagnostics.metric('turn_ms', p.durationMs); });
api.registerModifyingHook('before_completion', async () => ({ systemPromptSuffix: '\nCite sources.' }));
api.registerToolFilter({ toolName: 'stock_lookup', async before(args) { return null; } });
api.registerEvaluator({
  name: 'citation-check', shouldRun: (p) => p.text.length > 100,
  async evaluate(p) { return { pass: /https?:\/\//.test(p.text) }; },
});
api.registerRoute({ method: 'POST', path: '/webhook', handler: async () => ({ body: { ok: true } }) });
api.emit('ready', { id: api.pluginId });
```

Void hooks run in parallel. Modifying hooks run sequentially and amend the prompt. Tool filters return `null` to allow or `ToolResult` to block. See [Hook execution models](../explanation/hook-execution-models.md).

### 13. Add diagnostics

```ts
api.diagnostics.info('Loaded', { version: '0.1.0' });
api.diagnostics.metric('tools_registered', 2);

api.registerHealthCheck({
  name: 'api-connectivity',
  description: 'Verify upstream API is reachable.',
  async run() {
    const r = await fetch('https://api.example.com/health');
    return r.ok ? { status: 'ok', message: 'Up' } : { status: 'error', message: `HTTP ${r.status}` };
  },
});
```

`ethos doctor my-plugin` runs all registered health checks.

### 14. Register slash commands (optional)

Use `api.registerSlashCommand()` to register custom slash commands that appear in `/help` and in platform command menus (Telegram, Discord).

```ts
api.registerSlashCommand({
  name: 'portfolio',
  description: 'Show your current portfolio summary.',
  async execute(args, ctx) {
    return { text: 'Portfolio: ...' };
  },
});
```

See [Register plugin slash commands](./register-plugin-commands.md) for the full walkthrough.

### 15. Register a data source (optional)

Use `api.registerDataSource()` to expose a SQLite database for read-only dashboard queries.

```ts
api.registerDataSource({
  name: 'finance-history',
  description: 'Historical trade data.',
  dbPath: '~/.ethos/plugins/my-plugin/trades.db',
});
```

See [Register a plugin data source](./register-plugin-data-source.md) for the full walkthrough.

### 16. Test

Instantiate `PluginApiImpl` with real registries from `@ethosagent/core`, call `activate(api)`, then assert tools are registered:

```ts title="src/__tests__/activate.test.ts"
const tools = new DefaultToolRegistry();
const api = new PluginApiImpl('my-plugin', {
  tools, hooks: new DefaultHookRegistry(), injectors: [],
  injectorPluginIds: new Map(), personalities: new DefaultPersonalityRegistry(),
  llmProviders: new DefaultLLMProviderRegistry(),
  memoryProviders: new DefaultMemoryProviderRegistry(),
  filters: [], evaluators: [], routes: [],
});
activate(api);
assert(tools.get('stock_lookup'));
```

Use `mockTool` and `createTestRuntime` from `@ethosagent/plugin-sdk/testing` for end-to-end tests.

### 17. Install and activate

```bash
pnpm build && ethos plugin install . && ethos plugin credentials my-plugin
```

Add tools to the personality's `toolset.yaml`: `stock_lookup`, `authed_search`.

---

## Local development workflow

Custom tools for your agent, slash commands for your workflow, data sources that feed dashboards — all from one package. If the scaffold-and-publish path above feels heavyweight for experimentation, this section shows the faster loop: create a plugin directory, write code, install locally, test, iterate.

### Scaffold a plugin directory

Create the plugin directory and initialize it:

```bash
mkdir -p ~/.ethos/plugins/my-notes/src
cd ~/.ethos/plugins/my-notes
pnpm init
pnpm add -D typescript @ethosagent/plugin-sdk @ethosagent/types
pnpm add better-sqlite3
pnpm add -D @types/better-sqlite3
```

Edit `package.json` to include the `ethos` block. The `pluginContractMajor` must be `2` — the loader rejects mismatches.

```json
{
  "name": "ethos-plugin-my-notes",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "ethos": {
    "type": "plugin",
    "id": "my-notes",
    "pluginContractMajor": 2
  }
}
```

The plugin id must be unique across all installed plugins.

The resulting directory tree:

```
~/.ethos/plugins/my-notes/
├── package.json
├── node_modules/
└── src/
    └── index.ts
```

### Write the plugin entry point

Create `src/index.ts`. This plugin stores project notes in a local SQLite database, exposes slash commands for quick capture, a tool so the agent can search notes during conversation, a data source for dashboard queries, and a health check.

```ts title="src/index.ts"
import Database from 'better-sqlite3';
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

### Install locally

Install the plugin by pointing `ethos` at the directory:

```bash
ethos plugin install --path ~/.ethos/plugins/my-notes
```

This creates a symlink so the host loads your source directly. Changes take effect on restart — no `npm publish` needed.

### Test the plugin

Restart ethos to pick up the new plugin:

```bash
ethos restart
```

Verify registration:

```bash
ethos plugin list          # should show my-notes with 1 tool
ethos doctor my-notes      # should pass the notes-db health check
```

Try the slash commands:

```bash
/notes add "Set up CI for the billing service"
/notes add "Review the auth token rotation PR"
/notes list
```

Start a conversation and confirm the agent can use `search_notes`:

```
You: What notes do I have about CI?
```

The agent calls `search_notes` with `{ "query": "CI" }` and returns matching notes.

### Iterate

Edit `src/index.ts`, restart ethos, test. Plugins reload on restart.

No build step is needed during development if your `package.json` points `main` at `./src/index.ts` — `tsx` handles TypeScript directly. For production builds, add a build script using `tsup`:

```json
{
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts"
  }
}
```

Then update `main` to `./dist/index.js` before publishing.

## Verify

```bash
ethos plugin list              # shows plugin id and tool count
ethos personality show finance-analyst
ethos doctor my-plugin         # runs health checks, reports monitor status
```

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `pluginContractMajor mismatch` | Declared major differs from host. | Set `pluginContractMajor: 2`. |
| Tool not visible to LLM | Missing from `toolset.yaml`. | Add the tool name. |
| `No credential storage` | Plugin not registered. | Run `ethos plugin install .`. |
| Monitor crashes silently | Missing `ctx.signal.aborted` guard. | Check signal each iteration. |
| OAuth callback fails | `redirectUri` mismatch. | Set `host.baseUrl` in config. |
| Health check missing | Registered after `activate` returns. | Register inside `activate`. |

## See also

- [Publish a plugin](./publish-a-plugin.md)
- [Plugin SDK reference](../reference/plugin-sdk.md)
- [Tool interface](../reference/tool-interface.md)
- [Hook execution models](../explanation/hook-execution-models.md)
