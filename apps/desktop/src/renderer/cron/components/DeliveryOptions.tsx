import { useState } from 'react';
import { Toggle } from '../../ui/Toggle';

interface DeliveryOptionsProps {
  platformStatus: { telegram: boolean; slack: boolean; discord: boolean };
}

export function DeliveryOptions({ platformStatus }: DeliveryOptionsProps) {
  const [expanded, setExpanded] = useState(false);
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [slackEnabled, setSlackEnabled] = useState(false);

  const hasAnyPlatform = platformStatus.telegram || platformStatus.slack;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          fontFamily: 'var(--font-display)',
          fontSize: 13,
          color: 'var(--text-secondary)',
        }}
      >
        {expanded ? '− Delivery options' : '+ Delivery options'}
      </button>
      {expanded && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
              Keep in session history ✓
            </span>
          </div>

          {platformStatus.telegram && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>Send to Telegram</span>
              <Toggle checked={telegramEnabled} onChange={setTelegramEnabled} />
            </div>
          )}

          {platformStatus.slack && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>Send to Slack</span>
              <Toggle checked={slackEnabled} onChange={setSlackEnabled} />
            </div>
          )}

          {!hasAnyPlatform && (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              No messaging platforms configured
            </span>
          )}
        </div>
      )}
    </div>
  );
}
