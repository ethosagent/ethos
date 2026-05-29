---
title: "Build a plugin Home panel"
description: "Add a React Home panel to an existing Ethos plugin — manifest changes, panel export, PluginPanelProps, OAuth status, direct tool calls, design tokens."
kind: tutorial
audience: developer
slug: build-a-plugin-home-panel
time: "20 min"
updated: 2026-05-29
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

## 4. Write `src/panel.tsx` — skeleton

Create `src/panel.tsx`. The host imports the default export as a React component and passes it a single `PluginPanelProps` prop.

```tsx
import React, { useEffect, useState } from 'react';
import type { PluginPanelProps } from '@ethosagent/types';

export default function ZerodhaHomePanel(props: PluginPanelProps) {
  const { pluginId, designTokens } = props;

  return (
    <div
      style={{
        padding: '24px',
        fontFamily: 'inherit',
        color: designTokens.foreground,
        background: designTokens.background,
        minHeight: '100%',
      }}
    >
      <h2 style={{ marginTop: 0 }}>Zerodha</h2>
      <p style={{ color: designTokens.muted }}>Loading…</p>
    </div>
  );
}
```

This is the minimum viable panel — it renders, uses the `background` and `foreground` tokens, and confirms the host can load your component. Build it and open the Plugins drawer before adding real data:

```bash
pnpm build
```

Open the Ethos desktop app, navigate to Plugins, find Zerodha, and click the panel tab. You should see "Loading…" in the right colour for the current theme. If the panel tab does not appear, check that `hasHomePanel: true` is set and `dist/panel.js` exists.

## 5. Display credentials and OAuth status

Replace the placeholder with real status indicators. Each credential has three states: not set, set (masked preview available), or — for OAuth — expired. Map those states to visible feedback.

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import type { PluginPanelProps } from '@ethosagent/types';

type CredStatus = 'unset' | 'set' | 'checking';

export default function ZerodhaHomePanel(props: PluginPanelProps) {
  const { credentialPreview, designTokens } = props;

  const [apiKeyStatus, setApiKeyStatus] = useState<CredStatus>('checking');
  const [apiSecretStatus, setApiSecretStatus] = useState<CredStatus>('checking');
  const [tokenPreview, setTokenPreview] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [keyPreview, secretPreview, accessPreview] = await Promise.all([
      credentialPreview('brokers/zerodha/apiKey'),
      credentialPreview('brokers/zerodha/apiSecret'),
      credentialPreview('brokers/zerodha/accessToken'),
    ]);
    setApiKeyStatus(keyPreview !== null ? 'set' : 'unset');
    setApiSecretStatus(secretPreview !== null ? 'set' : 'unset');
    setTokenPreview(accessPreview);
  }, [credentialPreview]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const statusIcon = (s: CredStatus) =>
    s === 'checking' ? '⏳' : s === 'set' ? '✓' : '✗';
  const statusColor = (s: CredStatus) =>
    s === 'set' ? designTokens.success : designTokens.danger;

  return (
    <div style={{ padding: '24px', color: designTokens.foreground }}>
      <h2 style={{ marginTop: 0 }}>Zerodha</h2>

      <section style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '14px', color: designTokens.muted }}>Credentials</h3>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <tbody>
            {[
              { label: 'API Key', status: apiKeyStatus },
              { label: 'API Secret', status: apiSecretStatus },
            ].map(({ label, status }) => (
              <tr key={label}>
                <td style={{ padding: '6px 0', width: '120px' }}>{label}</td>
                <td style={{ color: statusColor(status) }}>
                  {statusIcon(status)} {status === 'set' ? 'Configured' : 'Not set'}
                </td>
              </tr>
            ))}
            <tr>
              <td style={{ padding: '6px 0' }}>Access Token</td>
              <td style={{ color: tokenPreview ? designTokens.success : designTokens.warning }}>
                {tokenPreview ? `✓ ${tokenPreview}` : '✗ Not connected'}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

