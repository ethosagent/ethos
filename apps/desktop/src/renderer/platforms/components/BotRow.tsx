import { useCallback, useRef, useState } from 'react';
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
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  const handleMenuAction = useCallback(
    (action: 'edit' | 'remove') => {
      setMenuOpen(false);
      if (action === 'edit') onEdit?.();
      else onRemove?.();
    },
    [onEdit, onRemove],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover state for visual feedback
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setMenuOpen(false);
      }}
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

      <StatusDot color={statusColor[status]} size={6} />

      {hovered && (onEdit || onRemove) && (
        <button
          ref={menuAnchorRef}
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
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

      {menuOpen && (
        <div
          style={{
            position: 'absolute',
            top: 40,
            right: 16,
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            zIndex: 10,
            minWidth: 140,
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
              Edit binding
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
      )}
    </div>
  );
}
