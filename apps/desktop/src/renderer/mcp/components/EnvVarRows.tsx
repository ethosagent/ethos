import { useState } from 'react';

interface EnvVarRowsProps {
  vars: Array<{ key: string; value: string }>;
  onChange: (vars: Array<{ key: string; value: string }>) => void;
}

export function EnvVarRows({ vars, onChange }: EnvVarRowsProps) {
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          fontSize: 12,
          color: 'var(--info)',
          textAlign: 'left',
        }}
      >
        Add env vars &rarr;
      </button>
    );
  }

  const update = (index: number, field: 'key' | 'value', val: string) => {
    const next = vars.map((v, i) => (i === index ? { ...v, [field]: val } : v));
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(vars.filter((_, i) => i !== index));
  };

  const add = () => {
    onChange([...vars, { key: '', value: '' }]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {vars.map((v, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: env var rows have no stable identity
        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            type="text"
            value={v.key}
            onChange={(e) => update(i, 'key', e.target.value)}
            placeholder="KEY"
            style={{
              flex: 1,
              height: 30,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              padding: '0 8px',
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 4,
              color: 'var(--text-primary)',
              outline: 'none',
            }}
          />
          <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>=</span>
          <input
            type="text"
            value={v.value}
            onChange={(e) => update(i, 'value', e.target.value)}
            placeholder="value"
            style={{
              flex: 1,
              height: 30,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              padding: '0 8px',
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 4,
              color: 'var(--text-primary)',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={() => remove(i)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 14,
              color: 'var(--text-tertiary)',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            &times;
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 12,
          color: 'var(--info)',
          textAlign: 'left',
          padding: 0,
        }}
      >
        + Add variable
      </button>
    </div>
  );
}
