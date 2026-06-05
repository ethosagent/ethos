import { useCallback, useEffect, useRef, useState } from 'react';
import { Chip } from '../ui/Chip';
import { StatusDot } from '../ui/StatusDot';
import type { McpServerInfo } from './McpPage';

interface McpServerRowProps {
  server: McpServerInfo;
  onClick: () => void;
  onReconnect: () => void;
  onRename: (newName: string) => void;
  onDelete: () => void;
}

function getTransportLabel(transport: McpServerInfo['transport']): string {
  if (transport === 'streamable-http') return 'http';
  return transport;
}

function getStatusDisplay(authStatus: McpServerInfo['auth_status']): {
  dotColor: string;
  text: string;
} {
  switch (authStatus) {
    case 'authorized':
    case 'none':
      return { dotColor: 'var(--success)', text: 'Connected' };
    case 'missing':
    case 'pending':
      return { dotColor: 'var(--warning)', text: 'OAuth required' };
    case 'expired':
      return { dotColor: 'var(--error)', text: 'Disconnected' };
    default:
      return { dotColor: 'var(--text-tertiary)', text: 'Starting...' };
  }
}

export function McpServerRow({
  server,
  onClick,
  onReconnect,
  onRename,
  onDelete,
}: McpServerRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(server.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const { dotColor, text: statusText } = getStatusDisplay(server.auth_status);
  const isDisconnected = server.auth_status === 'expired';

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  const commitRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== server.name) {
      onRename(trimmed);
    }
    setRenaming(false);
  }, [renameValue, server.name, onRename]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        commitRename();
      } else if (e.key === 'Escape') {
        setRenameValue(server.name);
        setRenaming(false);
      }
    },
    [commitRename, server.name],
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: custom styled table row
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick();
      }}
      role="button"
      tabIndex={0}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 44,
        borderBottom: '1px solid var(--border-subtle)',
        cursor: 'pointer',
        transition: `background var(--motion-fast) var(--ease)`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-overlay)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {/* NAME */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {renaming ? (
          <input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              color: 'var(--text-primary)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px 6px',
              outline: 'none',
              width: '100%',
              boxSizing: 'border-box',
            }}
          />
        ) : (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'block',
            }}
          >
            {server.name}
          </span>
        )}
      </div>

      {/* TRANSPORT */}
      <div style={{ width: 100 }}>
        <Chip label={getTransportLabel(server.transport)} variant="neutral" />
      </div>

      {/* STATUS */}
      <div style={{ width: 120, display: 'flex', alignItems: 'center', gap: 6 }}>
        <StatusDot color={dotColor} />
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{statusText}</span>
      </div>

      {/* TOOLS */}
      <div style={{ width: 64 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            padding: '2px 6px',
            whiteSpace: 'nowrap',
          }}
        >
          — tools
        </span>
      </div>

      {/* ACTIONS */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stop-propagation wrapper */}
      <div
        style={{ width: 80, display: 'flex', alignItems: 'center', gap: 8 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClick}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--info)',
            fontSize: 12,
            cursor: 'pointer',
            padding: 0,
            whiteSpace: 'nowrap',
          }}
        >
          View tools
        </button>

        {isDisconnected && (
          <button
            type="button"
            onClick={onReconnect}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: 12,
              cursor: 'pointer',
              padding: 0,
              whiteSpace: 'nowrap',
            }}
          >
            Reconnect
          </button>
        )}

        <div style={{ position: 'relative' }} ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: 18,
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            ⋮
          </button>

          {menuOpen && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 4,
                zIndex: 10,
                minWidth: 100,
                overflow: 'hidden',
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setRenameValue(server.name);
                  setRenaming(true);
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  color: 'var(--error)',
                  fontSize: 13,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
