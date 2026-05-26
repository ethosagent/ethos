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
  onDeleteSession: (id: string) => void;
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
  onDeleteSession,
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
            background: 'var(--bg-overlay)',
            border: 'none',
            fontFamily: 'var(--font-display)',
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--text-primary)',
            cursor: 'pointer',
          }}
        >
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
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeSessionId}
            onSelect={() => onSelectSession(s.id)}
            onRename={(title) => onRenameSession(s.id, title)}
            onFork={() => onForkSession(s.id)}
            onDelete={() => onDeleteSession(s.id)}
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
