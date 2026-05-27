import { createEthosClient } from '@ethosagent/sdk';
import type { PluginInfo } from '@ethosagent/web-contracts';
import { useEffect, useMemo, useState } from 'react';

interface PluginsTabProps {
  plugins: string[];
  onChange: (plugins: string[]) => void;
  port: number;
}

export function PluginsTab({ plugins, onChange, port }: PluginsTabProps) {
  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [available, setAvailable] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    client.rpc.plugins
      .list({})
      .then((res) => {
        if (!cancelled) setAvailable(res.plugins);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const attached = useMemo(() => new Set(plugins), [plugins]);

  function toggle(id: string, on: boolean) {
    if (on) {
      onChange([...plugins, id]);
    } else {
      onChange(plugins.filter((p) => p !== id));
    }
  }

  if (loading) {
    return <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Loading plugins...</span>;
  }

  if (available.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
        No plugins installed. Go to Skills → Plugins to install one.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
        }}
      >
        {available.map((plugin, i) => (
          <div
            key={plugin.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px',
              borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)',
              backgroundColor: 'var(--bg-primary)',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                {plugin.name}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-tertiary)',
                }}
              >
                {plugin.id}@{plugin.version}
              </span>
              {plugin.description && (
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {plugin.description}
                </span>
              )}
            </div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <input
                type="checkbox"
                checked={attached.has(plugin.id)}
                onChange={(e) => toggle(plugin.id, e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
            </label>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
        Attached plugins are active when using this personality. Save to apply.
      </div>
    </div>
  );
}
