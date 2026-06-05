import { personalityAccent } from '@ethosagent/design-tokens';
import { useMemo, useState } from 'react';
import { PersonalityListRow } from './PersonalityListRow';

interface PersonalityListItem {
  id: string;
  name: string;
  description: string | null;
  builtin: boolean;
}

interface PersonalityListProps {
  personalities: PersonalityListItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onWizard?: () => void;
}

export function PersonalityList({
  personalities,
  activeId,
  onSelect,
  onNew,
  onWizard,
}: PersonalityListProps) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return personalities;
    const q = search.toLowerCase();
    return personalities.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q),
    );
  }, [personalities, search]);

  return (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        height: '100%',
        backgroundColor: 'var(--bg-elevated)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 40,
          padding: '0 16px',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
          Personalities
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {onWizard && (
            <button
              type="button"
              onClick={onWizard}
              style={{
                height: 28,
                padding: '0 10px',
                backgroundColor: 'var(--accent)',
                border: 'none',
                borderRadius: 4,
                fontSize: 12,
                color: '#fff',
                cursor: 'pointer',
                fontFamily: 'var(--font-display)',
                fontWeight: 500,
              }}
            >
              Create with AI ✦
            </button>
          )}
          <button
            type="button"
            onClick={onNew}
            style={{
              height: 28,
              padding: '0 10px',
              border: '1px solid rgba(74, 158, 255, 0.3)',
              background: 'rgba(74, 158, 255, 0.1)',
              color: 'var(--accent)',
              borderRadius: 4,
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'var(--font-display)',
              whiteSpace: 'nowrap',
            }}
          >
            + New Personality
          </button>
        </div>
      </div>

      <div style={{ padding: '0 8px 8px', flexShrink: 0 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter personalities..."
          style={{
            width: '100%',
            height: 32,
            backgroundColor: 'var(--bg-overlay)',
            border: 'none',
            borderRadius: 4,
            padding: '0 10px',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-primary)',
            outline: 'none',
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div
            style={{
              padding: '24px 16px',
              fontSize: 13,
              color: 'var(--text-tertiary)',
              textAlign: 'center',
            }}
          >
            {personalities.length === 0
              ? 'No personalities. Click New to create one.'
              : 'No matches.'}
          </div>
        ) : (
          filtered.map((p) => (
            <PersonalityListRow
              key={p.id}
              personality={p}
              active={p.id === activeId}
              accentColor={personalityAccent(p.id)}
              onClick={() => onSelect(p.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
