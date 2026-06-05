import { useState } from 'react';

export type SettingsTab =
  | 'general'
  | 'provider'
  | 'appearance'
  | 'memory'
  | 'retention'
  | 'advanced';

interface SettingsNavProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
}

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'provider', label: 'Provider' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'memory', label: 'Memory' },
  { id: 'retention', label: 'Retention' },
  { id: 'advanced', label: 'Advanced' },
];

export function SettingsNav({ activeTab, onTabChange }: SettingsNavProps) {
  const [hovered, setHovered] = useState<SettingsTab | null>(null);

  return (
    <nav
      style={{
        width: 180,
        minWidth: 180,
        height: '100%',
        position: 'sticky',
        top: 0,
        backgroundColor: 'var(--bg-elevated)',
        borderRight: '1px solid var(--border-subtle)',
        paddingTop: 16,
      }}
    >
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        const isHovered = hovered === tab.id;

        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            onMouseEnter={() => setHovered(tab.id)}
            onMouseLeave={() => setHovered(null)}
            style={{
              display: 'block',
              width: '100%',
              height: 36,
              padding: '0 16px',
              border: 'none',
              borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              backgroundColor: isActive || isHovered ? 'var(--bg-overlay)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 13,
              fontWeight: isActive ? 500 : 400,
              textAlign: 'left',
              cursor: 'pointer',
              transition: `background-color var(--motion-fast) var(--ease), color var(--motion-fast) var(--ease)`,
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
