import type { PluginPanelProps } from '@ethosagent/types';
import { useEffect, useState } from 'react';

interface PluginHomeDrawerProps {
  pluginId: string;
  pluginPath: string;
  theme: 'dark' | 'light';
  onClose: () => void;
}

export function PluginHomeDrawer({ pluginId, pluginPath, theme, onClose }: PluginHomeDrawerProps) {
  const [Panel, setPanel] = useState<React.ComponentType<PluginPanelProps> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authVersion, setAuthVersion] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        const panelPath = `${pluginPath}/dist/panel.js`;
        const mod = await import(/* @vite-ignore */ panelPath);
        setPanel(() => mod.default ?? mod.HomePanel);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load panel');
      }
    }
    load();
  }, [pluginPath]);

  useEffect(() => {
    if (!window.ethos?.plugin?.onOAuthComplete) return;
    window.ethos.plugin.onOAuthComplete(() => {
      setAuthVersion((v) => v + 1);
    });
  }, []);

  const props: PluginPanelProps = {
    pluginId,
    getCredential: async (ref) => {
      const res = await window.ethos.plugin.getCredential(pluginId, ref);
      return res.value ?? null;
    },
    setCredential: async (ref, value) => {
      await window.ethos.plugin.setCredential(pluginId, ref, value);
    },
    credentialPreview: async (ref) => {
      const res = await window.ethos.plugin.credentialPreview(pluginId, ref);
      return res.preview ?? null;
    },
    requestOAuth: (oauthRef) => {
      window.ethos.plugin.requestOAuth(pluginId, oauthRef);
    },
    executeTool: (name, args) => window.ethos.plugin.executeTool(pluginId, name, args),
    theme,
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close panel"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          zIndex: 49,
          border: 'none',
          cursor: 'default',
          padding: 0,
        }}
        onClick={onClose}
      />
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          width: 420,
          height: '100%',
          background: 'var(--bg-elevated)',
          borderLeft: '1px solid var(--border-subtle)',
          zIndex: 50,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 40,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 12px',
            borderBottom: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: 13,
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            ← Back
          </button>
        </div>
        <div className="plugin-panel-host" data-theme={theme} style={{ flex: 1, overflow: 'auto' }}>
          {error ? (
            <div style={{ padding: 24 }}>
              <p style={{ color: 'var(--error)', fontSize: 13, marginBottom: 8 }}>
                Failed to load plugin panel.
              </p>
              <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
                The plugin may not be built. Run{' '}
                <code style={{ fontFamily: 'var(--font-mono)' }}>npm run build</code> in the plugin
                directory, then reopen this panel.
              </p>
              <p
                style={{
                  color: 'var(--text-tertiary)',
                  fontSize: 11,
                  marginTop: 8,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {error}
              </p>
            </div>
          ) : Panel ? (
            <Panel key={authVersion} {...props} />
          ) : (
            <div style={{ padding: 16, color: 'var(--text-tertiary)', fontSize: 13 }}>
              Loading panel...
            </div>
          )}
        </div>
      </div>
    </>
  );
}
