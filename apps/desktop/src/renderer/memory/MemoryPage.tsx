import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useServerUrl } from '../shell/ServerUrl';
import { useAppState } from '../state/AppContext';
import { MemoryPanel } from './MemoryPanel';
import { SessionMemoryContext } from './SessionMemoryContext';

type DirtyPanels = Record<string, boolean>;

interface PersonalityOption {
  id: string;
  name: string;
}

interface UserOption {
  userId: string;
  platform: string;
  displayLabel: string;
}

const EXPLAINER_KEY = 'hasShownMemoryExplainer';

function formatUserLabel(u: UserOption): string {
  if (u.platform === 'desktop') return 'Desktop';
  const parts = u.displayLabel.split(':');
  const platform = parts[0] ?? u.platform;
  const id = parts.slice(1).join(':') || u.userId;
  return `${platform.charAt(0).toUpperCase() + platform.slice(1)} · ${id}`;
}

export function MemoryPage() {
  const { state } = useAppState();
  const { desktopUserId } = state;

  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [personalities, setPersonalities] = useState<PersonalityOption[]>([]);
  const [activePersonalityId, setActivePersonalityId] = useState<string | null>(null);

  const [users, setUsers] = useState<UserOption[]>([]);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);

  const [showExplainer, setShowExplainer] = useState(
    () => localStorage.getItem(EXPLAINER_KEY) !== 'true',
  );
  const [dirtyPanels, setDirtyPanels] = useState<DirtyPanels>({});
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
        // Default to desktop user if available, otherwise first
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

  const handleDismissExplainer = useCallback(() => {
    setShowExplainer(false);
    localStorage.setItem(EXPLAINER_KEY, 'true');
  }, []);

  const confirmIfDirty = useCallback((panelKey: string): boolean => {
    if (!dirtyPanelsRef.current[panelKey]) return true;
    const label = panelKey === 'memory' ? 'PROJECT MEMORY' : 'USER PROFILE';
    return window.confirm(`You have unsaved changes in ${label}. Discard changes?`);
  }, []);

  const handlePersonalityChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!confirmIfDirty('memory')) return;
      setActivePersonalityId(e.target.value);
    },
    [confirmIfDirty],
  );

  const handleUserChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!confirmIfDirty('user')) return;
      setActiveUserId(e.target.value);
    },
    [confirmIfDirty],
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

  // Use the first available personality for user-panel reads (personalityId is required
  // by the RPC but ignored for routing when userId is set — service uses user scope).
  const fallbackPersonalityId = activePersonalityId ?? personalities[0]?.id ?? 'operator';

  const selectStyle: React.CSSProperties = {
    fontFamily: 'var(--font-display)',
    fontSize: 13,
    color: 'var(--text-primary)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 4,
    padding: '4px 8px',
    outline: 'none',
  };

  // desktopUserId is available in state but user selection is managed locally;
  // we reference it only to satisfy the linter (it's set in AppShell on boot).
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
          height: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          marginBottom: 16,
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
          Memory
        </h3>
      </div>

      {/* Explainer */}
      {showExplainer && (
        <div
          style={{
            background: 'var(--bg-elevated)',
            borderRadius: 8,
            padding: '12px 16px',
            border: '1px solid var(--border-subtle)',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 13,
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-display)',
            }}
          >
            Your agent reads these files at the start of every conversation. Edit them to correct or
            add information.
          </span>
          <button
            type="button"
            onClick={handleDismissExplainer}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--info)',
              fontSize: 12,
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'var(--font-display)',
              flexShrink: 0,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Panels row */}
      <div style={{ display: 'flex', gap: 24, flex: 1, minHeight: 0 }}>
        {/* Left: Project Memory — scoped by personality */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-display)',
              }}
            >
              Personality
            </span>
            <select
              value={activePersonalityId ?? ''}
              onChange={handlePersonalityChange}
              style={selectStyle}
            >
              {personalities.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {activePersonalityId && (
            <MemoryPanel
              label="PROJECT MEMORY"
              store="memory"
              personalityId={activePersonalityId}
              emptyText="No project memory yet."
              onDirtyChange={handleDirtyChange}
            />
          )}
        </div>

        {/* Right: User Profile — scoped by user */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-display)',
              }}
            >
              User
            </span>
            <select value={activeUserId ?? ''} onChange={handleUserChange} style={selectStyle}>
              {users.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {formatUserLabel(u)}
                </option>
              ))}
            </select>
          </div>
          {activeUserId && (
            <MemoryPanel
              label="USER PROFILE"
              store="user"
              personalityId={fallbackPersonalityId}
              userId={activeUserId}
              emptyText="No user profile yet. Add information about this user to help the agent personalize responses."
              onDirtyChange={handleDirtyChange}
            />
          )}
        </div>
      </div>

      {/* Session context */}
      <SessionMemoryContext />
    </div>
  );
}
