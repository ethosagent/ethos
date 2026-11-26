import { useEffect, useRef } from 'react';
import {
  useSessionDelete,
  useSessionExport,
  useSessionFork,
  useSessionPin,
  useSessionUnpin,
} from '../features/sessions/api/mutations';

interface SessionContextMenuProps {
  sessionId: string;
  position: { x: number; y: number };
  pinned: boolean;
  onClose: () => void;
  onRename: () => void;
  onShare: () => void;
  /**
   * Whether Share… is offered. Decided by the always-mounted `ScopeNav`, not here:
   * this menu mounts on right-click, so asking `shares.list` here would make the
   * item pop in under the cursor.
   */
  shareEnabled: boolean;
}

export function SessionContextMenu({
  sessionId,
  position,
  pinned,
  onClose,
  onRename,
  onShare,
  shareEnabled,
}: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const deleteMut = useSessionDelete();
  const forkMut = useSessionFork();
  const exportMut = useSessionExport();
  const pinMut = useSessionPin();
  const unpinMut = useSessionUnpin();

  // Close on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handlePin = () => {
    if (pinned) {
      unpinMut.mutate(sessionId);
    } else {
      pinMut.mutate(sessionId);
    }
    onClose();
  };

  const handleCopyId = () => {
    void navigator.clipboard.writeText(sessionId);
    onClose();
  };

  const handleExport = () => {
    exportMut.mutate(sessionId);
    onClose();
  };

  const handleShare = () => {
    onShare();
    onClose();
  };

  const handleRename = () => {
    onRename();
    onClose();
  };

  const handleFork = () => {
    forkMut.mutate(sessionId);
    onClose();
  };

  const handleDelete = () => {
    deleteMut.mutate(sessionId);
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="session-context-menu"
      style={{ top: position.y, left: position.x }}
    >
      <button type="button" className="session-context-menu-item" onClick={handlePin}>
        {pinned ? '⊘ Unpin' : '📌 Pin'}
      </button>
      <button type="button" className="session-context-menu-item" onClick={handleCopyId}>
        ⧉ Copy ID
      </button>
      <button type="button" className="session-context-menu-item" onClick={handleExport}>
        ↓ Export
      </button>
      {shareEnabled ? (
        <button type="button" className="session-context-menu-item" onClick={handleShare}>
          ⇪ Share…
        </button>
      ) : null}
      <button type="button" className="session-context-menu-item" onClick={handleRename}>
        ✎ Rename
      </button>
      <button type="button" className="session-context-menu-item" onClick={handleFork}>
        ⎇ Fork
      </button>
      <button
        type="button"
        className="session-context-menu-item session-context-menu-item--danger"
        onClick={handleDelete}
      >
        🗑 Delete
      </button>
    </div>
  );
}
