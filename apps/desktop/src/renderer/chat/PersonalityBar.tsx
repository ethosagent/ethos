import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PersonalityRingAvatar } from '../ui/PersonalityRingAvatar';

interface PersonalityBarProps {
  personalityId: string | null;
  port: number;
  onSwitchPersonality: (id: string | null) => void;
  sessionTitle: string | null;
  onTitleChange: (title: string) => void;
  onNewSession: () => void;
  onForkSession: () => void;
  streaming: boolean;
  currentOp?: string | null;
  showSessionsButton?: boolean;
  onToggleSessions?: () => void;
}

export function PersonalityBar({
  personalityId,
  port,
  onSwitchPersonality,
  sessionTitle,
  onTitleChange,
  onNewSession,
  onForkSession,
  streaming,
  currentOp,
  showSessionsButton,
  onToggleSessions,
}: PersonalityBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [personalities, setPersonalities] = useState<Array<{ id: string; name: string }>>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  useEffect(() => {
    client.rpc.personalities
      .list({})
      .then((res: { items: Array<{ id: string; name: string }> }) => setPersonalities(res.items))
      .catch(() => {});
  }, [client]);

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

  useEffect(() => {
    if (!pickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [pickerOpen]);

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

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 4px',
            borderRadius: 'var(--radius-sm)',
            flexShrink: 0,
          }}
          aria-label="Switch personality"
        >
          <PersonalityRingAvatar personalityId={personalityId ?? 'researcher'} size={28} />
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 14,
              fontWeight: 500,
              color: 'var(--text-primary)',
            }}
          >
            {personalities.find((p) => p.id === personalityId)?.name ?? personalityId ?? 'Default'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>▾</span>
        </button>

        {pickerOpen && (
          <div
            ref={pickerRef}
            style={{
              position: 'absolute',
              top: 36,
              left: 0,
              zIndex: 30,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
              minWidth: 180,
              maxHeight: 240,
              overflowY: 'auto',
            }}
          >
            {personalities.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onSwitchPersonality(p.id);
                  setPickerOpen(false);
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '7px 14px',
                  fontFamily: 'var(--font-display)',
                  fontSize: 13,
                  color: p.id === personalityId ? 'var(--accent)' : 'var(--text-primary)',
                  cursor: 'pointer',
                  background: 'transparent',
                  border: 'none',
                  textAlign: 'left',
                  fontWeight: p.id === personalityId ? 500 : 400,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'var(--bg-overlay)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'transparent';
                }}
              >
                {p.name}
              </button>
            ))}
            {personalities.length === 0 && (
              <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--text-tertiary)' }}>
                No personalities
              </div>
            )}
          </div>
        )}
      </div>

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

      {currentOp && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 8px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--bg-overlay)',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-secondary)',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          <svg
            aria-hidden="true"
            width={11}
            height={11}
            viewBox="0 0 11 11"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.3}
            strokeLinecap="round"
          >
            <circle cx="5.5" cy="5.5" r="1.5" />
            <path d="M5.5 1v1.2M5.5 8.8V10M1 5.5h1.2M8.8 5.5H10M2.2 2.2l.85.85M7.95 7.95l.85.85M2.2 8.8l.85-.85M7.95 3.05l.85-.85" />
          </svg>
          {currentOp}
        </div>
      )}

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
