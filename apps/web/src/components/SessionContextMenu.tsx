import { useEffect, useRef } from 'react';
import {
  useSessionDelete,
  useSessionExport,
  useSessionFork,
} from '../features/sessions/api/mutations';
import { rpc } from '../rpc';

interface SessionContextMenuProps {
  sessionId: string;
  position: { x: number; y: number };
  pinned: boolean;
  onClose: () => void;
  onRename: () => void;
}

export function SessionContextMenu({
  sessionId,
  position,
  pinned,
  onClose,
  onRename,
}: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const deleteMut = useSessionDelete();
  const forkMut = useSessionFork();
  const exportMut = useSessionExport();

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
      void rpc.sessions.unpin({ id: sessionId });
    } else {
      void rpc.sessions.pin({ id: sessionId });
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
        {pinned ? '⊘ Unpin' : '★ Pin'}
      </button>
      <button type="button" className="session-context-menu-item" onClick={handleCopyId}>
        ⎘ Copy ID
      </button>
      <button type="button" className="session-context-menu-item" onClick={handleExport}>
        ↓ Export
      </button>
      <button type="button" className="session-context-menu-item" onClick={handleRename}>
        ✎ Rename
      </button>
      <button type="button" className="session-context-menu-item" onClick={handleFork}>
        ⑂ Fork
      </button>
      <button
        type="button"
        className="session-context-menu-item session-context-menu-item--danger"
        onClick={handleDelete}
      >
        ✕ Delete
      </button>
    </div>
  );
}
