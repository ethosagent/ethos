import { useState } from 'react';

interface StatusBarProps {
  backendConnected: boolean;
  providerModel: string;
  onNavigate: (route: string) => void;
}

export function StatusBar({ backendConnected, providerModel, onNavigate }: StatusBarProps) {
  const [hoveredPill, setHoveredPill] = useState<string | null>(null);

  return (
    <div
      style={{
        height: 28,
        minHeight: 28,
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-elevated)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: backendConnected ? '#4ADE80' : '#F87171',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
          }}
        >
          {backendConnected ? 'Backend connected' : 'offline'}
        </span>
      </div>

      <div
        style={{
          width: 1,
          height: 12,
          background: 'var(--border-subtle)',
          flexShrink: 0,
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        <button
          type="button"
          onClick={() => onNavigate('activity')}
          onMouseEnter={() => setHoveredPill('activity')}
          onMouseLeave={() => setHoveredPill(null)}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-secondary)',
            background: hoveredPill === 'activity' ? 'var(--bg-overlay)' : 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          Activity
        </button>
        <div
          style={{
            width: 1,
            height: 12,
            background: 'var(--border-subtle)',
            flexShrink: 0,
          }}
        />
        <button
          type="button"
          onClick={() => onNavigate('cron')}
          onMouseEnter={() => setHoveredPill('cron')}
          onMouseLeave={() => setHoveredPill(null)}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-secondary)',
            background: hoveredPill === 'cron' ? 'var(--bg-overlay)' : 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          Cron
        </button>
      </div>

      <div style={{ flex: 1 }} />

      {providerModel && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
          }}
        >
          {providerModel}
        </span>
      )}
    </div>
  );
}
