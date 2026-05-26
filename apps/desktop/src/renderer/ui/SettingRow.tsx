import type { ReactNode } from 'react';

interface SettingRowProps {
  label: string;
  subText?: string;
  children: ReactNode;
}

export function SettingRow({ label, subText, children }: SettingRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: 40,
        padding: '8px 0',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 400,
            color: 'var(--text-primary)',
          }}
        >
          {label}
        </div>
        {subText && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              marginTop: 2,
            }}
          >
            {subText}
          </div>
        )}
      </div>
      <div style={{ marginLeft: 16, flexShrink: 0 }}>{children}</div>
    </div>
  );
}
