import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';

interface DrawerShellProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  headerRight?: ReactNode;
}

export function DrawerShell({
  open,
  title,
  onClose,
  children,
  footer,
  headerRight,
}: DrawerShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const el = panelRef.current;
    if (el) {
      el.style.transform = 'translateX(360px)';
      requestAnimationFrame(() => {
        el.style.transform = 'translateX(0)';
      });
    }
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: overlay backdrop close */}
      <div
        role="button"
        tabIndex={-1}
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClose();
          }
        }}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.3)',
          zIndex: 999,
        }}
      />
      <div
        ref={panelRef}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 360,
          backgroundColor: 'var(--bg-elevated)',
          borderLeft: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 1000,
          transform: 'translateX(360px)',
          transition: 'transform 240ms var(--ease)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 40,
            padding: '0 16px',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: 'var(--text-primary)',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </span>
          {headerRight}
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 18,
              color: 'var(--text-tertiary)',
              padding: 0,
              marginLeft: 8,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: 16,
          }}
        >
          {children}
        </div>

        {footer && (
          <div
            style={{
              height: 40,
              padding: '0 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              borderTop: '1px solid var(--border-subtle)',
              flexShrink: 0,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </>
  );
}
