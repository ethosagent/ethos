import { useCallback, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useConfig } from '../features/config/api/queries';
import { useRecentSessions } from '../features/sessions/api/queries';
import { PersonalityPickerModal } from './PersonalityPickerModal';
import { SessionContextMenu } from './SessionContextMenu';
import { StatusDot } from './ui/StatusDot';

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

const SIDEBAR_SESSION_LIMIT = 20;

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const activeSessionId = searchParams.get('session');
  const [sessionSearch, setSessionSearch] = useState('');
  const [advancedMode, setAdvancedMode] = useState(() => {
    try {
      return localStorage.getItem('ethos:sidebar:advanced') === 'true';
    } catch {
      return false;
    }
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    sessionId: string;
    pinned: boolean;
    x: number;
    y: number;
  } | null>(null);

  const toggleAdvancedMode = () => {
    setAdvancedMode((v) => {
      const next = !v;
      try {
        localStorage.setItem('ethos:sidebar:advanced', String(next));
      } catch {}
      return next;
    });
  };

  const { data: sessionsData } = useRecentSessions(SIDEBAR_SESSION_LIMIT);
  const { error: configError, isLoading: configLoading } = useConfig();

  const sessions = sessionsData?.items ?? [];
  const pinned = useMemo(() => sessions.filter((s) => s.pinned), [sessions]);
  const unpinned = useMemo(() => sessions.filter((s) => !s.pinned), [sessions]);

  const filteredPinned = useMemo(
    () =>
      sessionSearch
        ? pinned.filter((s) =>
            (s.title ?? s.key).toLowerCase().includes(sessionSearch.toLowerCase()),
          )
        : pinned,
    [pinned, sessionSearch],
  );
  const filteredUnpinned = useMemo(
    () =>
      sessionSearch
        ? unpinned.filter((s) =>
            (s.title ?? s.key).toLowerCase().includes(sessionSearch.toLowerCase()),
          )
        : unpinned,
    [unpinned, sessionSearch],
  );

  const connectionState: 'connected' | 'connecting' | 'offline' = configLoading
    ? 'connecting'
    : configError
      ? 'offline'
      : 'connected';

  const handleSessionContextMenu = useCallback(
    (e: React.MouseEvent, sessionId: string, isPinned: boolean) => {
      e.preventDefault();
      setContextMenu({ sessionId, pinned: isPinned, x: e.clientX, y: e.clientY });
    },
    [],
  );

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

      {!collapsed && (
        <>
          <button
            type="button"
            className="sidebar-new-btn sidebar-new-btn--dashed"
            onClick={() => setPickerOpen(true)}
          >
            + New session
          </button>

          <div className="sidebar-section-label">Agent</div>
          <div className="sidebar-nav">
            <NavRow
              path="/personalities"
              label="Personalities"
              active={pathname === '/personalities' || pathname.startsWith('/personalities/')}
            />
            <NavRow path="/skills" label="Skills" active={pathname === '/skills'} />
            <NavRow
              path="/plugins"
              label="Plugins"
              active={pathname === '/plugins' || pathname.startsWith('/plugins/')}
            />
            <NavRow path="/mcp" label="MCP Servers" active={pathname === '/mcp'} />
            <NavRow path="/memory" label="Brain" active={pathname === '/memory'} />
            <NavRow path="/cron" label="Cron" active={pathname === '/cron'} />
            <NavRow
              path="/communications"
              label="Platforms"
              active={pathname === '/communications'}
            />
          </div>

          <div className="sidebar-divider" />

          <input
            type="text"
            className="sidebar-search-input"
            placeholder="Filter sessions..."
            value={sessionSearch}
            onChange={(e) => setSessionSearch(e.target.value)}
          />

          <div className="sidebar-session-list">
            {filteredPinned.length > 0 && (
              <>
                <div className="sidebar-section-label">PINNED</div>
                {filteredPinned.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={activeSessionId === s.id}
                    pinned
                    onContextMenu={handleSessionContextMenu}
                  />
                ))}
              </>
            )}

            <div className="sidebar-section-label">
              SESSIONS <span className="sidebar-session-count">{filteredUnpinned.length}</span>
            </div>
            {filteredUnpinned.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={activeSessionId === s.id}
                pinned={false}
                onContextMenu={handleSessionContextMenu}
              />
            ))}

            <Link to="/sessions" className="sidebar-view-all">
              View all sessions →
            </Link>
          </div>

          {advancedMode && (
            <>
              <div className="sidebar-section-label">LAB</div>
              <div className="sidebar-nav">
                <NavRow
                  path="/batch"
                  label="Batch / Eval"
                  active={pathname === '/batch' || pathname === '/eval'}
                />
                <NavRow path="/activity" label="Observability" active={pathname === '/activity'} />
                <NavRow path="/mesh" label="Mesh" active={pathname === '/mesh'} />
                <NavRow
                  path="/teams"
                  label="Teams"
                  active={pathname === '/teams' || pathname.startsWith('/teams/')}
                />
              </div>
            </>
          )}

          <div className="sidebar-footer">
            <NavRow path="/settings" label="Settings" active={pathname === '/settings'} />
            <button
              type="button"
              className="sidebar-advanced-toggle-btn"
              onClick={toggleAdvancedMode}
            >
              {advancedMode ? 'Simple' : 'Advanced'}
            </button>
            <StatusDot status={connectionState} size={6} />
          </div>
        </>
      )}

      {collapsed && (
        <div className="sidebar-nav">
          <Link
            to="/chat"
            className={`sidebar-nav-item${pathname === '/chat' ? ' active' : ''}`}
            title="Chat"
          >
            <ChatIcon />
          </Link>
          <Link
            to="/personalities"
            className={`sidebar-nav-item${pathname === '/personalities' || pathname.startsWith('/personalities/') ? ' active' : ''}`}
            title="Personalities"
          >
            <PersonalityIcon />
          </Link>
          <Link
            to="/sessions"
            className={`sidebar-nav-item${pathname === '/sessions' ? ' active' : ''}`}
            title="Sessions"
          >
            <SessionsIcon />
          </Link>
          <Link
            to="/settings"
            className={`sidebar-nav-item${pathname === '/settings' ? ' active' : ''}`}
            title="Settings"
          >
            <SettingsIcon />
          </Link>
        </div>
      )}

      <PersonalityPickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} />
      {contextMenu && (
        <SessionContextMenu
          sessionId={contextMenu.sessionId}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          pinned={contextMenu.pinned}
          onClose={() => setContextMenu(null)}
          onRename={() => {
            // Rename handled inline — close menu for now
            setContextMenu(null);
          }}
        />
      )}
    </nav>
  );
}

