interface PersonalitySubTabPickerProps {
  activeTab: string;
  tabs: { id: string; label: string }[];
  onTabChange: (id: string) => void;
}

export function PersonalitySubTabPicker({
  activeTab,
  tabs,
  onTabChange,
}: PersonalitySubTabPickerProps) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              cursor: 'pointer',
              padding: '4px 0',
              fontSize: 13,
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: isActive ? 500 : 400,
              transition: `color var(--motion-fast) var(--ease)`,
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
