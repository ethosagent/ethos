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
        padding: '0 24px',
      }}
    >
      <div
        style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          paddingTop: 8,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          Batch / Eval
        </h3>
        <button
          type="button"
          onClick={() => {
            /* reset state — re-mount tab via key */
            setActiveTab((t) => t);
          }}
          style={{
            height: 28,
            padding: '0 12px',
            borderRadius: 4,
            border: '1px solid var(--border-subtle)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          New run
        </button>
      </div>

      <div
        style={{
          height: 40,
          display: 'flex',
          alignItems: 'flex-end',
          gap: 0,
          flexShrink: 0,
          borderBottom: '1px solid var(--border-subtle)',
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

      <div style={{ flex: 1, overflow: 'auto', paddingTop: 20 }}>
        {activeTab === 'batch' ? <BatchTab /> : <EvalTab />}
      </div>
    </div>
  );
}
