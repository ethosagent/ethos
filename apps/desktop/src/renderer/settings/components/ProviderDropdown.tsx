interface ProviderDropdownProps {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  width?: number;
  mono?: boolean;
}

export function ProviderDropdown({
  value,
  options,
  onChange,
  width = 200,
  mono = false,
}: ProviderDropdownProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width,
        height: 32,
        padding: '0 8px',
        borderRadius: 4,
        border: '1px solid var(--border-subtle)',
        backgroundColor: 'var(--bg-elevated)',
        color: 'var(--text-primary)',
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-display)',
        fontSize: mono ? 12 : 14,
        cursor: 'pointer',
        outline: 'none',
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
