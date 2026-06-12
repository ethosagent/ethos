import { createEthosClient } from '@ethosagent/sdk';
import { useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';
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

export function PluginsTab() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [explainerDismissed, setExplainerDismissed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [packageSpec, setPackageSpec] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installSuccess, setInstallSuccess] = useState<string | null>(null);

  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  useEffect(() => {
    // refreshKey is intentionally read to re-trigger this effect after install.
    void refreshKey;
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
  }, [client, refreshKey]);

  async function handleInstall() {
    const spec = packageSpec.trim();
    if (!spec) return;
    setInstalling(true);
    setInstallError(null);
    setInstallSuccess(null);
    try {
      await client.rpc.plugins.install({ packageSpec: spec });
      setInstallSuccess(`${spec} installed successfully.`);
      setPackageSpec('');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }

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
                Use the install form below to add plugins.
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
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            type="text"
            placeholder="Package spec, e.g. @scope/my-plugin@1.0.0"
            value={packageSpec}
            onChange={(e) => setPackageSpec(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleInstall()}
            disabled={installing}
            style={{
              flex: 1,
              height: 30,
              padding: '0 8px',
              fontSize: 12,
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--bg-overlay)',
              color: 'var(--text-primary)',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={handleInstall}
            disabled={installing || !packageSpec.trim()}
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              height: 30,
              padding: '0 12px',
              cursor: installing || !packageSpec.trim() ? 'not-allowed' : 'pointer',
              fontSize: 12,
              color: 'var(--text-primary)',
              backgroundColor: 'var(--bg-overlay)',
              flexShrink: 0,
              opacity: installing || !packageSpec.trim() ? 0.5 : 1,
            }}
          >
            {installing ? 'Installing…' : 'Install'}
          </button>
        </div>
        {installError && (
          <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 6 }}>{installError}</div>
        )}
        {installSuccess && (
          <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 6 }}>
            {installSuccess}
          </div>
        )}
      </div>
    </div>
  );
}
