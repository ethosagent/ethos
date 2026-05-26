import type { Session } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

interface SessionRowProps {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onFork: () => void;
  onExport: () => void;
  onDelete: () => void;
  onPin: () => void;
  onUnpin: () => void;
}

function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'now';
    if (diffMin < 60) return `${diffMin}m`;
    if (diffHr < 24) return `${diffHr}h`;
    if (diffDay < 2) return 'Yesterday';

    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export function SessionRow({
  session,
  active,
  onSelect,
  onRename,
  onFork,
  onExport,
  onDelete,
  onPin,
  onUnpin,
}: SessionRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [hovered, setHovered] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const title = session.title ?? 'Untitled';
  const timeStr = formatRelativeTime(session.updatedAt);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!renaming) setMenuOpen(true);
    },
    [renaming],
  );

  const handleRenameStart = useCallback(() => {
    setMenuOpen(false);
    setRenameValue(title);
    setRenaming(true);
  }, [title]);

  const handleRenameCommit = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== title) {
      onRename(trimmed);
    }
    setRenaming(false);
  }, [renameValue, title, onRename]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleRenameCommit();
      } else if (e.key === 'Escape') {
        setRenaming(false);
      }
    },
    [handleRenameCommit],
  );

  const handleFork = useCallback(() => {
    setMenuOpen(false);
    onFork();
  }, [onFork]);

  const handleDeleteConfirm = useCallback(() => {
    setMenuOpen(false);
    onDelete();
  }, [onDelete]);

  const handleExport = useCallback(() => {
    setMenuOpen(false);
    onExport();
  }, [onExport]);

  // Focus input when renaming
  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

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
    // biome-ignore lint/a11y/noStaticElementInteractions: hover state for visual feedback on container
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => e.key === 'Enter' && onSelect()}
        onContextMenu={handleContextMenu}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 36,
          padding: '0 10px',
          cursor: 'pointer',
          background: active
            ? 'rgba(74, 158, 255, 0.12)'
            : hovered
              ? 'var(--ethos-hover)'
              : 'transparent',
          border: 'none',
          borderLeft: active ? '2px solid var(--info)' : '2px solid transparent',
          width: '100%',
          textAlign: 'left',
          font: 'inherit',
        }}
      >
        {renaming ? (
          <input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameCommit}
            style={{
              flex: 1,
              fontFamily: 'var(--font-display)',
              fontSize: 13,
              color: 'var(--text-primary)',
              background: 'var(--bg-overlay)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px 6px',
              outline: 'none',
              minWidth: 0,
            }}
          />
        ) : (
          <>
            {session.pinned && (
              <span style={{ fontSize: 10, color: 'var(--accent)', marginRight: 4, flexShrink: 0 }}>
                ★
              </span>
            )}
            <span
              style={{
                flex: 1,
                fontFamily: 'var(--font-display)',
                fontSize: 13,
                fontWeight: 400,
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 160,
                minWidth: 0,
              }}
            >
              {title}
            </span>
          </>
        )}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
            fontVariantNumeric: 'tabular-nums',
            marginLeft: 8,
            flexShrink: 0,
          }}
        >
          {timeStr}
        </span>
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          style={{
            position: 'absolute',
            top: 32,
            right: 8,
            zIndex: 20,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
            minWidth: 120,
          }}
        >
          {[
            {
              label: session.pinned ? 'Unpin' : 'Pin',
              action: () => {
                setMenuOpen(false);
                if (session.pinned) onUnpin();
                else onPin();
              },
            },
            { label: 'Rename', action: handleRenameStart },
            { label: 'Fork', action: handleFork },
            { label: 'Export', action: handleExport },
            { label: 'Delete', action: handleDeleteConfirm },
          ].map((item) => (
            <button
              type="button"
              key={item.label}
              tabIndex={-1}
              onClick={item.action}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 14px',
                fontFamily: 'var(--font-display)',
                fontSize: 13,
                color: item.label === 'Delete' ? 'var(--error)' : 'var(--text-primary)',
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
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
