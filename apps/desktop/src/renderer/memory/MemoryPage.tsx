import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../state/AppContext';
import { MemoryPanel } from './MemoryPanel';

type FileKey = 'memory' | 'user';

interface PersonalityOption {
  id: string;
  name: string;
}

interface UserOption {
  userId: string;
  platform: string;
  displayLabel: string;
}

function formatUserLabel(u: UserOption): string {
  if (u.platform === 'desktop') return 'Desktop';
  const parts = u.displayLabel.split(':');
  const platform = parts[0] ?? u.platform;
  const id = parts.slice(1).join(':') || u.userId;
  return `${platform.charAt(0).toUpperCase() + platform.slice(1)} · ${id}`;
}

export function MemoryPage() {
  const { state } = useAppState();
  const { port, desktopUserId } = state;

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [selectedFile, setSelectedFile] = useState<FileKey>('memory');
  const [personalities, setPersonalities] = useState<PersonalityOption[]>([]);
  const [activePersonalityId, setActivePersonalityId] = useState<string | null>(null);

  const [users, setUsers] = useState<UserOption[]>([]);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);

  const [dirtyPanels, setDirtyPanels] = useState<Record<string, boolean>>({});
  const dirtyPanelsRef = useRef(dirtyPanels);
  dirtyPanelsRef.current = dirtyPanels;

  const handleDirtyChange = useCallback((store: string, isDirty: boolean) => {
    setDirtyPanels((prev) => ({ ...prev, [store]: isDirty }));
  }, []);

  // Load personalities
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await client.rpc.personalities.list({});
        if (cancelled) return;
        const items = res.items.map((p: { id: string; name: string }) => ({
          id: p.id,
          name: p.name,
        }));
        setPersonalities(items);
        if (items.length > 0 && !activePersonalityId) {
          setActivePersonalityId(res.defaultId ?? items[0].id);
        }
      } catch {
        // best-effort
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [client, activePersonalityId]);

  // Load users
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await client.rpc.memory.listUsers({});
        if (cancelled) return;
        const items: UserOption[] = (
          res.users as Array<{ userId: string; platform: string; displayLabel: string }>
        )
          .map((u) => ({ userId: u.userId, platform: u.platform, displayLabel: u.displayLabel }))
          .sort((a, b) => {
            if (a.platform === 'desktop') return -1;
            if (b.platform === 'desktop') return 1;
            return a.displayLabel.localeCompare(b.displayLabel);
          });
        setUsers(items);
        if (!activeUserId) {
          const desktop = items.find((u) => u.platform === 'desktop');
          setActiveUserId(desktop?.userId ?? items[0]?.userId ?? null);
        }
      } catch {
        // best-effort
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [client, activeUserId]);

  const confirmIfDirty = useCallback((panelKey: string): boolean => {
    if (!dirtyPanelsRef.current[panelKey]) return true;
    const label = panelKey === 'memory' ? 'MEMORY.md' : 'USER.md';
    return window.confirm(`You have unsaved changes in ${label}. Discard changes?`);
  }, []);

  const handlePersonalityChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!confirmIfDirty(selectedFile)) return;
      setActivePersonalityId(e.target.value);
    },
    [confirmIfDirty, selectedFile],
  );

  const handleUserChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!confirmIfDirty('user')) return;
      setActiveUserId(e.target.value);
    },
    [confirmIfDirty],
  );

  const handleFileSelect = useCallback(
    (file: FileKey) => {
      if (file === selectedFile) return;
      if (!confirmIfDirty(selectedFile)) return;
      setSelectedFile(file);
    },
    [selectedFile, confirmIfDirty],
  );

  // Guard against navigation away with unsaved changes
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (Object.values(dirtyPanelsRef.current).some(Boolean)) {
        e.preventDefault();
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  const fallbackPersonalityId = activePersonalityId ?? personalities[0]?.id ?? 'operator';

  const selectStyle: React.CSSProperties = {
    fontFamily: 'var(--font-display)',
    fontSize: 13,
    color: 'var(--text-primary)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    padding: '4px 8px',
    outline: 'none',
  };

  // desktopUserId is available in state but user selection is managed locally
  void desktopUserId;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: '24px 32px',
        boxSizing: 'border-box',
      }}
    >
      {/* Page header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          marginBottom: 12,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-display)',
          }}
        >
          Brain
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            value={activePersonalityId ?? ''}
            onChange={handlePersonalityChange}
            style={{ ...selectStyle, width: 180 }}
          >
            {personalities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {selectedFile === 'user' ? (
            <select
              value={activeUserId ?? ''}
              onChange={handleUserChange}
              style={{ ...selectStyle, width: 140 }}
            >
              {users.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {formatUserLabel(u)}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>

      {/* Two-panel layout */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Left panel — file list */}
        <div
          style={{
            width: 220,
            flexShrink: 0,
            borderRight: '1px solid var(--border-subtle)',
            background: 'var(--bg-base)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--text-tertiary)',
              padding: '12px 12px 6px',
            }}
          >
            Files
          </div>
          <FileListItem
            label="MEMORY.md"
            active={selectedFile === 'memory'}
            onClick={() => handleFileSelect('memory')}
          />
          <FileListItem
            label="USER.md"
            active={selectedFile === 'user'}
            onClick={() => handleFileSelect('user')}
          />
        </div>

        {/* Right panel — editor */}
        <div
          style={{
            flex: 1,
            padding: '20px 24px',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-base)',
            minWidth: 0,
          }}
        >
          {selectedFile === 'memory' && activePersonalityId ? (
            <MemoryPanel
              label="MEMORY.md"
              store="memory"
              personalityId={activePersonalityId}
              emptyText="No project memory yet."
              onDirtyChange={handleDirtyChange}
            />
          ) : null}
          {selectedFile === 'user' && activeUserId ? (
            <MemoryPanel
              label="USER.md"
              store="user"
              personalityId={fallbackPersonalityId}
              userId={activeUserId}
              emptyText="No user profile yet."
              onDirtyChange={handleDirtyChange}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FileListItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        height: 32,
        padding: '0 12px',
        border: 'none',
        borderLeft: active ? '2px solid var(--blue)' : '2px solid transparent',
        background: active
          ? 'rgba(74,158,255,0.10)'
          : hovered
            ? 'var(--ethos-hover)'
            : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontFamily: 'var(--font-display)',
        fontSize: 13,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      {label}
    </button>
  );
}
