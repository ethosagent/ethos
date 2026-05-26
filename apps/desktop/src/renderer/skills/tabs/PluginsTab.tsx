import { createEthosClient } from '@ethosagent/sdk';
import { useEffect, useMemo, useState } from 'react';
import { SectionLabel } from '../../ui/SectionLabel';
import { PluginRow } from '../components/PluginRow';

interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string | null;
  source: 'user' | 'project' | 'npm';
  path: string;
  pluginContractMajor: number | null;
}

interface PluginsTabProps {
  port: number;
}

export function PluginsTab({ port }: PluginsTabProps) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [explainerDismissed, setExplainerDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  useEffect(() => {
    let stale = false;
    client.rpc.plugins
      .list({})
      .then((res: { plugins: Plugin[] }) => {
        if (!stale) setPlugins(res.plugins);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [client]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText('ethos plugin install <package-name>');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // best-effort
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!explainerDismissed && (
        <div
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 16px',
            border: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', flex: 1 }}>
            Plugins extend Ethos with new tools, channel adapters, and memory backends. Install them
            via the command line.
          </span>
          <button
            type="button"
            onClick={() => setExplainerDismissed(true)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
              color: 'var(--info)',
              padding: 0,
              flexShrink: 0,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div>
        <SectionLabel>INSTALLED PLUGINS</SectionLabel>
        <div style={{ marginTop: 8 }}>
          {plugins.length === 0 ? (
            <div>
              <div style={{ fontSize: 14, color: 'var(--text-tertiary)' }}>
                No plugins installed.
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                Run{' '}
                <code style={{ fontFamily: 'var(--font-mono)' }}>
                  ethos plugin install &lt;name&gt;
                </code>{' '}
                in a terminal to add plugins.
              </div>
            </div>
          ) : (
            <div
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
              }}
            >
              {plugins.map((plugin) => (
                <PluginRow key={plugin.id} plugin={plugin} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          backgroundColor: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-md)',
          padding: '12px 16px',
          border: '1px solid var(--border-subtle)',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        <SectionLabel>INSTALL A PLUGIN</SectionLabel>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            backgroundColor: 'var(--bg-overlay)',
            borderRadius: 'var(--radius-md)',
            padding: 12,
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ color: 'var(--text-primary)' }}>
            ethos plugin install &lt;package-name&gt;
          </span>
          <button
            type="button"
            onClick={handleCopy}
            style={{
              background: 'none',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              height: 24,
              padding: '0 8px',
              cursor: 'pointer',
              fontSize: 12,
              color: copied ? 'var(--success)' : 'var(--text-secondary)',
              flexShrink: 0,
            }}
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          Restart Ethos after installing to load the new plugin.
        </div>
      </div>
    </div>
  );
}
