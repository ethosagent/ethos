import { createEthosClient } from '@ethosagent/sdk';
import type { Session } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandItem {
  id: string;
  group: 'Pages' | 'Sessions' | 'Actions';
  label: string;
  hint?: string;
  keywords?: string[];
  disabled?: boolean;
  run: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function matchesQuery(item: CommandItem, query: string): boolean {
  if (!query.trim()) return true;
  const tokens = query.trim().toLowerCase().split(/\s+/);
  const haystack = [item.label, item.hint ?? '', ...(item.keywords ?? [])].join(' ').toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CommandPaletteProps {
  open: boolean;
  port: number;
  onClose: () => void;
  onNavigate: (route: string) => void;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onToggleDrawer: () => void;
}

// ---------------------------------------------------------------------------
// Static page list (not computed each render)
// ---------------------------------------------------------------------------

const PAGE_DEFS: Array<{ id: string; label: string; hint: string; keywords: string[] }> = [
  { id: 'chat', label: 'Chat', hint: 'chat', keywords: ['message', 'talk'] },
  {
    id: 'personalities',
    label: 'Personalities',
    hint: 'personalities',
    keywords: ['agent', 'identity'],
  },
  { id: 'memory', label: 'Memory', hint: 'memory', keywords: ['notes', 'context'] },
  { id: 'cron', label: 'Cron', hint: 'cron', keywords: ['schedule', 'job'] },
  { id: 'platforms', label: 'Platforms', hint: 'platforms', keywords: ['telegram', 'discord'] },
  { id: 'skills', label: 'Skills', hint: 'skills', keywords: ['tools', 'evolver'] },
  { id: 'mcp', label: 'MCP', hint: 'mcp', keywords: ['model', 'protocol'] },
  { id: 'activity', label: 'Activity', hint: 'activity', keywords: ['stream', 'events'] },
  { id: 'settings', label: 'Settings', hint: 'settings', keywords: ['config', 'key'] },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommandPalette({
  open,
  port,
  onClose,
  onNavigate,
  onSelectSession,
  onNewChat,
  onToggleDrawer,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [sessions, setSessions] = useState<Session[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
    }
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Fetch sessions when opened
  useEffect(() => {
    if (!open) return;
    const client = createEthosClient({
      baseUrl: `http://localhost:${port}`,
      fetch: globalThis.fetch,
    });
    client.rpc.sessions
      .list({ limit: 8 })
      .then((res) => setSessions(res.items))
      .catch(() => {
        // best-effort — sessions section stays empty
      });
  }, [open, port]);

  // Stable helper: close the palette then run an action.
  const closeAfter = useCallback(
    (fn: () => void) => () => {
      fn();
      onClose();
    },
    [onClose],
  );

  const pageItems = useMemo<CommandItem[]>(
    () =>
      PAGE_DEFS.map((p) => ({
        id: `page:${p.id}`,
        group: 'Pages' as const,
        label: p.label,
        hint: p.hint,
        keywords: p.keywords,
        run: closeAfter(() => onNavigate(p.id)),
      })),
    [closeAfter, onNavigate],
  );

  const sessionItems = useMemo<CommandItem[]>(
    () =>
      sessions.map((s) => ({
        id: `session:${s.id}`,
        group: 'Sessions' as const,
        label: s.title || s.id.slice(0, 12),
        hint: relativeTime(s.updatedAt),
        run: closeAfter(() => {
          onNavigate('chat');
          onSelectSession(s.id);
        }),
      })),
    [closeAfter, sessions, onNavigate, onSelectSession],
  );

  const actionItems = useMemo<CommandItem[]>(
    () => [
      {
        id: 'action:new-chat',
        group: 'Actions' as const,
        label: 'New chat session',
        hint: '⏎',
        run: closeAfter(onNewChat),
      },
      {
        id: 'action:toggle-drawer',
        group: 'Actions' as const,
        label: 'Toggle activity drawer',
        hint: '⌘.',
        run: closeAfter(onToggleDrawer),
      },
    ],
    [closeAfter, onNewChat, onToggleDrawer],
  );

  const allItems = useMemo(
    () => [...pageItems, ...sessionItems, ...actionItems],
    [pageItems, sessionItems, actionItems],
  );

  const filtered = useMemo(
    () => allItems.filter((item) => matchesQuery(item, query)),
    [allItems, query],
  );

  // Clamp selection when filter changes
  useEffect(() => {
    setSelectedIdx((prev) => Math.min(prev, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = filtered[selectedIdx];
      if (item && !item.disabled) item.run();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  // Group filtered items preserving group order
  const groupOrder: CommandItem['group'][] = ['Pages', 'Sessions', 'Actions'];
  const groups: Array<{ label: string; items: Array<{ item: CommandItem; flatIdx: number }> }> = [];

  for (const groupLabel of groupOrder) {
    const groupItems = filtered
      .map((item, i) => ({ item, flatIdx: i }))
      .filter(({ item }) => item.group === groupLabel);
    if (groupItems.length > 0) {
      groups.push({ label: groupLabel, items: groupItems });
    }
  }

  const groupHeaderStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
    padding: '8px 12px 2px',
    fontFamily: 'var(--font-display)',
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss-on-click is a standard modal pattern; keyboard handling lives on the inner role="dialog"
    // biome-ignore lint/a11y/useKeyWithClickEvents: same — inner dialog panel owns keyboard nav
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: 96,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Dialog panel owns keyboard handling */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={{
          width: 560,
          background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden',
          maxHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
        }}
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command or search…"
          style={{
            width: '100%',
            padding: '14px 16px',
            fontFamily: 'var(--font-display)',
            fontSize: 15,
            color: 'var(--text-primary)',
            background: 'transparent',
            border: 'none',
            borderBottom: '1px solid var(--border-subtle)',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {filtered.length === 0 ? (
            <div
              style={{
                padding: '16px',
                fontSize: 13,
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-display)',
              }}
            >
              No results for "{query}"
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <div style={groupHeaderStyle}>{group.label}</div>
                {group.items.map(({ item, flatIdx: fi }) => (
                  <button
                    key={item.id}
                    type="button"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 12px',
                      width: '100%',
                      background: fi === selectedIdx ? 'var(--bg-overlay)' : 'transparent',
                      border: 'none',
                      textAlign: 'left',
                      cursor: item.disabled ? 'default' : 'pointer',
                      opacity: item.disabled ? 0.4 : 1,
                    }}
                    onClick={() => {
                      if (!item.disabled) item.run();
                    }}
                    onMouseEnter={() => setSelectedIdx(fi)}
                  >
                    <span
                      style={{
                        flex: 1,
                        fontFamily: 'var(--font-display)',
                        fontSize: 13,
                        color: 'var(--text-primary)',
                      }}
                    >
                      {item.label}
                    </span>
                    {item.hint && (
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          color: 'var(--text-tertiary)',
                          flexShrink: 0,
                        }}
                      >
                        {item.hint}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
