import React, { useState } from 'react';
import { useAppState } from '../state/AppContext';

interface AppSidebarProps {
  route: string;
  onNavigate: (route: string) => void;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  backendConnected: boolean;
}

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const DEFAULT_ITEMS: NavItem[] = [
  {
    id: 'chat',
    label: 'Chat',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 2H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1Z"/>
      </svg>
    ),
  },
  {
    id: 'personalities',
    label: 'Personalities',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="6" r="3"/>
        <path d="M2 16c0-3.314 3.134-6 7-6s7 2.686 7 6"/>
      </svg>
    ),
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 3C7 3 5.5 4 5 5.5c-.8.1-2.5.8-2.5 2.5S4 10 5 10c-.2.6-.3 1.3 0 2 .3.7 1 1 1.5 1H9m0-10c2 0 3.5 1 4 2.5.8.1 2.5.8 2.5 2.5S14 10 13 10c.2.6.3 1.3 0 2-.3.7-1 1-1.5 1H9m0-10v10"/>
      </svg>
    ),
  },
  {
    id: 'cron',
    label: 'Cron',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="9" r="7"/>
        <polyline points="9,5 9,9 12,11"/>
      </svg>
    ),
  },
  {
    id: 'activity',
    label: 'Activity',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="11" width="3" height="5" rx="1"/>
        <rect x="7.5" y="7" width="3" height="9" rx="1"/>
        <rect x="13" y="3" width="3" height="13" rx="1"/>
      </svg>
    ),
  },
  {
    id: 'platforms',
    label: 'Platforms',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="9" r="7"/>
        <path d="M2 9h14M9 2c-2 2-3 4.5-3 7s1 5 3 7M9 2c2 2 3 4.5 3 7s-1 5-3 7"/>
      </svg>
    ),
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="11,2 6,10 10,10 7,16 13,7 9,7 11,2"/>
      </svg>
    ),
  },
  {
    id: 'mcp',
    label: 'MCP',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <polygon points="9,2 15.5,5.5 15.5,12.5 9,16 2.5,12.5 2.5,5.5"/>
        <line x1="9" y1="6" x2="9" y2="12"/>
        <line x1="6" y1="7.5" x2="12" y2="10.5"/>
        <line x1="12" y1="7.5" x2="6" y2="10.5"/>
      </svg>
    ),
  },
  {
    id: 'plugins',
    label: 'Plugins',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2v4M12 2v4M5 6h8l-1 5a3 3 0 0 1-6 0L5 6Z"/>
        <line x1="9" y1="11" x2="9" y2="16"/>
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="9" r="2.5"/>
        <path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.4 3.4l1.4 1.4M13.2 13.2l1.4 1.4M3.4 14.6l1.4-1.4M13.2 4.8l1.4-1.4"/>
      </svg>
    ),
  },
];

const ADVANCED_ITEMS: NavItem[] = [
  {
    id: 'batch-eval',
    label: 'Batch / Eval',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="2" width="12" height="14" rx="1.5"/>
        <line x1="6" y1="7" x2="12" y2="7"/>
        <line x1="6" y1="10" x2="12" y2="10"/>
        <line x1="6" y1="13" x2="9" y2="13"/>
      </svg>
    ),
  },
  {
    id: 'kanban',
    label: 'Kanban',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <rect x="1" y="2" width="4" height="8" rx="1"/>
        <rect x="7" y="2" width="4" height="11" rx="1"/>
        <rect x="13" y="2" width="4" height="6" rx="1"/>
      </svg>
    ),
  },
  {
    id: 'observability',
    label: 'Observability',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 11 L5 7 L9 9 L13 5 L17 8"/>
        <circle cx="17" cy="8" r="1.2" fill="currentColor" stroke="none"/>
      </svg>
    ),
  },
  {
    id: 'mesh',
    label: 'Mesh',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
        <circle cx="4" cy="9" r="2"/>
        <circle cx="14" cy="4" r="2"/>
        <circle cx="14" cy="14" r="2"/>
        <line x1="6" y1="8" x2="12" y2="5"/>
        <line x1="6" y1="10" x2="12" y2="13"/>
      </svg>
    ),
  },
  {
    id: 'api-keys',
    label: 'API Keys',
    icon: (
      <svg aria-hidden="true" width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7" cy="8" r="4"/>
        <line x1="10.8" y1="11" x2="17" y2="16"/>
        <line x1="14" y1="13.5" x2="15.5" y2="12"/>
      </svg>
    ),
  },
];

