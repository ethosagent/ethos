---
title: "Build a plugin Home panel, part 2: write the panel and the OAuth button"
description: "Write the panel skeleton, show credentials and add an OAuth reconnect button."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish steps 4-6 of [Build a plugin Home panel](build-a-plugin-home-panel.md): Write `src/panel.tsx` — skeleton; Display credentials and OAuth status; Add an OAuth reconnect button.

## Prereqs

- Complete [part 1 of 4](build-a-plugin-home-panel.md).

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

## What you learned

- Steps 4-6 done: Write `src/panel.tsx` — skeleton; Display credentials and OAuth status; Add an OAuth reconnect button.

## Next step

Continue with [part 3 of 4: tool calls, design tokens, charts](build-a-plugin-home-panel-3-tool-calls-tokens-chart.md).
