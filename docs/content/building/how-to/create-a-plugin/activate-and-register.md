---
title: "Create a plugin: activate and register features"
description: "Wire activate and deactivate, then add skills, a personality, a monitor, UI, hooks, diagnostics and slash commands."
kind: how-to
audience: developer
time: "10 min"
updated: 2026-11-03
---

## Task

Write `activate()` and `deactivate()` and register a skill, personality, monitor, plugin page, hooks, diagnostics and slash commands.

## Result

A plugin entry point that registers every extension point and cleans up on unload.

## Prereqs

- Complete [part 1](../create-a-plugin.md): scaffold, `package.json`, a tool and credentials.

## Steps

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

`PluginApiImpl.cleanup()` removes tools, [hooks](../../../getting-started/glossary.md#hook), filters, evaluators, routes, and monitors automatically. Use `deactivate` for external resources and event-bus subscriptions only.

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
  description: 'Financial analysis personality.', model: 'claude-sonnet-5',
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

Void hooks run in parallel. Modifying hooks run sequentially and amend the prompt. Tool filters return `null` to allow or `ToolResult` to block. See [Hook execution models](../../explanation/hook-execution-models.md).

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

See [Register plugin slash commands](../register-plugin-commands.md) for the full walkthrough.

## Verify

Rebuild and list the plugin. Expect `my-plugin` in the output with its registered tools.

```bash
pnpm build && ethos plugin list
```

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| Monitor crashes silently | Missing `ctx.signal.aborted` guard. | Check signal each iteration. |
| Health check missing | Registered after `activate` returns. | Register inside `activate`. |
