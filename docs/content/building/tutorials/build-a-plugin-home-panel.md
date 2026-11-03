---
title: "Build a plugin Home panel"
description: "Add a React Home panel to an existing Ethos plugin — manifest changes, panel export, PluginPanelProps, OAuth status, direct tool calls, design tokens."
kind: tutorial
audience: developer
slug: build-a-plugin-home-panel
time: "20 min"
updated: 2026-11-03
---

Every [plugin](../../getting-started/glossary.md#plugin) you install into Ethos gets two drawer surfaces on the Plugins page — one the framework owns and one you own. The **Settings** drawer is automatic: the host reads your credential schema from `package.json` and renders masked inputs, plain inputs, and OAuth buttons with zero code from you. The **Home** panel is yours to build: a full React canvas where you display live data, present connection status, surface reconnect flows, or build whatever UI makes your plugin useful without an LLM turn. Think of it like Slack's App Home — the framework provides the container and the props; you decide what fills it.

In 20 minutes you will extend a working Zerodha broker plugin with a Home panel that shows account connection status, surfaces an OAuth reconnect button, and calls a plugin tool directly to display current holdings.

## Goal

By the end, you have:

- `hasHomePanel: true` declared in the plugin manifest, with a credential schema for API key, secret, and OAuth access token.
- A `./panel` export wired in `package.json` exports and built by a separate `tsup` entry.
- A `src/panel.tsx` React component implementing `PluginPanelProps` that renders credential status, an OAuth reconnect button, and a live holdings list fetched by calling `zerodha_holdings` directly.
- The panel loading in the Ethos desktop app's Plugins page and hot-reloading when `dist/panel.js` changes on disk.

## Prereqs

- A published or locally installed Zerodha plugin (or any plugin with at least one [tool](../../getting-started/glossary.md#tool) registered). If you haven't shipped a plugin yet, complete [Publish a plugin](../how-to/publish-a-plugin.md) first — this tutorial extends that work.
- The Ethos desktop app running locally (or the web app). The panel renders in the app's Plugins drawer; neither the CLI nor messaging platforms render Home panels.
- Node 24+ and pnpm. `tsup` installed as a dev dependency in the plugin package.
- Basic familiarity with React hooks (`useState`, `useEffect`).

## Parts

| Part | Covers |
|---|---|
| 1. Build a plugin Home panel (this page) | Steps 1-3: Declare the credential schema, Declare the Home panel in the manifest, Add the panel export and update the build config |
| [2. Write the panel and the OAuth button](build-a-plugin-home-panel-2-panel-and-oauth.md) | Steps 4-6: Write `src/panel.tsx` — skeleton, Display credentials and OAuth status, Add an OAuth reconnect button |
| [3. Tool calls, design tokens, charts](build-a-plugin-home-panel-3-tool-calls-tokens-chart.md) | Steps 7-9: Call a plugin tool directly from the panel, Use design tokens, (Optional) Add a third-party chart library |
| [4. Build and verify in the desktop app](build-a-plugin-home-panel-4-build-and-verify.md) | Step 10: Build and verify in the desktop app |

## 1. Declare the credential schema

Open your plugin's `package.json`. The `ethos` field declares everything the host needs to render the Settings drawer and know that a Home panel exists. Add the `credentials` array before you add `hasHomePanel` — the credentials are what the Home panel reads and reacts to.

```json
{
  "name": "tools-india-broker-zerodha",
  "version": "1.0.0",
  "type": "module",
  "ethos": {
    "type": "plugin",
    "id": "tools-india-broker-zerodha",
    "pluginContractMajor": 2,
    "credentials": [
      {
        "ref": "brokers/zerodha/apiKey",
        "label": "API Key",
        "kind": "secret"
      },
      {
        "ref": "brokers/zerodha/apiSecret",
        "label": "API Secret",
        "kind": "secret"
      },
      {
        "ref": "brokers/zerodha/accessToken",
        "label": "Access Token",
        "kind": "oauth",
        "oauthRef": "zerodha"
      }
    ]
  }
}
```

The three `kind` values determine how the Settings drawer renders each credential:

| `kind` | Settings drawer renders | Stored in |
|---|---|---|
| `secret` | Masked input, value hidden after save | Secrets store |
| `text` | Plain input, value visible | Secrets store |
| `oauth` | Status badge + Auth button; triggers OAuth flow | Secrets store (token value) |

The `oauthRef` on the `oauth` credential must match the string you pass to `api.registerOAuth()` in your plugin's `activate()` function. The framework uses this to call the right OAuth config when the user taps the Auth button.

Your `activate()` function in `src/index.ts` already calls `api.registerOAuth('zerodha', { ... })` — nothing changes there. The credential schema is pure metadata the host reads from `package.json` at plugin load time.

## 2. Declare the Home panel in the manifest

Add `hasHomePanel: true` to the `ethos` field:

```json
{
  "ethos": {
    "type": "plugin",
    "id": "tools-india-broker-zerodha",
    "pluginContractMajor": 2,
    "hasHomePanel": true,
    "credentials": [...]
  }
}
```

`hasHomePanel: true` signals to the host that a `./panel` export exists in the package and should be loaded as a lazy React component. Without this flag, the host will not attempt to load `./panel` even if the file exists, and the Plugins drawer will show no Home tab.

## 3. Add the panel export and update the build config

### 3a. Add the `./panel` export to `package.json`

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./panel": {
      "import": "./dist/panel.js"
    }
  },
  "peerDependencies": {
    "@ethosagent/plugin-sdk": ">=0.4.3",
    "@ethosagent/types": ">=0.4.3",
    "@ethosagent/ui-components": ">=0.x"
  }
}
```

`@ethosagent/ui-components` is a peer dependency, not a regular dependency. The host provides it, which prevents a duplicate React instance and keeps your bundle small. If you ship it as a regular `dependency`, you get two copies of React in the same page — hooks will break.

### 3b. Update `tsup.config.ts` to add a panel build entry

```typescript
// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig([
  // Main plugin bundle — tools, hooks, activate()
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    external: ['react', 'react-dom'],
  },
  // Panel bundle — Home panel React component
  {
    entry: ['src/panel.tsx'],
    format: ['esm'],
    dts: true,
    external: ['react', 'react-dom', '@ethosagent/ui-components'],
  },
]);
```

`react`, `react-dom`, and `@ethosagent/ui-components` are external in the panel bundle. tsup leaves them as bare `import` specifiers resolved by the host at runtime.

### 3c. Add a `dev:panel` script

```json
{
  "scripts": {
    "build": "tsup",
    "dev:panel": "tsup --watch --entry src/panel.tsx --format esm --external react --external react-dom --external @ethosagent/ui-components"
  }
}
```

Run `pnpm dev:panel` in a terminal while developing. The desktop app watches `dist/panel.js` and hot-reloads the Plugins drawer when the file changes. You do not need to restart the app or reinstall the plugin between edits.

## What you learned

- Steps 1-3 done: Declare the credential schema; Declare the Home panel in the manifest; Add the panel export and update the build config.

## Next step

Continue with [part 2 of 4: write the panel and the OAuth button](build-a-plugin-home-panel-2-panel-and-oauth.md).
