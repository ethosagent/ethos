import { useState } from 'react';
import { BatchTab } from './BatchTab';
import { EvalTab } from './EvalTab';

type Tab = 'batch' | 'eval';

const tabs: { value: Tab; label: string }[] = [
  { value: 'batch', label: 'Batch' },
  { value: 'eval', label: 'Eval' },
];

export function BatchPage() {
  const [activeTab, setActiveTab] = useState<Tab>('batch');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 0,
          flexShrink: 0,
          borderBottom: '1px solid var(--border-subtle)',
          padding: '0 24px',
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setActiveTab(tab.value)}
            style={{
              height: 36,
              padding: '0 16px',
              fontSize: 13,
              fontWeight: activeTab === tab.value ? 600 : 400,
              color: activeTab === tab.value ? 'var(--text-primary)' : 'var(--text-tertiary)',
              background: 'none',
              border: 'none',
              borderBottom:
                activeTab === tab.value ? '2px solid var(--accent)' : '2px solid transparent',
              cursor: 'pointer',
              transition: 'color var(--motion-fast) var(--ease)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Two-panel content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {activeTab === 'batch' ? <BatchTab /> : <EvalTab />}
      </div>
    </div>
  );
}