`credentialPreview` returns a masked string like `"abc…xyz"` when a credential is set, and `null` when it isn't. The API key and secret columns show ✓ or ✗ based on presence. The access token column shows the masked preview — a quick visual check that the OAuth session is live.

## 6. Add an OAuth reconnect button

```tsx
// Add inside ZerodhaHomePanel, after the credentials section:

const handleReconnect = () => {
  props.requestOAuth('zerodha');
};

// Subscribe to token changes — re-read when OAuth completes
useEffect(() => {
  const unsub = props.onCredentialChange('brokers/zerodha/accessToken', () => {
    void refresh();
  });
  return unsub;
}, [props.onCredentialChange, refresh]);

// Render inside your JSX:
<section style={{ marginBottom: '24px' }}>
  <button
    onClick={handleReconnect}
    style={{
      padding: '8px 16px',
      background: designTokens.brand,
      color: '#fff',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
    }}
  >
    {tokenPreview ? 'Reconnect Zerodha' : 'Connect Zerodha'}
  </button>
</section>
```

`requestOAuth('zerodha')` triggers the OAuth flow. The mechanism depends on the surface:

| Surface | What `requestOAuth` does |
|---|---|
| Desktop app | Opens browser via `ethos://auth/zerodha` protocol handler |
| Web app | Opens a new browser tab to the provider's auth URL |
| CLI | Starts a `LocalOAuthServer` on localhost, opens browser, catches the redirect |

`onCredentialChange` returns an unsubscribe function, which the `useEffect` cleanup calls on unmount. When the OAuth flow completes and the token is written to the secrets store, the callback fires and `refresh()` re-reads the preview — the status row and button label update without a full panel reload.

**OAuth is not available on Telegram or Discord.** Messaging platforms have no browser context to complete the OAuth redirect. If a user on Telegram or Discord asks how to connect Zerodha, the agent responds: "To connect Zerodha, open the Ethos desktop or web app, go to Plugins → Zerodha → Home, and tap Connect Zerodha there." Text and secret credentials (`kind: 'secret'`, `kind: 'text'`) work on all surfaces, including messaging, via agent conversation — only OAuth requires a browser surface.

## 7. Call a plugin tool directly from the panel

`executeTool` runs one of your plugin's registered tools without an LLM turn. The call is scoped to your `pluginId` — you cannot call another plugin's tools, and the framework rejects attempts to do so. This is the right shape for a dashboard: fetch live data from the same backend your tools use, without burning tokens on a completion.

