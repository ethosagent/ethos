import type { Session } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SessionContextMenu } from '../components/SessionContextMenu';
import { useSessionRename } from '../features/sessions/api/mutations';
import { useSessionList } from '../features/sessions/api/queries';

const SEARCH_DEBOUNCE_MS = 400;

export function Sessions() {
  const navigate = useNavigate();

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    sessionId: string;
    pinned: boolean;
    position: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data, error, isLoading, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useSessionList(debouncedSearch);

  const flat = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  const pinned = useMemo(() => flat.filter((s) => s.pinned), [flat]);
  const unpinned = useMemo(() => flat.filter((s) => !s.pinned), [flat]);

  const renameMut = useSessionRename();

  const handleRenameCommit = useCallback(
    (id: string, value: string) => {
      renameMut.mutate({ id, title: value.trim() || null });
      setEditingId(null);
    },
    [renameMut],
  );

  const openContextMenu = useCallback((e: React.MouseEvent, session: Session) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      sessionId: session.id,
      pinned: session.pinned,
      position: { x: e.clientX, y: e.clientY },
    });
  }, []);

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <span style={{ color: 'var(--red)' }}>
          Failed to load sessions: {(error as Error).message}
        </span>
      </div>
    );
  }

  return (
    <div className="sessions-tab">
      {/* Toolbar */}
      <header className="sessions-toolbar-v2">
        <span className="sessions-toolbar-title">Sessions</span>
        <input
          type="text"
          className="sessions-search-input"
          placeholder="Search sessions…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          aria-label="Search sessions"
        />
        <span className="sessions-count">
          {flat.length} {flat.length === 1 ? 'session' : 'sessions'}
          {hasNextPage ? '+' : ''}
        </span>
        <button type="button" className="btn btn-blue" onClick={() => navigate('/chat')}>
          + New Session
        </button>
      </header>

      {isLoading ? (
        <div className="sessions-loading">{isFetching ? 'Loading…' : ''}</div>
      ) : flat.length === 0 ? (
        <div className="sessions-empty">
          {debouncedSearch
            ? `No sessions match “${debouncedSearch}”.`
            : 'No sessions yet. Start a chat to create one.'}
        </div>
      ) : (
        <>
          {/* Column headers */}
          <div className="sessions-col-headers">
            <span className="sessions-col-hdr sessions-col-name">Name</span>
            <span className="sessions-col-hdr sessions-col-personality">Personality</span>
            <span className="sessions-col-hdr sessions-col-model">Model</span>
            <span className="sessions-col-hdr sessions-col-tokens">Tokens</span>
            <span className="sessions-col-hdr sessions-col-cost">Cost</span>
            <span className="sessions-col-hdr sessions-col-updated">Updated</span>
            <span className="sessions-col-hdr sessions-col-actions"> </span>
          </div>

          {/* Pinned section */}
          {pinned.length > 0 && (
            <div className="sessions-pinned-section">
              {pinned.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  isPinned
                  editingId={editingId}
                  editingValue={editingValue}
                  onSetEditingId={setEditingId}
                  onSetEditingValue={setEditingValue}
                  onRenameCommit={handleRenameCommit}
                  onNavigate={navigate}
                  onContextMenu={openContextMenu}
                />
              ))}
            </div>
          )}

          {/* Regular rows */}
          {unpinned.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              isPinned={false}
              editingId={editingId}
              editingValue={editingValue}
              onSetEditingId={setEditingId}
              onSetEditingValue={setEditingValue}
              onRenameCommit={handleRenameCommit}
              onNavigate={navigate}
              onContextMenu={openContextMenu}
            />
          ))}

          {/* Load more */}
          {hasNextPage && (
            <div className="sessions-loadmore">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      {/* Context menu */}
      {contextMenu && (
        <SessionContextMenu
          sessionId={contextMenu.sessionId}
          position={contextMenu.position}
          pinned={contextMenu.pinned}
          onClose={() => setContextMenu(null)}
          onRename={() => {
            const session = flat.find((s) => s.id === contextMenu.sessionId);
            if (session) {
              setEditingId(session.id);
              setEditingValue(session.title ?? '');
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session row
// ---------------------------------------------------------------------------

interface SessionRowProps {
  session: Session;
  isPinned: boolean;
  editingId: string | null;
  editingValue: string;
  onSetEditingId: (id: string | null) => void;
  onSetEditingValue: (val: string) => void;
  onRenameCommit: (id: string, val: string) => void;
  onNavigate: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, session: Session) => void;
}

function SessionRow({
  session,
  isPinned,
  editingId,
  editingValue,
  onSetEditingId,
  onSetEditingValue,
  onRenameCommit,
  onNavigate,
  onContextMenu,
}: SessionRowProps) {
  const isEditing = editingId === session.id;
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && renameRef.current) {
      renameRef.current.focus();
    }
  }, [isEditing]);

  const handleRowClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.sessions-actions-trigger') || target.closest('.session-context-menu')) {
      return;
    }
    if (isEditing) return;
    onNavigate(`/chat?session=${session.id}`);
  };

  const label = session.title ?? `${session.id.slice(0, 8)}…`;

  return (
    <button
      type="button"
      className={`sessions-row${isPinned ? ' sessions-row--pinned' : ''}`}
      onClick={handleRowClick}
    >
      {/* Name */}
      <span className="sessions-cell sessions-col-name">
        {isPinned && (
          <span className="sessions-pin-icon" title="Pinned">
            &#9733;
          </span>
        )}
        {isEditing ? (
          <input
            ref={renameRef}
            type="text"
            className="sessions-rename-input"
            value={editingValue}
            onChange={(e) => onSetEditingValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRenameCommit(session.id, editingValue);
              }
              if (e.key === 'Escape') {
                onSetEditingId(null);
              }
            }}
            onBlur={() => onRenameCommit(session.id, editingValue)}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="sessions-row-name" title={session.title ?? undefined}>
            {label}
          </span>
        )}
      </span>

      {/* Personality */}
      <span className="sessions-cell sessions-col-personality sessions-mono">
        {session.personalityId ?? '—'}
      </span>

      {/* Model */}
      <span className="sessions-cell sessions-col-model sessions-mono sessions-tertiary">
        {session.model}
      </span>

      {/* Tokens */}
      <span className="sessions-cell sessions-col-tokens sessions-mono sessions-tertiary">
        {formatTokens(session.usage.inputTokens + session.usage.outputTokens)}
      </span>

      {/* Cost */}
      <span className="sessions-cell sessions-col-cost sessions-mono sessions-tertiary">
        {formatCost(session.usage.estimatedCostUsd)}
      </span>

      {/* Updated */}
      <span className="sessions-cell sessions-col-updated sessions-mono sessions-tertiary">
        {formatRelative(session.updatedAt)}
      </span>

      {/* Actions */}
      <span className="sessions-cell sessions-col-actions">
        <button
          type="button"
          className="sessions-actions-trigger"
          aria-label={`Actions for ${session.title ?? session.id.slice(0, 8)}`}
          onClick={(e) => onContextMenu(e, session)}
        >
          &#x22EF;
        </button>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n === 0) return '—';
  return n.toLocaleString('en-US');
}

function formatCost(usd: number): string {
  if (usd === 0) return '—';
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(3)}`;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
