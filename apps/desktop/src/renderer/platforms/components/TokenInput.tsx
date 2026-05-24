import { useState } from 'react';

interface TokenInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function TokenInput({ value, onChange, placeholder, disabled }: TokenInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        style={{
          flex: 1,
          height: 36,
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color: 'var(--text-primary)',
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '4px 0 0 4px',
          padding: '0 10px',
          outline: 'none',
          opacity: disabled ? 0.5 : 1,
        }}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        style={{
          height: 36,
          width: 36,
          background: 'none',
          border: '1px solid var(--border-subtle)',
          borderLeft: 'none',
          borderRadius: '0 4px 4px 0',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: 16,
          color: 'var(--text-tertiary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {visible ? '◎' : '◉'}
      </button>
    </div>
  );
}
