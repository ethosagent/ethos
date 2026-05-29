import type { PluginCredentialSchema } from '@ethosagent/types';
import { PluginSettingsPanel } from '@ethosagent/ui-components';

interface PluginSettingsDrawerProps {
  pluginId: string;
  name: string;
  version: string;
  description?: string;
  credentials: PluginCredentialSchema[];
  tools: string[];
  theme: 'dark' | 'light';
  onClose: () => void;
}

export function PluginSettingsDrawer({
  pluginId,
  name,
  version,
  description,
  credentials,
  tools,
  theme,
  onClose,
}: PluginSettingsDrawerProps) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        width: 400,
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
          Plugin Settings
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
      <div style={{ flex: 1, overflow: 'auto' }}>
        <PluginSettingsPanel
          name={name}
          version={version}
          description={description}
          credentials={credentials}
          tools={tools}
          getCredential={async (ref) => {
            const res = await window.ethos.plugin.getCredential(pluginId, ref);
            return res.value ?? null;
          }}
          setCredential={async (ref, value) => {
            await window.ethos.plugin.setCredential(pluginId, ref, value);
          }}
          credentialPreview={async (ref) => {
            const res = await window.ethos.plugin.credentialPreview(pluginId, ref);
            return res.preview ?? null;
          }}
          requestOAuth={(oauthRef) => {
            window.ethos.plugin.requestOAuth(pluginId, oauthRef);
          }}
          theme={theme}
        />
      </div>
    </div>
  );
}
