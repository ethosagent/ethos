import type { Session } from '@ethosagent/web-contracts';
import { useCallback, useRef, useState } from 'react';
import { SessionRow } from '../chat/SessionRow';
import { useAppState } from '../state/AppContext';

export interface AppSidebarProps {
  route: string;
  onNavigate: (route: string) => void;
  backendConnected: boolean;
  sessions: Session[];
  pinnedSessions: Session[];
  loading: boolean;
  search: string;
  setSearch: (q: string) => void;
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  loadMore: () => void;
  hasMore: boolean;
  onRenameSession: (id: string, title: string) => void;
  onForkSession: (id: string) => void;
  onExportSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onPinSession: (id: string) => void;
  onUnpinSession: (id: string) => void;
}

interface NavItem {
  id: string;
  label: string;
  hint?: string;
  emoji: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'personalities', label: 'Personalities', emoji: '◎' },
  { id: 'skills', label: 'Skills', emoji: '⚡' },
  { id: 'plugins', label: 'Plugins', emoji: '⊕' },
  { id: 'mcp', label: 'MCP Servers', emoji: '⬡' },
  { id: 'memory', label: 'Memory', emoji: '🧠' },
  { id: 'platforms', label: 'Platforms', emoji: '⇄' },
];

const ADVANCED_ITEMS: NavItem[] = [
  { id: 'batch-eval', label: 'Batch / Eval', emoji: '⊞' },
  { id: 'kanban', label: 'Kanban', emoji: '▦' },
  { id: 'observability', label: 'Observability', emoji: '◈' },
  { id: 'mesh', label: 'Mesh', emoji: '⬡' },
  { id: 'api-keys', label: 'API Keys', emoji: '⚿' },
];

