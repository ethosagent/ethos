import type { createEthosClient } from '@ethosagent/sdk';
import { useState } from 'react';
import { StatusDot } from '../ui/StatusDot';
import type { Channel } from './AdminPage';

interface ChannelsTabProps {
  client: ReturnType<typeof createEthosClient>;
  channels: Channel[];
  onReload: () => void;
}

function statusDisplay(status: Channel['status']): { color: string; text: string } {
  if (status === 'connected') return { color: 'var(--success)', text: 'Connected' };
  if (status === 'error') return { color: 'var(--error)', text: 'Error' };
  return { color: 'var(--text-tertiary)', text: 'Disconnected' };
}

const columnHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
};

export function ChannelsTab({ client, channels }: ChannelsTabProps) {
  const [pending, setPending] = useState<Set<string>>(new Set());

  async function handleTestSend(channelId: string) {
    setPending((prev) => new Set(prev).add(channelId));
    try {
      const result = await client.rpc.admin.testSend({ channel: channelId });
      await window.ethos.dialog.showMessage({
        type: result.ok ? 'info' : 'warning',
        message: result.ok
          ? 'Test message sent'
          : `Test send failed${result.error ? `: ${result.error}` : ''}`,
        buttons: ['OK'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await window.ethos.dialog.showMessage({ type: 'warning', message: msg, buttons: ['OK'] });
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(channelId);
        return next;
      });
    }
  }

  if (channels.length === 0) {
    return (
      <div style={{ paddingTop: 48, textAlign: 'center' }}>
        <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>No channels configured.</div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '0 24px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 32,
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ ...columnHeaderStyle, flex: 1 }}>Platform</div>
        <div style={{ ...columnHeaderStyle, width: 160 }}>ID</div>
        <div style={{ ...columnHeaderStyle, width: 140 }}>Status</div>
        <div style={{ ...columnHeaderStyle, flex: 1 }}>Webhook URL</div>
        <div style={{ ...columnHeaderStyle, width: 100 }}>Actions</div>
      </div>
      {channels.map((ch) => {
        const sd = statusDisplay(ch.status);
        return (
          <div
            key={ch.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 44,
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <div
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 13,
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {ch.platform}
            </div>
            <div
              style={{
                width: 160,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {ch.id}
            </div>
            <div style={{ width: 140, display: 'flex', alignItems: 'center', gap: 6 }}>
              <StatusDot color={sd.color} />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{sd.text}</span>
            </div>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: ch.webhookUrl ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {ch.webhookUrl ?? '-'}
            </div>
            <div style={{ width: 100 }}>
              <button
                type="button"
                disabled={pending.has(ch.id)}
                onClick={() => handleTestSend(ch.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--info)',
                  fontSize: 12,
                  cursor: pending.has(ch.id) ? 'not-allowed' : 'pointer',
                  padding: 0,
                  opacity: pending.has(ch.id) ? 0.5 : 1,
                }}
              >
                Test send
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
