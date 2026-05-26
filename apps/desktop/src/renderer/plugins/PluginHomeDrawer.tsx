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
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
          Plugin Home
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-tertiary)',
            fontSize: 18,
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>
      <div className="plugin-panel-host" data-theme={theme} style={{ flex: 1, overflow: 'auto' }}>
        {error ? (
          <div style={{ padding: 16, color: 'var(--error)', fontSize: 13 }}>{error}</div>
        ) : Panel ? (
          <Panel {...props} />
        ) : (
          <div style={{ padding: 16, color: 'var(--text-tertiary)', fontSize: 13 }}>
            Loading panel...
          </div>
        )}
      </div>
    </div>
  );
}
