import { useState } from 'react';
import { StatusDot } from '../ui/StatusDot';

interface StatusBarProps {
  backendConnected: boolean;
  providerModel: string;
  onNavigate: (route: string) => void;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  personalityName?: string;
}

export function StatusBar({
  backendConnected,
  providerModel,
  onNavigate,
  drawerOpen,
  onToggleDrawer,
  sidebarCollapsed,
  onToggleSidebar,
  personalityName,
}: StatusBarProps) {
  const [hoveredPill, setHoveredPill] = useState<string | null>(null);

  // Split providerModel into personality name and model for right-side display
  const modelDisplay = providerModel || '';

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
      {/* Left: StatusDot + status text */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StatusDot color={backendConnected ? '#4ADE80' : '#F87171'} />
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

      {/* Separator */}
      <div
        style={{
          width: 1,
          height: 12,
          background: 'var(--border-subtle)',
          flexShrink: 0,
        }}
      />

      {/* Activity + Cron buttons */}
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

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Sidebar toggle */}
      <button
        type="button"
        onClick={onToggleSidebar}
        onMouseEnter={() => setHoveredPill('sidebar')}
        onMouseLeave={() => setHoveredPill(null)}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-secondary)',
          background: !sidebarCollapsed
            ? 'var(--bg-overlay)'
            : hoveredPill === 'sidebar'
              ? 'var(--bg-overlay)'
              : 'transparent',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          padding: '2px 6px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
        }}
        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
      >
        <svg
          aria-hidden="true"
          width={14}
          height={14}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="1" y="2" width="14" height="12" rx="1.5" />
          <line x1="5.5" y1="2" x2="5.5" y2="14" />
        </svg>
      </button>

      {/* Drawer toggle */}
      <button
        type="button"
        onClick={onToggleDrawer}
        onMouseEnter={() => setHoveredPill('drawer')}
        onMouseLeave={() => setHoveredPill(null)}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-secondary)',
          background: drawerOpen
            ? 'var(--bg-overlay)'
            : hoveredPill === 'drawer'
              ? 'var(--bg-overlay)'
              : 'transparent',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          padding: '2px 6px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
        }}
        aria-label="Toggle drawer"
      >
        <svg
          aria-hidden="true"
          width={14}
          height={14}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        >
          <line x1="3" y1="4" x2="13" y2="4" />
          <line x1="3" y1="8" x2="13" y2="8" />
          <line x1="3" y1="12" x2="13" y2="12" />
        </svg>
      </button>

      {/* Right: personality name + model in mono */}
      {(personalityName || modelDisplay) && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
          }}
        >
          {personalityName && modelDisplay
            ? `${personalityName} · ${modelDisplay}`
            : (personalityName ?? modelDisplay)}
        </span>
      )}
    </div>
  );
}
