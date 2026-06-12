import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';

interface RouteResult {
  ok: boolean;
  routedTo: string | null;
  reason: string | null;
}

export function RouteTestSection() {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [capability, setCapability] = useState('');
  const [result, setResult] = useState<RouteResult | null>(null);

  const handleTest = useCallback(async () => {
    if (!capability.trim()) return;
    try {
      const res = await client.rpc.mesh.routeTest({ capability: capability.trim() });
      setResult(res);
    } catch {
      setResult(null);
    }
  }, [client, capability]);

  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-tertiary)',
          marginBottom: 8,
        }}
      >
        ROUTE TEST
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          value={capability}
          onChange={(e) => setCapability(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleTest();
          }}
          placeholder="code"
          style={{
            flex: 1,
            height: 36,
            fontSize: 13,
            color: 'var(--text-primary)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            padding: '0 10px',
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={handleTest}
          style={{
            height: 28,
            padding: '0 12px',
            borderRadius: 4,
            border: '1px solid var(--border-subtle)',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Test &rarr;
        </button>
      </div>

      {result && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Routed to:</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-primary)',
              }}
            >
              {result.routedTo ?? 'None'}
            </span>
          </div>
          {result.reason && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>
                Reason:
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{result.reason}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