export function AppSidebar({
  route,
  onNavigate,
  drawerOpen,
  onToggleDrawer,
  backendConnected,
}: AppSidebarProps) {
  const { state } = useAppState();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <nav
      style={{
        width: 64,
        minWidth: 64,
        height: '100%',
        backgroundColor: 'var(--bg-elevated)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 12,
        gap: 4,
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      {DEFAULT_ITEMS.map((item) => (
        <React.Fragment key={item.id}>
          {(item.id === 'cron' || item.id === 'platforms') && (
            <div
              style={{
                width: 32,
                height: 1,
                background: 'var(--border-subtle)',
                margin: '4px 0',
              }}
            />
          )}
          <SidebarItem
            item={item}
            active={route === item.id}
            hovered={hoveredId === item.id}
            onNavigate={onNavigate}
            onHover={setHoveredId}
          />
        </React.Fragment>
      ))}

      <div style={{ marginTop: 'auto', paddingBottom: 8 }}>
        <div
          style={{
            width: 40,
            height: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          title={backendConnected ? 'Backend connected' : 'Backend disconnected'}
        >
          <div
            style={{
              position: 'relative',
              width: 24,
              height: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                position: 'absolute',
                width: 20,
                height: 20,
                borderRadius: '50%',
                border: `1.5px solid ${backendConnected ? 'rgba(74, 222, 128, 0.4)' : 'rgba(248, 113, 113, 0.3)'}`,
              }}
            />
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: backendConnected ? '#4ADE80' : '#F87171',
                position: 'relative',
              }}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleDrawer}
          style={{
            width: 40,
            height: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            background: drawerOpen ? 'var(--bg-overlay)' : 'transparent',
            color: drawerOpen ? 'var(--accent)' : 'var(--text-tertiary)',
            cursor: 'pointer',
          }}
          aria-label="Toggle activity drawer"
          title="Activity drawer"
        >
          <svg aria-hidden="true" width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
            <line x1="2" y1="4" x2="14" y2="4"/>
            <line x1="2" y1="8" x2="14" y2="8"/>
            <line x1="2" y1="12" x2="14" y2="12"/>
          </svg>
        </button>
      </div>

      {state.advancedMode && (
        <>
          <div
            style={{
              width: 32,
              height: 1,
              backgroundColor: 'var(--border-subtle)',
              margin: '8px 0',
            }}
          />
          <div
            style={{
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              marginBottom: 4,
            }}
          >
            LAB
          </div>
          {ADVANCED_ITEMS.map((item) => (
            <SidebarItem
              key={item.id}
              item={item}
              active={route === item.id}
              hovered={hoveredId === item.id}
              onNavigate={onNavigate}
              onHover={setHoveredId}
            />
          ))}
        </>
      )}
    </nav>
  );
}

interface SidebarItemProps {
  item: NavItem;
  active: boolean;
  hovered: boolean;
  onNavigate: (route: string) => void;
  onHover: (id: string | null) => void;
}

function SidebarItem({ item, active, hovered, onNavigate, onHover }: SidebarItemProps) {
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => onNavigate(item.id)}
        onMouseEnter={() => onHover(item.id)}
        onMouseLeave={() => onHover(null)}
        style={{
          width: 40,
          height: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          background: active
            ? 'rgba(74, 158, 255, 0.18)'
            : hovered
              ? 'var(--ethos-hover)'
              : 'transparent',
          color: active ? 'var(--info)' : 'var(--text-secondary)',
          cursor: 'pointer',
          position: 'relative',
          transition: `background-color var(--motion-fast) var(--ease), color var(--motion-fast) var(--ease)`,
        }}
        aria-label={item.label}
      >
        {active && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 2,
              height: 16,
              backgroundColor: 'var(--info)',
              borderRadius: 1,
            }}
          />
        )}
        {item.icon}
      </button>
      {hovered && (
        <div
          style={{
            position: 'absolute',
            left: 52,
            top: '50%',
            transform: 'translateY(-50%)',
            backgroundColor: 'var(--bg-overlay)',
            color: 'var(--text-primary)',
            fontSize: 11,
            fontWeight: 500,
            padding: '4px 8px',
            borderRadius: 'var(--radius-sm)',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 100,
            border: '1px solid var(--border-subtle)',
          }}
        >
          {item.label}
        </div>
      )}
    </div>
  );
}
