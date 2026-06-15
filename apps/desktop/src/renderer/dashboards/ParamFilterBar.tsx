import type { ParamDef } from './types';

interface ParamFilterBarProps {
  schema: ParamDef[];
  current: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-tertiary)',
  marginBottom: 4,
};

const controlStyle: React.CSSProperties = {
  height: 28,
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  backgroundColor: 'var(--bg-base)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  color: 'var(--text-primary)',
  padding: '0 8px',
};

export function ParamFilterBar({ schema, current, onChange }: ParamFilterBarProps) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '8px 0' }}>
      {schema.map((def) => {
        if (def.type === 'select') {
          const value = current[def.key] ?? def.default;
          const options = def.options ?? [];
          return (
            <div key={def.key} style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={labelStyle}>{def.label}</span>
              <select
                value={value}
                onChange={(e) => onChange({ ...current, [def.key]: e.target.value })}
                style={controlStyle}
              >
                {options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (def.type === 'options') {
          const value = current[def.key] ?? def.default;
          const options = def.options ?? [];
          return (
            <div key={def.key} style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={labelStyle}>{def.label}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {options.map((opt) => {
                  const active = value === opt;
                  return (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => onChange({ ...current, [def.key]: opt })}
                      style={{
                        height: 28,
                        padding: '0 10px',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        backgroundColor: active ? 'var(--ethos-surface-tint)' : 'var(--bg-base)',
                        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
                        borderRadius: 4,
                        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                        cursor: 'pointer',
                      }}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        }

        const fromKey = `${def.key}_from`;
        const toKey = `${def.key}_to`;
        return (
          <div key={def.key} style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={labelStyle}>{def.label}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="date"
                value={current[fromKey] ?? ''}
                onChange={(e) => onChange({ ...current, [fromKey]: e.target.value })}
                style={controlStyle}
              />
              <input
                type="date"
                value={current[toKey] ?? ''}
                onChange={(e) => onChange({ ...current, [toKey]: e.target.value })}
                style={controlStyle}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
