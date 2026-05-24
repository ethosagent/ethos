interface ModelTierRowProps {
  tier: string;
  description: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function ModelTierRow({
  tier,
  description,
  value,
  options,
  onChange,
  disabled = false,
}: ModelTierRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 44,
        borderBottom: '1px solid var(--border-subtle)',
        padding: '0 16px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>{tier}</span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{description}</span>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          width: 200,
          height: 28,
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: disabled ? 'var(--text-tertiary)' : 'var(--text-primary)',
          padding: '0 8px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <option value="">—</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}
