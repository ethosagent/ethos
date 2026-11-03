---
title: "Create a plugin"
description: "Build an Ethos plugin: scaffold, package.json, a tool, credentials and OAuth. Later parts cover hooks, UI, testing and local development."
kind: how-to
audience: developer
slug: create-a-plugin
time: "30 min"
updated: 2026-11-03
---

## Task

Build an Ethos [plugin](../../getting-started/glossary.md#plugin) from scratch that registers tools, skills, a personality, monitors, credentials, and a plugin page.

## Result

A working plugin at `~/.ethos/plugins/` with tools in `ethos plugin list`, credentials via `ethos plugin credentials`, and a [personality](../../getting-started/glossary.md#personality) via `ethos personality show`.

## Prereqs

- Node 24+ and pnpm.
- Ethos installed (`~/.ethos/config.yaml` exists).
- TypeScript familiarity.

## Parts

| Part | Covers |
|---|---|
| This page | Steps 1-6: scaffold, `package.json`, a tool, `ToolContext`, credentials, OAuth. |
| [Activate and register features](./create-a-plugin/activate-and-register.md) | Steps 7-14: `activate()`, skill, personality, monitor, UI, hooks, diagnostics, slash commands. |
| [Test, install and local scaffold](./create-a-plugin/test-and-install.md) | Steps 15-17: data source, test, install; start of the local development workflow. |
| [Local entry point](./create-a-plugin/local-dev-entry-point.md) | Local workflow: write the `my-notes` entry point. |
| [Install locally and iterate](./create-a-plugin/local-dev-install-and-iterate.md) | Local workflow: install, test, iterate. |

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

**Required credentials.** Declare a credential as an object with `required: true` (`{ "key": "MY_API_KEY", "label": "My API key", "type": "secret", "required": true }`) and Ethos asks for it before the turn runs, not after your tool fails. When a personality that lists your plugin sends a message and the value is unset, the turn is refused before the model runs and each surface asks for the value outside the conversation:

| Surface | What the user sees |
|---|---|
| CLI chat, TUI, web chat | A masked prompt. The value is stored through `PluginLoader.setCredential` and the message is sent again. |
| Telegram, Slack, other channels | A link to `<webBaseUrl>/plugins?pluginId=<id>&key=<KEY>`, or the CLI command when `webBaseUrl` is unset. A channel never accepts the value as a message. |
| `ethos -z`, `ethos chat -q`, ACP | One line naming `ethos plugin credentials <id> --set <KEY>`. |

The value goes to the plugin's vault only. It never reaches the session transcript, the model or the event stream (pinned by `packages/wiring/src/__tests__/credential-e2e.test.ts`). Delegated, background, cron and MCP-export turns skip the check, and your tool reports its own missing-key error there. The check is `buildCredentialCheck` in `packages/wiring/src/credential-check.ts`.

Browser logins are separate. `browser_fill_credential` reads logins stored with `ethos secrets credential add` under `credentials/<name>/`, which are not plugin credentials. A missing login stays a refusal from that tool and never triggers this prompt.

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

Continue with [part 2](./create-a-plugin/activate-and-register.md).

## Verify

If your plugin has a `tsconfig.json` and `typescript` installed, type-check the scaffold. Expect no output.

```bash
pnpm exec tsc --noEmit
```

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `pluginContractMajor mismatch` | Declared major differs from host. | Set `pluginContractMajor: 2`. |
| OAuth callback fails | `redirectUri` mismatch. | Set `host.baseUrl` in config. |

## See also

- [Publish a plugin](./publish-a-plugin.md)
- [Plugin SDK reference](../reference/plugin-sdk.md)
- [Tool interface](../reference/tool-interface.md)
- [Hook execution models](../explanation/hook-execution-models.md)
