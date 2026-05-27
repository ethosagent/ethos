import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../../state/AppContext';

interface WhatsAppDrawerProps {
  onBotChange?: () => void;
}

const microLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-tertiary)',
  marginBottom: 8,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
  marginBottom: 4,
};

const valueStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  color: 'var(--text-primary)',
};

export function WhatsAppDrawer({ onBotChange }: WhatsAppDrawerProps) {
  const { state } = useAppState();
  const baseUrl = `http://localhost:${state.port}`;
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  const checkStatus = useCallback(async () => {
    try {
      const result = await client.rpc.platforms.list({});
      const wa = result.platforms.find((p) => p.id === 'whatsapp');
      setConnected(wa?.configured ?? false);
    } catch {
      setConnected(false);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 10_000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  // Trigger parent reload when status changes
  useEffect(() => {
    onBotChange?.();
  }, [connected, onBotChange]);

  const statusDot = connected ? 'var(--success)' : 'var(--text-tertiary)';
  const statusText = loading ? 'Checking...' : connected ? 'Connected' : 'Disconnected';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <div style={microLabel}>STATUS</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: statusDot,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{statusText}</span>
        </div>
      </div>

      <div>
        <div style={microLabel}>PAIRING</div>
        <div
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderRadius: 8,
            padding: '12px 16px',
            fontSize: 12,
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
          }}
        >
          <div>
            1. Start the gateway with WhatsApp enabled (
            <code style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>ethos gateway</code>)
          </div>
          <div>2. A QR code will appear in the terminal</div>
          <div>
            3. Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device
          </div>
          <div>4. Scan the QR code with your phone</div>
          <div style={{ marginTop: 8, color: 'var(--text-tertiary)' }}>
            Or visit the web setup page at{' '}
            <code style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              http://localhost:{state.port}/setup/whatsapp
            </code>
          </div>
        </div>
      </div>

      <div>
        <div style={microLabel}>CONFIGURATION</div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: '12px 16px',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
          }}
        >
          <div>
            <div style={labelStyle}>Bot ID</div>
            <div style={valueStyle}>
              Set via <code style={{ fontSize: 11 }}>id</code> in config.yaml (optional)
            </div>
          </div>
          <div>
            <div style={labelStyle}>Default channel mode</div>
            <div style={valueStyle}>
              <code style={{ fontSize: 11 }}>all</code> or{' '}
              <code style={{ fontSize: 11 }}>mention_only</code>
            </div>
          </div>
          <div>
            <div style={labelStyle}>Allowed numbers</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Restrict which phone numbers can interact with the bot. Set{' '}
              <code style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>allowed_numbers</code>{' '}
              in config.yaml to a list of JIDs.
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          fontSize: 12,
          color: 'var(--text-secondary)',
          backgroundColor: 'var(--bg-elevated)',
          borderRadius: 8,
          padding: 12,
          lineHeight: 1.5,
        }}
      >
        WhatsApp configuration is managed in{' '}
        <code style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>~/.ethos/config.yaml</code>{' '}
        under the <code style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>whatsapp</code>{' '}
        section. The session persists across restarts once paired.
      </div>

      <div
        style={{
          fontSize: 12,
          color: 'var(--text-tertiary)',
          fontStyle: 'italic',
        }}
      >
        The gateway runs inside Ethos. Keep the app running or minimized to the tray for this bot to
        stay online.
      </div>
    </div>
  );
}