```tsx
type Holding = {
  tradingsymbol: string;
  quantity: number;
  last_price: number;
  pnl: number;
};

// Add to ZerodhaHomePanel state:
const [holdings, setHoldings] = useState<Holding[]>([]);
const [holdingsError, setHoldingsError] = useState<string | null>(null);
const [loadingHoldings, setLoadingHoldings] = useState(false);

const fetchHoldings = useCallback(async () => {
  setLoadingHoldings(true);
  setHoldingsError(null);
  const result = await props.executeTool('zerodha_holdings', {});
  setLoadingHoldings(false);
  if (!result.ok) {
    setHoldingsError(result.error ?? 'Failed to load holdings');
    return;
  }
  // zerodha_holdings returns a JSON string — parse it.
  try {
    setHoldings(JSON.parse(result.value ?? '[]') as Holding[]);
  } catch {
    setHoldingsError('Unexpected response format from zerodha_holdings');
  }
}, [props.executeTool]);

useEffect(() => {
  // Only fetch if the access token is present.
  if (tokenPreview !== null) void fetchHoldings();
}, [tokenPreview, fetchHoldings]);

// Render inside your JSX, after the reconnect button:
<section>
  <h3 style={{ fontSize: '14px', color: designTokens.muted }}>Holdings</h3>
  {loadingHoldings && <p>Loading…</p>}
  {holdingsError && (
    <p style={{ color: designTokens.danger }}>{holdingsError}</p>
  )}
  {!loadingHoldings && !holdingsError && holdings.length === 0 && (
    <p style={{ color: designTokens.muted }}>No holdings found.</p>
  )}
  {holdings.length > 0 && (
    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${designTokens.border}` }}>
          <th style={{ textAlign: 'left', padding: '6px 8px' }}>Symbol</th>
          <th style={{ textAlign: 'right', padding: '6px 8px' }}>Qty</th>
          <th style={{ textAlign: 'right', padding: '6px 8px' }}>LTP</th>
          <th style={{ textAlign: 'right', padding: '6px 8px' }}>P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        {holdings.map((h) => (
          <tr
            key={h.tradingsymbol}
            style={{ borderBottom: `1px solid ${designTokens.border}` }}
          >
            <td style={{ padding: '6px 8px' }}>{h.tradingsymbol}</td>
            <td style={{ textAlign: 'right', padding: '6px 8px' }}>{h.quantity}</td>
            <td style={{ textAlign: 'right', padding: '6px 8px' }}>
              ₹{h.last_price.toFixed(2)}
            </td>
            <td
              style={{
                textAlign: 'right',
                padding: '6px 8px',
                color: h.pnl >= 0 ? designTokens.success : designTokens.danger,
              }}
            >
              {h.pnl >= 0 ? '+' : ''}₹{h.pnl.toFixed(2)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )}
</section>
```

The `useEffect` depends on `tokenPreview` — it waits until the OAuth token is confirmed present before calling `zerodha_holdings`. If the user hasn't connected yet, the holdings section stays empty. After they connect, `onCredentialChange` fires, `refresh()` updates `tokenPreview`, and `fetchHoldings` runs automatically.

`executeTool` returns `{ ok: true, value: string }` or `{ ok: false, error?: string }`. Tools always return strings — `zerodha_holdings` returns JSON, so parse it. Tools that return natural-language summaries return prose strings; display them directly.

## 8. Use design tokens

The `designTokens` prop gives you the eight CSS custom property values for the current theme (light/dark/system). Using them keeps your panel consistent with the host app when the user switches themes.

```tsx
// As inline styles (shown throughout this tutorial):
<td style={{ color: designTokens.success }}>✓</td>

// As CSS custom properties — identical values, different mechanism:
<td style={{ color: 'var(--success)' }}>✓</td>
```

The host exposes `--foreground`, `--background`, `--brand`, `--border`, `--muted`, `--success`, `--warning`, and `--danger` on the root element. Both approaches work. CSS custom properties are convenient if you're writing a stylesheet; the prop is convenient if you're building inline styles or passing values to a charting library.

Using the tokens is a choice, not a requirement. If your plugin has its own design system — a trading platform UI with its own colour palette — use it. The host does not enforce token adherence.

## 9. (Optional) Add a third-party chart library

The panel bundles its own dependencies. Any npm package works — add it as a `dependency` in your `package.json` and import it in `src/panel.tsx`. `lightweight-charts` (TradingView's charting library) is a common choice for broker plugins:

```bash
pnpm add lightweight-charts
```

```tsx
import { createChart } from 'lightweight-charts';
import React, { useEffect, useRef } from 'react';

function PnlChart({ holdings }: { holdings: Holding[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || holdings.length === 0) return;
    const chart = createChart(containerRef.current, { height: 200 });
    const series = chart.addBarSeries();
    series.setData(
      holdings.map((h, i) => ({
        time: (Date.now() / 1000 - i * 86_400) as any,
        open: h.last_price - Math.abs(h.pnl),
        high: h.last_price,
        low: h.last_price - Math.abs(h.pnl),
        close: h.last_price,
      })),
    );
    return () => chart.remove();
  }, [holdings]);

  return <div ref={containerRef} />;
}
```

Third-party libraries go into the panel bundle — tsup includes them in `dist/panel.js`. Only `react`, `react-dom`, and `@ethosagent/ui-components` stay external. A large charting library will increase your panel's load time; measure before shipping.

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
