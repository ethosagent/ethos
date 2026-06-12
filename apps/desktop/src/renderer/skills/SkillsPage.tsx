import { createEthosClient } from '@ethosagent/sdk';
import { useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../shell/ServerUrl';
import { EvolverQueueTab } from './tabs/EvolverQueueTab';
import { SkillsLibraryTab } from './tabs/SkillsLibraryTab';

type TabId = 'library' | 'evolver';

const tabs: { id: TabId; label: string }[] = [
  { id: 'library', label: 'Skills Library' },
  { id: 'evolver', label: 'Evolver Queue' },
];

export function SkillsPage() {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [activeTab, setActiveTab] = useState<TabId>('library');
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    client.rpc.skills
      .list({})
      .then((res) => {
        if (!cancelled) {
          setPendingCount(res.pendingCount);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 40,
          padding: '0 16px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'none',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                cursor: 'pointer',
                padding: '8px 12px',
                fontSize: 13,
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: isActive ? 500 : 400,
                transition: `color var(--motion-fast) var(--ease)`,
              }}
            >
              {tab.label}
              {tab.id === 'evolver' && pendingCount > 0 && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    backgroundColor: 'var(--warning)',
                    color: 'var(--bg-base)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    fontWeight: 600,
                    lineHeight: 1,
                  }}
                >
                  {pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {activeTab === 'library' && <SkillsLibraryTab />}
        {activeTab === 'evolver' && <EvolverQueueTab onPendingCountChange={setPendingCount} />}
      </div>
    </div>
  );
}
