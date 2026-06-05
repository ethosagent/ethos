import type { Session } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SessionContextAction =
  | 'pin'
  | 'unpin'
  | 'copy-id'
  | 'export'
  | 'rename'
  | 'fork'
  | 'delete';

interface SessionContextMenuProps {
  x: number;
  y: number;
  session: Session;
  onAction: (action: SessionContextAction, session: Session) => void;
  onClose: () => void;
}

interface MenuItem {
  label: string;
  action: SessionContextAction;
  danger?: boolean;
}

export function SessionContextMenu({ x, y, session, onAction, onClose }: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const items: MenuItem[] = [
    { label: session.pinned ? 'Unpin' : 'Pin', action: session.pinned ? 'unpin' : 'pin' },
    { label: 'Copy ID', action: 'copy-id' },
    { label: 'Export', action: 'export' },
    { label: 'Rename', action: 'rename' },
    { label: 'Fork', action: 'fork' },
    { label: 'Delete', action: 'delete', danger: true },
  ];

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Adjust position to stay within viewport
  const adjustedX = Math.min(x, window.innerWidth - 160);
  const adjustedY = Math.min(y, window.innerHeight - items.length * 32 - 8);

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        top: adjustedY,
        left: adjustedX,
        zIndex: 50,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        borderRadius: 6,
        boxShadow: '0 4px 16px var(--ethos-shadow-overlay)',
        overflow: 'hidden',
        minWidth: 140,
      }}
    >
      {items.map((item, idx) => (
        <button
          key={item.action}
          type="button"
          tabIndex={-1}
          onClick={() => {
            onAction(item.action, session);
            onClose();
          }}
          onMouseEnter={() => setHoveredIdx(idx)}
          onMouseLeave={() => setHoveredIdx(null)}
          style={{
            display: 'block',
            width: '100%',
            padding: '6px 14px',
            fontFamily: 'var(--font-display)',
            fontSize: 13,
            color: item.danger ? 'var(--error)' : 'var(--text-primary)',
            cursor: 'pointer',
            background: hoveredIdx === idx ? 'var(--bg-overlay)' : 'transparent',
            border: 'none',
            textAlign: 'left',
            transition: `background-color var(--motion-fast) var(--ease)`,
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
