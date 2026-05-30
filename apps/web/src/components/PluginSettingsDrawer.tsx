import type { EthosClient } from '@ethosagent/sdk';
import { PluginSettingsPanel } from '@ethosagent/ui-components';

export interface PluginCredentialSchema {
  ref: string;
  label: string;
  kind: 'text' | 'secret' | 'oauth';
  description?: string;
  oauthRef?: string;
}

interface PluginSettingsDrawerProps {
  pluginId: string;
  name: string;
  version: string;
  description?: string;
  credentials: PluginCredentialSchema[];
  tools: string[];
  theme: 'dark' | 'light';
  client: EthosClient;
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
  client,
  onClose,
}: PluginSettingsDrawerProps) {
  return (
    <>
      <button
        type="button"
        aria-label="Close settings"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.6)',
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
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 480,
          maxHeight: '80vh',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
          background: 'var(--ethos-bg-elevated)',
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
            getCredential={(ref: string) =>
              client.rpc.plugins
                .getCredential({ pluginId, ref })
                .then((r: { value: string | null }) => r.value)
            }
            setCredential={(ref: string, value: string) =>
              client.rpc.plugins.setCredential({ pluginId, key: ref, value }).then(() => {})
            }
            credentialPreview={(ref: string) =>
              client.rpc.plugins
                .credentialPreview({ pluginId, ref })
                .then((r: { preview: string | null }) => r.preview)
            }
            requestOAuth={(oauthRef: string) => {
              window.location.href = `/auth/${pluginId}/${oauthRef}`;
            }}
            theme={theme}
          />
        </div>
      </div>
    </>
  );
}
