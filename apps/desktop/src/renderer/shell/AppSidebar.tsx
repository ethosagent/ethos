import { useState } from 'react';
import { useAppState } from '../state/AppContext';

interface AppSidebarProps {
  route: string;
  onNavigate: (route: string) => void;
}

interface NavItem {
  id: string;
  label: string;
  icon: string;
}

const DEFAULT_ITEMS: NavItem[] = [
  { id: 'chat', label: 'Chat', icon: '✉' },
  { id: 'personalities', label: 'Personalities', icon: '☺' },
  { id: 'memory', label: 'Memory', icon: '☁' },
  { id: 'cron', label: 'Cron', icon: '⏰' },
  { id: 'platforms', label: 'Platforms', icon: '⭐' },
  { id: 'skills', label: 'Skills', icon: '⚡' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

const ADVANCED_ITEMS: NavItem[] = [
  { id: 'batch-eval', label: 'Batch / Eval', icon: '☷' },
  { id: 'kanban', label: 'Kanban', icon: '░' },
  { id: 'observability', label: 'Observability', icon: '⚒' },
  { id: 'mesh', label: 'Mesh', icon: '⬢' },
  { id: 'api-keys', label: 'API Keys', icon: '⚿' },
];

export function AppSidebar({ route, onNavigate }: AppSidebarProps) {
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
        <SidebarItem
          key={item.id}
          item={item}
          active={route === item.id}
          hovered={hoveredId === item.id}
          onNavigate={onNavigate}
          onHover={setHoveredId}
        />
      ))}

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
          background: active ? 'var(--bg-overlay)' : 'transparent',
          color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
          fontSize: 20,
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
              left: -12,
              top: 8,
              width: 2,
              height: 24,
              backgroundColor: 'var(--accent)',
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