function NavRow({
  path,
  label,
  hint,
  active,
}: {
  path: string;
  label: string;
  hint?: string;
  active: boolean;
}) {
  return (
    <Link to={path} className={`sidebar-nav-item${active ? ' active' : ''}`}>
      <span className="sidebar-nav-label">{label}</span>
      {hint ? <span className="sidebar-nav-hint">{hint}</span> : null}
    </Link>
  );
}

function SessionRow({
  session,
  active,
  pinned,
  onContextMenu,
}: {
  session: { id: string; title: string | null; key: string; updatedAt: string; pinned: boolean };
  active: boolean;
  pinned: boolean;
  onContextMenu: (e: React.MouseEvent, sessionId: string, pinned: boolean) => void;
}) {
  const label = session.title ?? 'Untitled session';
  const time = formatRelativeTime(session.updatedAt);
  return (
    <Link
      to={`/chat?session=${session.id}`}
      className={`sidebar-session-row${active ? ' active' : ''}`}
      onContextMenu={(e) => onContextMenu(e, session.id, pinned)}
    >
      {pinned ? (
        <span className="sidebar-session-pin" role="img" aria-label="Pinned">
          ★
        </span>
      ) : null}
      <span className="sidebar-session-name">{label}</span>
      <span className="sidebar-session-time">{time}</span>
    </Link>
  );
}

function formatRelativeTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function EthosMark() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
      <path
        fill="#4A9EFF"
        fillRule="evenodd"
        d="M8 1 A7 7 0 1 1 8 15 A7 7 0 1 1 8 1 Z M8 5.5 A2.5 2.5 0 1 0 8 10.5 A2.5 2.5 0 1 0 8 5.5 Z"
      />
    </svg>
  );
}

function ChatIcon() {
  return (
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
  );
}

function PersonalityIcon() {
  return (
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
  );
}

function SessionsIcon() {
  return (
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
  );
}

function SettingsIcon() {
  return (
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
  );
}
