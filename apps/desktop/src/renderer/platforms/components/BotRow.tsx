import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { StatusDot } from '../../ui/StatusDot';

interface BotRowProps {
  username: string;
  personalityName: string;
  personalityAccent: string;
  status: 'connected' | 'disconnected' | 'error';
  onEdit?: () => void;
  onRemove?: () => void;
}

const statusColor: Record<BotRowProps['status'], string> = {
  connected: 'var(--success)',
  disconnected: 'var(--text-tertiary)',
  error: 'var(--error)',
};

export function BotRow({
  username,
  personalityName,
  personalityAccent,
  status,
  onEdit,
  onRemove,
}: BotRowProps) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  const handleMenuToggle = useCallback(() => {
    if (menuAnchorRef.current) {
      const rect = menuAnchorRef.current.getBoundingClientRect();
      setMenuPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
    setMenuOpen((v) => !v);
  }, []);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const handleMenuAction = useCallback(
    (action: 'edit' | 'remove') => {
      closeMenu();
      if (action === 'edit') onEdit?.();
      else onRemove?.();
    },
    [closeMenu, onEdit, onRemove],
  );

  // Close menu on scroll so it doesn't drift from its anchor
  useEffect(() => {
    if (!menuOpen) return;
    window.addEventListener('scroll', closeMenu, true);
    return () => window.removeEventListener('scroll', closeMenu, true);
  }, [menuOpen, closeMenu]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover state for visual feedback
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 44,
        padding: '0 16px',
        borderBottom: '1px solid var(--border-subtle)',
        position: 'relative',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color: 'var(--text-primary)',
          flexShrink: 0,
          maxWidth: 140,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {username}
      </span>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginLeft: 12,
          flex: 1,
          minWidth: 0,
        }}
      >
        <StatusDot color={personalityAccent} size={6} />
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {personalityName}
        </span>
      </div>

      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: statusColor[status],
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {status === 'connected' ? '● Connected' : status === 'error' ? '● Error' : '● Disconnected'}
      </span>

      {(hovered || menuOpen) && (onEdit || onRemove) && (
        <button
          ref={menuAnchorRef}
          type="button"
          onClick={handleMenuToggle}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 16,
            color: 'var(--text-tertiary)',
            padding: '0 4px',
            marginLeft: 8,
            lineHeight: 1,
          }}
        >
          {'⋮'}
        </button>
      )}

      {menuOpen &&
        menuPos &&
        createPortal(
          <>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop to dismiss menu */}
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 9999 }}
              onClick={closeMenu}
              onKeyDown={closeMenu}
            />
            <div
              style={{
                position: 'fixed',
                top: menuPos.top,
                right: menuPos.right,
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 4,
                zIndex: 10000,
                minWidth: 140,
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              }}
            >
              {onEdit && (
                <button
                  type="button"
                  onClick={() => handleMenuAction('edit')}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    padding: '8px 12px',
                    fontSize: 13,
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                  }}
                >
                  Edit token
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  onClick={() => handleMenuAction('remove')}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    padding: '8px 12px',
                    fontSize: 13,
                    color: 'var(--error)',
                    cursor: 'pointer',
                  }}
                >
                  Remove bot
                </button>
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
