import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../state/AppContext';
import { MemoryPanel } from './MemoryPanel';
import { SessionMemoryContext } from './SessionMemoryContext';

type DirtyPanels = Record<string, boolean>;

interface PersonalityOption {
  id: string;
  name: string;
}

const EXPLAINER_KEY = 'hasShownMemoryExplainer';

export function MemoryPage() {
  const { state } = useAppState();
  const { port } = state;

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [personalities, setPersonalities] = useState<PersonalityOption[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState(
    () => localStorage.getItem(EXPLAINER_KEY) !== 'true',
  );
  const [dirtyPanels, setDirtyPanels] = useState<DirtyPanels>({});
  const dirtyPanelsRef = useRef(dirtyPanels);
  dirtyPanelsRef.current = dirtyPanels;

  const handleDirtyChange = useCallback((store: string, isDirty: boolean) => {
    setDirtyPanels((prev) => ({ ...prev, [store]: isDirty }));
  }, []);

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
        if (items.length > 0 && !activeId) {
          setActiveId(res.defaultId ?? items[0].id);
        }
      } catch {
        // best-effort
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [client, activeId]);

  const handleDismissExplainer = useCallback(() => {
    setShowExplainer(false);
    localStorage.setItem(EXPLAINER_KEY, 'true');
  }, []);

  const handlePersonalityChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value;

    // Check for unsaved changes before switching
    const dirtyEntry = Object.entries(dirtyPanelsRef.current).find(([, d]) => d);
    if (dirtyEntry) {
      const panelLabel = dirtyEntry[0] === 'memory' ? 'PROJECT MEMORY' : 'USER PROFILE';
      const confirmed = window.confirm(
        `You have unsaved changes in ${panelLabel}. Discard changes?`,
      );
      if (!confirmed) return;
    }

    setActiveId(newId);
  }, []);

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

  const activeName = personalities.find((p) => p.id === activeId)?.name ?? activeId ?? '';

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: 14,
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-display)',
            }}
          >
            For: {activeName}
          </span>
          <select
            value={activeId ?? ''}
            onChange={handlePersonalityChange}
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 13,
              color: 'var(--text-primary)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 4,
              padding: '4px 8px',
              outline: 'none',
            }}
          >
            {personalities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
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
      {activeId && (
        <div
          style={{
            display: 'flex',
            gap: 24,
            flex: 1,
            minHeight: 0,
          }}
        >
          <MemoryPanel
            label="PROJECT MEMORY"
            store="memory"
            personalityId={activeId}
            emptyText="No project memory yet."
            onDirtyChange={handleDirtyChange}
          />
          <MemoryPanel
            label="USER PROFILE"
            store="user"
            personalityId={activeId}
            emptyText="No user profile yet. Add information about yourself to help the agent personalize responses."
            onDirtyChange={handleDirtyChange}
          />
        </div>
      )}

      {/* Session context */}
      <SessionMemoryContext />
    </div>
  );
}
