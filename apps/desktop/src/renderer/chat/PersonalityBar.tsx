import { useCallback, useEffect, useRef, useState } from 'react';

interface PersonalityBarProps {
  personalityId: string | null;
  sessionTitle: string | null;
  onTitleChange: (title: string) => void;
  onNewSession: () => void;
  onForkSession: () => void;
  streaming: boolean;
  showSessionsButton?: boolean;
  onToggleSessions?: () => void;
}

function getInitials(id: string | null): string {
  if (!id) return '?';
  return id.slice(0, 2).toUpperCase();
}

export function PersonalityBar({
  personalityId,
  sessionTitle,
  onTitleChange,
  onNewSession,
  onForkSession,
  streaming,
  showSessionsButton,
  onToggleSessions,
}: PersonalityBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const titleText = sessionTitle ?? 'New session';

  const handleTitleClick = useCallback(() => {
    if (streaming) return;
    setTitleDraft(sessionTitle ?? '');
    setEditingTitle(true);
  }, [streaming, sessionTitle]);

  const handleTitleCommit = useCallback(() => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== sessionTitle) {
      onTitleChange(trimmed);
    }
    setEditingTitle(false);
  }, [titleDraft, sessionTitle, onTitleChange]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleTitleCommit();
      else if (e.key === 'Escape') setEditingTitle(false);
    },
    [handleTitleCommit],
  );

  useEffect(() => {
    if (editingTitle && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTitle]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  return (
    <div
      style={{
        height: 36,
        width: '100%',
        background: 'var(--bg-elevated)',
        borderBottom: '2px solid var(--accent)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 10,
        flexShrink: 0,
      }}
    >
      {/* Sessions toggle (narrow) */}
      {showSessionsButton && onToggleSessions && (
        <button
          type="button"
          onClick={onToggleSessions}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary)',
            fontSize: 16,
            cursor: 'pointer',
            padding: '0 4px',
            lineHeight: 1,
          }}
          aria-label="Toggle sessions panel"
        >
          ☰
        </button>
      )}

      {/* Personality mark */}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: 'var(--bg-overlay)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-secondary)',
          }}
        >
          {getInitials(personalityId)}
        </span>
      </div>

      {/* Personality name */}
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 14,
          fontWeight: 500,
          color: 'var(--text-primary)',
          flexShrink: 0,
        }}
      >
        {personalityId ?? 'Default'}
      </span>

      {/* Model name placeholder */}
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-tertiary)',
          flexShrink: 0,
        }}
      >
        {''}
      </span>

      {/* Spacer */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 0 }}>
        {editingTitle ? (
          <input
            ref={inputRef}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={handleTitleKeyDown}
            onBlur={handleTitleCommit}
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 13,
              fontWeight: 400,
              color: 'var(--text-primary)',
              background: 'var(--bg-overlay)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px 8px',
              outline: 'none',
              textAlign: 'center',
              maxWidth: 280,
              width: '100%',
            }}
          />
        ) : (
          <button
            type="button"
            tabIndex={0}
            onClick={handleTitleClick}
            onKeyDown={(e) => e.key === 'Enter' && handleTitleClick()}
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 13,
              fontWeight: 400,
              color: 'var(--text-secondary)',
              cursor: streaming ? 'default' : 'pointer',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 280,
              background: 'none',
              border: 'none',
              padding: 0,
            }}
          >
            {titleText}
          </button>
        )}
      </div>

      {/* Menu button */}
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary)',
            fontSize: 18,
            cursor: 'pointer',
            padding: '0 4px',
            lineHeight: 1,
          }}
          aria-label="Session menu"
        >
          ⋮
        </button>
        {menuOpen && (
          <div
            ref={menuRef}
            style={{
              position: 'absolute',
              top: 28,
              right: 0,
              zIndex: 20,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
              minWidth: 140,
            }}
          >
            <button
              type="button"
              tabIndex={-1}
              onClick={() => {
                setMenuOpen(false);
                onForkSession();
              }}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 14px',
                fontFamily: 'var(--font-display)',
                fontSize: 13,
                color: 'var(--text-primary)',
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--bg-overlay)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
            >
              Fork session
            </button>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => {
                setMenuOpen(false);
                onNewSession();
              }}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 14px',
                fontFamily: 'var(--font-display)',
                fontSize: 13,
                color: 'var(--text-primary)',
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--bg-overlay)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
            >
              New session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
