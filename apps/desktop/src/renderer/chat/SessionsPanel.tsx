import type { Session } from '@ethosagent/web-contracts';
import { useCallback, useRef } from 'react';
import { SessionRow } from './SessionRow';

interface SessionsPanelProps {
  sessions: Session[];
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

export function SessionsPanel({
  sessions,
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
}: SessionsPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || !hasMore) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 40) {
      loadMore();
    }
  }, [hasMore, loadMore]);

  const pinned = sessions.filter((s) => s.pinned);
  const unpinned = sessions.filter((s) => !s.pinned);
  const isEmpty = sessions.length === 0 && !loading;

  return (
    <div
      style={{
        width: 240,
        height: '100%',
        background: 'var(--bg-elevated)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <div style={{ padding: '8px 10px 0' }}>
        <button
          type="button"
          onClick={onNewChat}
          style={{
            width: '100%',
            height: 32,
            borderRadius: 'var(--radius-sm)',
            background: 'rgba(74, 158, 255, 0.15)',
            border: '1px solid rgba(74, 158, 255, 0.3)',
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
          New chat
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: '8px 10px', position: 'relative' }}>
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
      <div ref={listRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto' }}>
        {pinned.length > 0 && (
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
            {pinned.map((s) => (
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
            {unpinned.length > 0 && (
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
                Recent
              </div>
            )}
          </>
        )}
        {unpinned.map((s) => (
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

        {isEmpty && !search && (
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

        {isEmpty && search && (
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
      </div>
    </div>
  );
}
