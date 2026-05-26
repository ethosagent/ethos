import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

interface ImportPersonalityPickerProps {
  open: boolean;
  personalities: { id: string; name: string }[];
  onImport: (personalityId: string) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}

export function ImportPersonalityPicker({
  open,
  personalities,
  onImport,
  onClose,
  anchorRef,
}: ImportPersonalityPickerProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  const anchor = anchorRef.current;
  const rect = anchor?.getBoundingClientRect();
  const top = rect ? rect.bottom + 4 : 0;
  const left = rect ? rect.left : 0;

  return (
    <div
      ref={popoverRef}
      style={{
        position: 'fixed',
        top,
        left,
        backgroundColor: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-subtle)',
        padding: 12,
        zIndex: 1100,
        minWidth: 180,
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
          marginBottom: 8,
        }}
      >
        Import into
      </div>
      {personalities.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No personalities found.</div>
      )}
      {personalities.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => {
            onImport(p.id);
            onClose();
          }}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '6px 8px',
            fontSize: 13,
            color: 'var(--text-primary)',
            borderRadius: 'var(--radius-sm)',
            transition: `background-color var(--motion-fast) var(--ease)`,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--bg-overlay)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
          }}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}