export function AppSidebar({
  route,
  onNavigate,
  backendConnected,
  sessions,
  pinnedSessions,
  loading,
  search,
  setSearch,
  activeSessionId,
  onSelectSession,
  onNewChat,
  loadMore,
  hasMore,
  onRenameSession,
  onForkSession,
  onExportSession,
  onDeleteSession,
  onPinSession,
  onUnpinSession,
}: AppSidebarProps) {
  const { state } = useAppState();
  const [hoveredNavId, setHoveredNavId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const unpinnedSessions = sessions.filter((s) => !s.pinned);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || !hasMore) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 40) {
      loadMore();
    }
  }, [hasMore, loadMore]);

  return (
    <nav
      style={{
        width: 240,
        minWidth: 240,
        height: '100%',
        backgroundColor: 'var(--bg-elevated)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          height: 48,
          minHeight: 48,
          display: 'flex',
          alignItems: 'center',
          padding: '0 14px',
          borderBottom: '1px solid var(--border-subtle)',
          gap: 8,
        }}
      >
        <svg
          aria-hidden="true"
          width={20}
          height={20}
          viewBox="0 0 16 16"
          style={{ flexShrink: 0 }}
        >
          <circle cx="8" cy="8" r="7" fill="#4A9EFF" />
          <circle cx="8" cy="8" r="3" fill="var(--bg-base, #0F0F0F)" />
        </svg>
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          Ethos
        </span>
      </div>

      {/* New session button */}
      <div style={{ padding: '8px 10px 0' }}>
        <button
          type="button"
          onClick={onNewChat}
          style={{
            width: '100%',
            height: 32,
            borderRadius: 'var(--radius-sm)',
            background: 'rgba(74, 158, 255, 0.1)',
            border: '1px solid rgba(74, 158, 255, 0.25)',
            fontFamily: 'var(--font-display)',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--info)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <svg
            aria-hidden="true"
            width={12}
            height={12}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
          >
            <line x1="6" y1="1" x2="6" y2="11" />
            <line x1="1" y1="6" x2="11" y2="6" />
          </svg>
          New session
        </button>
      </div>

      {/* Agent section label */}
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
          padding: '10px 12px 4px',
          fontFamily: 'var(--font-display)',
        }}
      >
        Agent
      </div>

      {/* Nav items */}
      {NAV_ITEMS.map((item) => (
        <NavRow
          key={item.id}
          item={item}
          active={route === item.id}
          hovered={hoveredNavId === item.id}
          onNavigate={onNavigate}
          onHover={setHoveredNavId}
        />
      ))}

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '6px 0' }} />

      {/* Search */}
      <div style={{ padding: '0 10px 4px', position: 'relative' }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sessions..."
          style={{
            width: '100%',
            height: 32,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-overlay)',
            border: '1px solid var(--border-subtle)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-primary)',
            padding: '0 28px 0 10px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            style={{
              position: 'absolute',
              right: 16,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              color: 'var(--text-tertiary)',
              fontSize: 14,
              cursor: 'pointer',
              padding: 0,
              lineHeight: 1,
            }}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* Session list */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
      >
        {pinnedSessions.length > 0 && (
          <>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-tertiary)',
                padding: '8px 10px 2px',
                fontFamily: 'var(--font-display)',
              }}
            >
              Pinned
            </div>
            {pinnedSessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                onSelect={() => onSelectSession(s.id)}
                onRename={(title) => onRenameSession(s.id, title)}
                onFork={() => onForkSession(s.id)}
                onExport={() => onExportSession(s.id)}
                onDelete={() => onDeleteSession(s.id)}
                onPin={() => onPinSession(s.id)}
                onUnpin={() => onUnpinSession(s.id)}
              />
            ))}
          </>
        )}

        {unpinnedSessions.length > 0 && (
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
              padding: '8px 10px 2px',
              fontFamily: 'var(--font-display)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            Sessions
            <span
              style={{
                fontSize: 9,
                fontWeight: 600,
                background: 'var(--bg-overlay)',
                color: 'var(--text-tertiary)',
                borderRadius: 'var(--radius-sm)',
                padding: '1px 5px',
                lineHeight: '14px',
              }}
            >
              {unpinnedSessions.length}
            </span>
          </div>
        )}
        {unpinnedSessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeSessionId}
            onSelect={() => onSelectSession(s.id)}
            onRename={(title) => onRenameSession(s.id, title)}
            onFork={() => onForkSession(s.id)}
            onExport={() => onExportSession(s.id)}
            onDelete={() => onDeleteSession(s.id)}
            onPin={() => onPinSession(s.id)}
            onUnpin={() => onUnpinSession(s.id)}
          />
        ))}

        {sessions.length === 0 && !loading && !search && (
          <div
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              fontFamily: 'var(--font-display)',
              fontSize: 13,
              color: 'var(--text-tertiary)',
              lineHeight: 1.5,
            }}
          >
            No sessions yet. Start a conversation.
          </div>
        )}

        {sessions.length === 0 && !loading && search && (
          <div
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              fontFamily: 'var(--font-display)',
              fontSize: 13,
              color: 'var(--text-tertiary)',
              lineHeight: 1.5,
            }}
          >
            No sessions match &apos;{search}&apos;.
          </div>
        )}

        {loading && (
          <div
            style={{
              padding: '12px 16px',
              textAlign: 'center',
              fontFamily: 'var(--font-display)',
              fontSize: 12,
              color: 'var(--text-tertiary)',
            }}
          >
            Loading...
          </div>
        )}

        {hasMore && !loading && sessions.length > 0 && (
          <button
            type="button"
            onClick={loadMore}
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 10px',
              fontFamily: 'var(--font-display)',
              fontSize: 12,
              color: 'var(--info)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            View all sessions →
          </button>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {state.advancedMode && (
          <>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-tertiary)',
                padding: '8px 12px 4px',
                fontFamily: 'var(--font-display)',
              }}
            >
              Lab
            </div>
            {ADVANCED_ITEMS.map((item) => (
              <NavRow
                key={item.id}
                item={item}
                active={route === item.id}
                hovered={hoveredNavId === item.id}
                onNavigate={onNavigate}
                onHover={setHoveredNavId}
              />
            ))}
          </>
        )}

        <NavRow
          item={{
            id: 'settings',
            label: 'Settings',
            emoji: '⚙',
          }}
          active={route === 'settings'}
          hovered={hoveredNavId === 'settings'}
          onNavigate={onNavigate}
          onHover={setHoveredNavId}
        />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px 8px',
          }}
        >
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: backendConnected ? 'var(--success)' : 'var(--error)',
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
            {backendConnected ? 'connected' : 'disconnected'}
          </span>
        </div>
      </div>
    </nav>
  );
}

interface NavRowProps {
  item: NavItem;
  active: boolean;
  hovered: boolean;
  onNavigate: (route: string) => void;
  onHover: (id: string | null) => void;
}

function NavRow({ item, active, hovered, onNavigate, onHover }: NavRowProps) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(item.id)}
      onMouseEnter={() => onHover(item.id)}
      onMouseLeave={() => onHover(null)}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 36,
        padding: active ? '0 12px 0 10px' : '0 12px',
        gap: 8,
        background: active
          ? 'rgba(74, 158, 255, 0.18)'
          : hovered
            ? 'var(--ethos-hover)'
            : 'transparent',
        border: 'none',
        borderLeftWidth: 2,
        borderLeftStyle: 'solid',
        borderLeftColor: active ? 'var(--info)' : 'transparent',
        color: active ? 'var(--info)' : 'var(--text-secondary)',
        cursor: 'pointer',
        width: '100%',
        textAlign: 'left',
        font: 'inherit',
        transition: 'background-color var(--motion-fast) var(--ease)',
      }}
    >
      <span style={{ flexShrink: 0, fontSize: 14, lineHeight: 1, width: 18, textAlign: 'center' }}>
        {item.emoji}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 13,
            fontWeight: 400,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.label}
        </span>
        {item.hint && (
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 10,
              color: 'var(--text-tertiary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginTop: -2,
            }}
          >
            {item.hint}
          </span>
        )}
      </span>
    </button>
  );
}
