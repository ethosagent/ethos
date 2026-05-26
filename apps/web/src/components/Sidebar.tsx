import type React from 'react';
import { Link, useLocation } from 'react-router-dom';

// Grouped nav per the IA in plan/phases/26-web-ui.md ("Information
// architecture"). v0 only lights up Talk-group items; the rest are stubs
// rendered as disabled rows so the structure is visible from day one
// (the "control plane lives here too" promise) while tabs land later.

interface NavItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  hint?: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Talk',
    items: [
      {
        key: '/chat',
        label: 'Chat',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="1" y="1" width="14" height="11" rx="2.5" />
            <path d="M4 15 L5.5 12 H10.5 L12 15" />
          </svg>
        ),
      },
      {
        key: '/sessions',
        label: 'Sessions',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="3.5" cy="4.5" r="1" />
            <line x1="6.5" y1="4.5" x2="14" y2="4.5" />
            <circle cx="3.5" cy="8" r="1" />
            <line x1="6.5" y1="8" x2="14" y2="8" />
            <circle cx="3.5" cy="11.5" r="1" />
            <line x1="6.5" y1="11.5" x2="14" y2="11.5" />
          </svg>
        ),
      },
    ],
  },
  {
    title: 'Agent',
    items: [
      {
        key: '/personalities',
        label: 'Personalities',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="8" cy="5" r="2.5" />
            <path d="M2.5 14 C2.5 11 5 9.5 8 9.5 C11 9.5 13.5 11 13.5 14" />
          </svg>
        ),
      },
      {
        key: '/skills',
        label: 'Skills',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 1 L6 9 H10 L7 15" />
          </svg>
        ),
      },
      {
        key: '/memory',
        label: 'Memory',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 1 C5 1 3 3.5 3.5 6 C3 6.5 2.5 7.5 3 8.5 C2.5 9.5 3 11 4 11.5 C4.5 13.5 6 15 8 15 C10 15 11.5 13.5 12 11.5 C13 11 13.5 9.5 13 8.5 C13.5 7.5 13 6.5 12.5 6 C13 3.5 11 1 8 1Z" />
          </svg>
        ),
      },
    ],
  },
  {
    title: 'Ops',
    items: [
      {
        key: '/activity',
        label: 'Activity',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="1" y="9" width="3" height="6" rx="1" />
            <rect x="6.5" y="5" width="3" height="10" rx="1" />
            <rect x="12" y="1" width="3" height="14" rx="1" />
          </svg>
        ),
      },
      {
        key: '/cron',
        label: 'Cron',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="6.5" />
            <line x1="8" y1="4" x2="8" y2="8" />
            <line x1="8" y1="8" x2="11" y2="10" />
          </svg>
        ),
      },
      {
        key: '/communications',
        label: 'Communications',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="1" y="3.5" width="14" height="10" rx="2" />
            <path d="M1 6 L8 9.5 L15 6" />
          </svg>
        ),
      },
      {
        key: '/mesh',
        label: 'Mesh',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="3.5" cy="8" r="2" />
            <circle cx="12.5" cy="3.5" r="2" />
            <circle cx="12.5" cy="12.5" r="2" />
            <line x1="5.4" y1="7" x2="10.6" y2="4.4" />
            <line x1="5.4" y1="9" x2="10.6" y2="11.6" />
          </svg>
        ),
      },
      {
        key: '/teams',
        label: 'Teams',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="5.5" cy="6" r="2.5" />
            <circle cx="10.5" cy="6" r="2.5" />
            <path d="M1 14 C1 11.5 3 10 5.5 10" />
            <path d="M15 14 C15 11.5 13 10 10.5 10" />
            <path d="M5.5 10 C6.5 11 9.5 11 10.5 10" />
          </svg>
        ),
      },
    ],
  },
  {
    title: 'Lab',
    items: [
      {
        key: '/batch',
        label: 'Batch',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="2" width="12" height="12" rx="1.5" />
            <line x1="5" y1="6" x2="11" y2="6" />
            <line x1="5" y1="8" x2="11" y2="8" />
            <line x1="5" y1="10" x2="8" y2="10" />
          </svg>
        ),
      },
      {
        key: '/eval',
        label: 'Eval',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="2,8 6,12 14,4" />
          </svg>
        ),
      },
    ],
  },
  {
    title: 'System',
    items: [
      {
        key: '/plugins',
        label: 'Plugins',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="4" y="2" width="8" height="10" rx="1" />
            <line x1="7" y1="1" x2="7" y2="2" />
            <line x1="9" y1="1" x2="9" y2="2" />
            <line x1="8" y1="12" x2="8" y2="15" />
            <line x1="6" y1="14.5" x2="10" y2="14.5" />
          </svg>
        ),
      },
      {
        key: '/settings',
        label: 'Settings',
        icon: (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="2.5" />
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 1.5 L8 3 M14.5 8 L13 8 M8 14.5 L8 13 M1.5 8 L3 8" />
            <path d="M12.2 3.8 L11.1 4.9 M12.2 12.2 L11.1 11.1 M3.8 12.2 L4.9 11.1 M3.8 3.8 L4.9 4.9" />
          </svg>
        ),
      },
    ],
  },
];

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { pathname } = useLocation();
  return (
    <nav className="sidebar" aria-label="Primary navigation">
      <button
        type="button"
        className="sidebar-header"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
        style={{ background: 'none', border: 'none', color: 'inherit', textAlign: 'left' }}
      >
        <EthosMark />
        <span className="sidebar-header-title">Ethos</span>
      </button>

      {NAV_GROUPS.map((group) => (
        <div key={group.title}>
          <div className="sidebar-nav-section">{group.title}</div>
          <div className="sidebar-nav">
            {group.items.map((item) => (
              <NavRow
                key={item.key}
                item={item}
                active={pathname === item.key || pathname.startsWith(`${item.key}/`)}
                collapsed={collapsed}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function NavRow({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const className = `sidebar-nav-item${active ? ' active' : ''}`;
  const titleText = collapsed
    ? item.label
    : item.disabled
      ? `${item.label} — ships in ${item.hint}`
      : undefined;

  if (item.disabled) {
    return (
      <span
        className={className}
        title={titleText}
        style={{ opacity: 0.5, cursor: 'not-allowed' }}
        aria-disabled="true"
      >
        {item.icon ?? null}
        {!collapsed ? <span className="sidebar-nav-label">{item.label}</span> : null}
        {!collapsed && item.hint ? (
          <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.7 }}>{item.hint}</span>
        ) : null}
      </span>
    );
  }
  return (
    <Link to={item.key} className={className} title={titleText}>
      {item.icon ?? null}
      {!collapsed ? <span className="sidebar-nav-label">{item.label}</span> : null}
    </Link>
  );
}

function EthosMark() {
  // Placeholder mark — replaced by the generative deterministic SVG when
  // 26.W2 wires per-personality marks (plan: "Personality avatar:
  // generative deterministic SVG mark").
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 22 22" style={{ flexShrink: 0 }}>
      <rect x="1" y="1" width="20" height="20" rx="6" fill="#4A9EFF" />
      <path
        d="M7 11.5l3 3 5-6"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
