---
title: "Build a plugin Home panel, part 3: tool calls, design tokens, charts"
description: "Call a plugin tool from the panel, use design tokens, add an optional chart."
kind: tutorial
audience: developer
updated: 2026-11-03
---

## Goal

Finish steps 7-9 of [Build a plugin Home panel](build-a-plugin-home-panel.md): Call a plugin tool directly from the panel; Use design tokens; (Optional) Add a third-party chart library.

## Prereqs

- Complete [part 2 of 4](build-a-plugin-home-panel-2-panel-and-oauth.md).

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

## What you learned

- Steps 7-9 done: Call a plugin tool directly from the panel; Use design tokens; (Optional) Add a third-party chart library.

## Next step

Continue with [part 4 of 4: build and verify in the desktop app](build-a-plugin-home-panel-4-build-and-verify.md).
