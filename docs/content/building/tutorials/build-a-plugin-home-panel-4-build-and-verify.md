---
title: "Build a plugin Home panel, part 4: build and verify in the desktop app"
description: "Build the panel and verify it in the desktop app."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish step 10 of [Build a plugin Home panel](build-a-plugin-home-panel.md): Build and verify in the desktop app.

## Prereqs

- Complete [part 3 of 4](build-a-plugin-home-panel-3-tool-calls-tokens-chart.md).

## 10. Build and verify in the desktop app

Build the full plugin:

```bash
pnpm build
```

Confirm both output files exist:

```bash
ls dist/
# index.js  index.d.ts  panel.js  panel.d.ts
```

If the plugin is installed locally, the desktop app picks up the new `dist/panel.js` on next load without reinstalling. If you installed from a path reference in `~/.ethos/config.yaml`, it reads `dist/panel.js` directly from disk — no reinstall needed after a rebuild.

Open the Ethos desktop app:

1. Navigate to **Plugins** in the sidebar.
2. Find **Zerodha** in the plugin list.
3. Click the row to open the drawer.
4. The **Home** tab should appear alongside **Settings**.

Verify the full flow:

- Credential rows show ✓ or ✗ depending on what is stored.
- The Connect/Reconnect button triggers the browser OAuth flow.
- After connecting, the token row updates automatically and the holdings table loads.
- ✓ / ✗ colours match the host theme (switch the desktop app between light and dark mode to confirm).

If the Home tab does not appear, check that `hasHomePanel: true` is set in `package.json`, `dist/panel.js` exists, and the plugin was reloaded after the manifest change (restarting the app forces a reload).

If `executeTool('zerodha_holdings', {})` returns `ok: false`, the most likely cause is a missing or expired access token. The error string from the tool is what you surface in the `holdingsError` state.

For hot-reload during active development, run `pnpm dev:panel` in a terminal alongside the app. Every time you save `src/panel.tsx`, tsup rebuilds `dist/panel.js` and the desktop app reloads the panel component.

## What you learned

- Every plugin gets two drawer surfaces: **Settings** (framework-rendered from the credential schema) and **Home** (plugin-rendered React component). Declaring the credential schema in `package.json` costs you nothing — the host renders it automatically.
- `hasHomePanel: true` in the manifest signals that a `./panel` export exists. The `./panel` export points at `dist/panel.js`, built by a separate tsup entry.
- `@ethosagent/ui-components`, `react`, and `react-dom` are peer dependencies in the panel bundle — the host provides them to prevent duplicate React instances.
- `PluginPanelProps` gives you `getCredential`, `credentialPreview`, `setCredential`, `requestOAuth`, `executeTool`, `onCredentialChange`, and `designTokens`. These are everything a panel needs to read state, trigger flows, and call tools.
- `onCredentialChange` returns an unsubscribe function — always clean it up in the `useEffect` return to avoid memory leaks.
- `executeTool` runs a tool from this plugin without an LLM turn. It is scoped to your `pluginId`; you cannot call another plugin's tools.
- OAuth is supported only on surfaces that own a browser: desktop app, web app, and CLI. On Telegram and Discord, direct users to the desktop or web app to complete OAuth.
- Design tokens are a choice, not a requirement. Use them for theme consistency or ignore them if your plugin has its own design system.

## Next step

- [Publish a plugin](../how-to/publish-a-plugin.md) — package `dist/` and ship the plugin (including the panel) to npm.
- [Plugin SDK reference](../reference/plugin-sdk.md) — full API for `EthosPlugin`, `EthosPluginApi`, `PluginPanelProps`, and the credential schema fields.
